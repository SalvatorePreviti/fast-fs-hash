/**
 * Core hashing engine — C++ implementation.
 *
 * Uses xxHash (XXH3-128) for blazing fast content hashing with automatic
 * SIMD acceleration (SSE2 on x86, NEON on ARM).
 *
 * Thread pool uses a lock-free work-stealing pattern via std::atomic
 * for minimal overhead.
 *
 * All output is raw 128-bit (16-byte) digests in big-endian canonical
 * form — no hex encoding — for minimal overhead and fast comparison.
 *
 * File paths are NOT included in any hash — only raw file content.
 * Unreadable files produce all-zero 16-byte hashes.
 *
 * UTF-8 handling:
 *   - macOS/Linux: fopen() accepts UTF-8 natively.
 *   - Windows: UTF-8 → wchar_t conversion via MultiByteToWideChar,
 *     then _wfopen() for full Unicode path support.
 */

#include "hasher.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <thread>

#ifdef _WIN32
#  include <windows.h>
#endif

// xxHash — pulled in by CMake FetchContent.
// XXH_INLINE_ALL gives us a fully inlined, header-only implementation.
#define XXH_INLINE_ALL
#include "xxhash.h"

namespace fast_fs_hash {

  // ── Constants ────────────────────────────────────────────────────────────

  /** 256 KiB read buffer per thread — large enough to amortize syscalls,
   *  small enough for good cache locality. */
  static constexpr size_t READ_BUFFER_SIZE = 256 * 1024;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Write the canonical (big-endian) 128-bit digest into out[16]. */
  static inline void write_canonical(XXH128_hash_t digest, uint8_t out[16]) noexcept {
    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, digest);
    memcpy(out, canonical.digest, 16);
  }

  /** Open a file for binary reading, handling UTF-8 paths on all platforms. */
  static inline FILE * open_file_utf8(const char * path) noexcept {
#ifdef _WIN32
    // Convert UTF-8 to wide string for full Windows Unicode support
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
    if (FSH_UNLIKELY(wlen <= 0)) return nullptr;
    auto wpath = std::make_unique<wchar_t[]>(static_cast<size_t>(wlen));
    MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath.get(), wlen);
    return _wfopen(wpath.get(), L"rb");
#else
    return fopen(path, "rb");
#endif
  }

  // ── Path parsing ────────────────────────────────────────────────────────

  /** A reference to a path within the encoded buffer. */
  struct PathRef {
    size_t offset;  // Byte offset into the paths buffer
    size_t length;  // Byte length of the path (0 = empty/non-existent)
  };

  /**
   * Pre-scan the path buffer and build an array of PathRef.
   *
   * Paths are separated by single \\0 bytes. Empty segments (length 0)
   * are preserved — they map to zero-hash entries in the output.
   *
   * A trailing \\0 after the last path is optional; if present it does
   * NOT create an extra empty entry.
   */
  static size_t scan_paths(const uint8_t * buf, size_t len, std::vector<PathRef> & refs) {
    refs.clear();
    if (len == 0) return 0;

    size_t seg_start = 0;

    for (size_t i = 0; i < len; ++i) {
      if (buf[i] == 0) {
        refs.push_back({seg_start, i - seg_start});
        seg_start = i + 1;
      }
    }
    // Trailing segment (no final \\0)
    if (seg_start < len) {
      refs.push_back({seg_start, len - seg_start});
    }

    return refs.size();
  }

  // ── Single-file hashing ─────────────────────────────────────────────────

  /**
   * Hash a single file's raw content using XXH3-128 streaming API.
   *
   * On success writes 16 bytes to out_hash and returns true.
   * On I/O error returns false (out_hash untouched — remains zeroed).
   */
  static bool hash_single_file(const char * path, unsigned char * rbuf, size_t rbuf_size, uint8_t out_hash[16]) {
    FILE * fp = open_file_utf8(path);
    if (FSH_UNLIKELY(!fp)) return false;

    XXH3_state_t state;
    XXH3_128bits_reset(&state);

    for (;;) {
      size_t n = fread(rbuf, 1, rbuf_size, fp);
      if (FSH_UNLIKELY(n == 0)) break;
      XXH3_128bits_update(&state, rbuf, n);
    }

    int err = ferror(fp);
    fclose(fp);
    if (FSH_UNLIKELY(err)) return false;

    write_canonical(XXH3_128bits_digest(&state), out_hash);
    return true;
  }

  // ── Parallel hashing ────────────────────────────────────────────────────

  /**
   * Worker function for the thread pool.
   * Each thread atomically claims the next file index and hashes it.
   * Lock-free: the only synchronization is the atomic counter.
   *
   * Empty paths (length 0) are skipped — their hash slots remain zeroed.
   * For non-empty paths, the \\0 separator in the buffer serves as the
   * C string null terminator, so we can pass a direct pointer to fopen()
   * without copying. The only exception is the last path when it's not
   * \\0-terminated — in that case we copy to a stack buffer.
   */
  static void worker_thread(
    const uint8_t * paths_buf,
    size_t paths_len,
    const std::vector<PathRef> & path_refs,
    uint8_t * hashes,
    std::atomic<size_t> & next_index) {
    auto rbuf = std::make_unique<unsigned char[]>(READ_BUFFER_SIZE);
    const size_t count = path_refs.size();
    char tmp_path[MAX_FILE_PATH];

    for (;;) {
      size_t idx = next_index.fetch_add(1, std::memory_order_relaxed);
      if (FSH_UNLIKELY(idx >= count)) break;

      const PathRef & ref = path_refs[idx];

      // Empty path → zero hash (already zeroed by caller)
      if (FSH_UNLIKELY(ref.length == 0)) continue;

      const uint8_t * seg = paths_buf + ref.offset;
      const char * path;
      size_t end_pos = ref.offset + ref.length;

      if (FSH_LIKELY(end_pos < paths_len && seg[ref.length] == 0)) {
        // The \\0 separator serves as null terminator — use directly
        path = reinterpret_cast<const char *>(seg);
      } else {
        // Last segment without trailing \\0 — copy and terminate
        size_t copy_len = ref.length < MAX_FILE_PATH - 1 ? ref.length : MAX_FILE_PATH - 1;
        memcpy(tmp_path, seg, copy_len);
        tmp_path[copy_len] = '\0';
        path = tmp_path;
      }

      // On failure the 16 bytes remain zeroed.
      hash_single_file(path, rbuf.get(), READ_BUFFER_SIZE, hashes + idx * 16);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  int hash_files(
    const uint8_t * paths_buf,
    size_t paths_len,
    int concurrency,
    std::vector<uint8_t> & output,
    std::string & error_message) {
    // Pre-scan path buffer to find boundaries
    std::vector<PathRef> path_refs;
    size_t file_count = scan_paths(paths_buf, paths_len, path_refs);

    // Allocate per-file hash buffer, zero-initialized.
    output.assign(file_count * 16, 0);

    if (FSH_LIKELY(file_count > 0)) {
      // Determine thread count.
      int hw = static_cast<int>(std::thread::hardware_concurrency());
      if (FSH_UNLIKELY(hw <= 0)) hw = 4;
      int thread_count = concurrency > 0 ? concurrency : std::min(hw * 2, static_cast<int>(file_count));
      if (FSH_UNLIKELY(thread_count < 1)) thread_count = 1;
      if (static_cast<size_t>(thread_count) > file_count) thread_count = static_cast<int>(file_count);

      // Hash all files in parallel using lock-free work stealing.
      std::atomic<size_t> next_index{0};

      if (FSH_LIKELY(thread_count > 1)) {
        std::vector<std::thread> threads;
        threads.reserve(thread_count);
        for (int i = 0; i < thread_count; ++i) {
          threads.emplace_back(
            worker_thread, paths_buf, paths_len, std::cref(path_refs), output.data(), std::ref(next_index));
        }
        for (auto & t : threads) {
          t.join();
        }
      } else {
        worker_thread(paths_buf, paths_len, path_refs, output.data(), next_index);
      }
    }

    (void)error_message;
    return 0;
  }

  // ── Parallel file reading ───────────────────────────────────────────────

  /**
   * Read a single file's raw content into a vector.
   *
   * On success stores the data and returns true.
   * On I/O error returns false (data cleared).
   */
  static bool read_single_file_contents(
    const char * path,
    unsigned char * rbuf,
    size_t rbuf_size,
    std::vector<uint8_t> & data) {
    FILE * fp = open_file_utf8(path);
    if (FSH_UNLIKELY(!fp)) return false;

    data.clear();
    for (;;) {
      size_t n = fread(rbuf, 1, rbuf_size, fp);
      if (FSH_UNLIKELY(n == 0)) break;
      size_t old_size = data.size();
      data.resize(old_size + n);
      memcpy(data.data() + old_size, rbuf, n);
    }

    int err = ferror(fp);
    fclose(fp);
    if (FSH_UNLIKELY(err)) {
      data.clear();
      return false;
    }
    return true;
  }

  /**
   * Worker function for the parallel file reader thread pool.
   * Each thread atomically claims the next file index and reads it.
   */
  static void read_worker_thread(
    const uint8_t * paths_buf,
    size_t paths_len,
    const std::vector<PathRef> & path_refs,
    std::vector<FileReadResult> & results,
    std::atomic<size_t> & next_index) {
    auto rbuf = std::make_unique<unsigned char[]>(READ_BUFFER_SIZE);
    const size_t count = path_refs.size();
    char tmp_path[MAX_FILE_PATH];

    for (;;) {
      size_t idx = next_index.fetch_add(1, std::memory_order_relaxed);
      if (FSH_UNLIKELY(idx >= count)) break;

      const PathRef & ref = path_refs[idx];

      // Empty path → skip (success remains false by default)
      if (FSH_UNLIKELY(ref.length == 0)) continue;

      const uint8_t * seg = paths_buf + ref.offset;
      const char * path;
      size_t end_pos = ref.offset + ref.length;

      if (FSH_LIKELY(end_pos < paths_len && seg[ref.length] == 0)) {
        path = reinterpret_cast<const char *>(seg);
      } else {
        size_t copy_len = ref.length < MAX_FILE_PATH - 1 ? ref.length : MAX_FILE_PATH - 1;
        memcpy(tmp_path, seg, copy_len);
        tmp_path[copy_len] = '\0';
        path = tmp_path;
      }

      results[idx].success = read_single_file_contents(path, rbuf.get(), READ_BUFFER_SIZE, results[idx].data);
    }
  }

  int read_files(
    const uint8_t * paths_buf,
    size_t paths_len,
    int concurrency,
    std::vector<FileReadResult> & results,
    std::string & error_message) {
    std::vector<PathRef> path_refs;
    size_t file_count = scan_paths(paths_buf, paths_len, path_refs);

    results.resize(file_count);

    if (FSH_LIKELY(file_count > 0)) {
      int hw = static_cast<int>(std::thread::hardware_concurrency());
      if (FSH_UNLIKELY(hw <= 0)) hw = 4;
      int thread_count = concurrency > 0 ? concurrency : std::min(hw * 2, static_cast<int>(file_count));
      if (FSH_UNLIKELY(thread_count < 1)) thread_count = 1;
      if (static_cast<size_t>(thread_count) > file_count) thread_count = static_cast<int>(file_count);

      std::atomic<size_t> next_index{0};

      if (FSH_LIKELY(thread_count > 1)) {
        std::vector<std::thread> threads;
        threads.reserve(thread_count);
        for (int i = 0; i < thread_count; ++i) {
          threads.emplace_back(
            read_worker_thread, paths_buf, paths_len, std::cref(path_refs), std::ref(results), std::ref(next_index));
        }
        for (auto & t : threads) {
          t.join();
        }
      } else {
        read_worker_thread(paths_buf, paths_len, path_refs, results, next_index);
      }
    }

    (void)error_message;
    return 0;
  }

}  // namespace fast_fs_hash
