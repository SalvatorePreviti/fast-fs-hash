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
 *   - macOS/Linux: open() accepts UTF-8 natively.
 *   - Windows: UTF-8 → wchar_t conversion via MultiByteToWideChar,
 *     then _wfopen() for full Unicode path support.
 */

#include "hasher.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <thread>

#ifndef _WIN32
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <unistd.h>
#else
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

#ifdef _WIN32
  /** Open a file for binary reading, handling UTF-8 paths on Windows. */
  static inline FILE * open_file_utf8(const char * path) noexcept {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
    if (FSH_UNLIKELY(wlen <= 0)) return nullptr;
    auto wpath = std::make_unique<wchar_t[]>(static_cast<size_t>(wlen));
    MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath.get(), wlen);
    return _wfopen(wpath.get(), L"rb");
  }
#endif

  // ── POSIX file I/O (used on macOS/Linux for lower overhead than fopen) ──

#ifndef _WIN32
  /**
   * Hash a single file using raw POSIX file descriptors.
   * Avoids stdio FILE* overhead and enables sequential read hints.
   */
  static bool hash_single_file_fd(const char * path, unsigned char * rbuf, size_t rbuf_size, uint8_t out_hash[16]) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (FSH_UNLIKELY(fd < 0)) return false;

    // Hint to kernel: we'll read this file sequentially
#ifdef F_RDAHEAD
    // macOS: enable read-ahead
    fcntl(fd, F_RDAHEAD, 1);
#endif
#ifdef POSIX_FADV_SEQUENTIAL
    // Linux: sequential access pattern
    posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#endif

    XXH3_state_t state;
    XXH3_128bits_reset(&state);

    for (;;) {
      ssize_t n = read(fd, rbuf, rbuf_size);
      if (FSH_UNLIKELY(n <= 0)) break;
      XXH3_128bits_update(&state, rbuf, static_cast<size_t>(n));
    }

    close(fd);
    write_canonical(XXH3_128bits_digest(&state), out_hash);
    return true;
  }

  /**
   * Read a single file's raw content using POSIX file descriptors.
   * Uses fstat to pre-allocate the vector when possible.
   */
  static bool read_single_file_fd(const char * path, unsigned char * rbuf, size_t rbuf_size, std::vector<uint8_t> & data) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (FSH_UNLIKELY(fd < 0)) return false;

#ifdef F_RDAHEAD
    fcntl(fd, F_RDAHEAD, 1);
#endif
#ifdef POSIX_FADV_SEQUENTIAL
    posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#endif

    // Pre-allocate if we can stat the file size
    struct stat st;
    if (fstat(fd, &st) == 0 && st.st_size > 0) {
      data.reserve(static_cast<size_t>(st.st_size));
    }

    data.clear();
    for (;;) {
      ssize_t n = read(fd, rbuf, rbuf_size);
      if (FSH_UNLIKELY(n <= 0)) break;
      size_t old_size = data.size();
      data.resize(old_size + static_cast<size_t>(n));
      memcpy(data.data() + old_size, rbuf, static_cast<size_t>(n));
    }

    close(fd);
    return true;  // Successfully opened — empty file is still success
  }
#else
  // ── Windows fallback using FILE* ──────────────────────────────────────

  static bool hash_single_file_fd(const char * path, unsigned char * rbuf, size_t rbuf_size, uint8_t out_hash[16]) {
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

  static bool read_single_file_fd(
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
#endif

  // ── Path parsing ────────────────────────────────────────────────────────

  /** A reference to a path within the encoded buffer. */
  struct PathRef {
    size_t offset;  // Byte offset into the paths buffer
    size_t length;  // Byte length of the path (0 = empty/non-existent)
  };

  /** Pre-scan the path buffer and build an array of PathRef. */
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
    if (seg_start < len) {
      refs.push_back({seg_start, len - seg_start});
    }
    return refs.size();
  }

  /** Resolve a path from the buffer, copying to tmp_path only if not null-terminated. */
  static inline const char * resolve_path(
    const uint8_t * paths_buf,
    size_t paths_len,
    const PathRef & ref,
    char * tmp_path) {
    const uint8_t * seg = paths_buf + ref.offset;
    size_t end_pos = ref.offset + ref.length;
    if (FSH_LIKELY(end_pos < paths_len && seg[ref.length] == 0)) {
      return reinterpret_cast<const char *>(seg);
    }
    size_t copy_len = ref.length < MAX_FILE_PATH - 1 ? ref.length : MAX_FILE_PATH - 1;
    memcpy(tmp_path, seg, copy_len);
    tmp_path[copy_len] = '\0';
    return tmp_path;
  }

  /** Determine optimal thread count. */
  static inline int calc_threads(int concurrency, size_t file_count) {
    int hw = static_cast<int>(std::thread::hardware_concurrency());
    if (FSH_UNLIKELY(hw <= 0)) hw = 4;
    int tc = concurrency > 0 ? concurrency : std::min(hw * 2, static_cast<int>(file_count));
    if (FSH_UNLIKELY(tc < 1)) tc = 1;
    if (static_cast<size_t>(tc) > file_count) tc = static_cast<int>(file_count);
    return tc;
  }

  // ── Parallel hashing ────────────────────────────────────────────────────

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
      if (FSH_UNLIKELY(ref.length == 0)) continue;
      const char * path = resolve_path(paths_buf, paths_len, ref, tmp_path);
      hash_single_file_fd(path, rbuf.get(), READ_BUFFER_SIZE, hashes + idx * 16);
    }
  }

  int hash_files(
    const uint8_t * paths_buf,
    size_t paths_len,
    int concurrency,
    std::vector<uint8_t> & output,
    std::string & error_message) {
    std::vector<PathRef> path_refs;
    size_t file_count = scan_paths(paths_buf, paths_len, path_refs);
    output.assign(file_count * 16, 0);

    if (FSH_LIKELY(file_count > 0)) {
      int thread_count = calc_threads(concurrency, file_count);
      std::atomic<size_t> next_index{0};

      if (FSH_LIKELY(thread_count > 1)) {
        std::vector<std::thread> threads;
        threads.reserve(thread_count);
        for (int i = 0; i < thread_count; ++i) {
          threads.emplace_back(
            worker_thread, paths_buf, paths_len, std::cref(path_refs), output.data(), std::ref(next_index));
        }
        for (auto & t : threads) { t.join(); }
      } else {
        worker_thread(paths_buf, paths_len, path_refs, output.data(), next_index);
      }
    }

    (void)error_message;
    return 0;
  }

  // ── Parallel file reading ───────────────────────────────────────────────

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
      if (FSH_UNLIKELY(ref.length == 0)) continue;
      const char * path = resolve_path(paths_buf, paths_len, ref, tmp_path);
      results[idx].success = read_single_file_fd(path, rbuf.get(), READ_BUFFER_SIZE, results[idx].data);
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
      int thread_count = calc_threads(concurrency, file_count);
      std::atomic<size_t> next_index{0};

      if (FSH_LIKELY(thread_count > 1)) {
        std::vector<std::thread> threads;
        threads.reserve(thread_count);
        for (int i = 0; i < thread_count; ++i) {
          threads.emplace_back(
            read_worker_thread, paths_buf, paths_len, std::cref(path_refs), std::ref(results), std::ref(next_index));
        }
        for (auto & t : threads) { t.join(); }
      } else {
        read_worker_thread(paths_buf, paths_len, path_refs, results, next_index);
      }
    }

    (void)error_message;
    return 0;
  }

}  // namespace fast_fs_hash
