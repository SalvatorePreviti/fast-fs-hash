#pragma once

#include "includes.h"
#include "FileHandle.h"

namespace fast_fs_hash {

  /** 256 KiB read buffer per thread — stack-allocated, cache-line aligned.
   *  Covers most source files in a single read; fits well within the
   *  default thread stack (512 KiB on macOS, 8 MiB on Linux). */
  static constexpr size_t READ_BUFFER_SIZE = 256 * 1024;

  /** Output buffer alignment — cache-line aligned for optimal prefetch
   *  and to avoid false sharing between threads writing adjacent slots. */
  static constexpr size_t OUTPUT_ALIGNMENT = 64;

  /** Maximum thread count (maximum number of processors supported) */
  static constexpr int MAX_STACK_THREADS = 24;

  /**
   * Large-file streaming hash — cold path, kept out-of-line to minimize
   * icache pressure in the hot single-read loop.  The XXH3_state_t (576 B)
   * lives only on this frame, not on the hot-path stack.
   */
  FSH_NO_INLINE static void hash_large_file(unsigned char * rbuf, size_t initial_bytes, FileHandle & file, uint8_t * dest) {
    XXH3_state_t state;
    XXH3_128bits_reset(&state);
    XXH3_128bits_update(&state, rbuf, initial_bytes);
    for (;;) {
      const int64_t n = file.read(rbuf, READ_BUFFER_SIZE);
      if (FSH_UNLIKELY(n <= 0)) {
        if (FSH_LIKELY(n == 0)) {
          XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(dest), XXH3_128bits_digest(&state));
        } else {
          memset(dest, 0, 16);  // read error mid-stream
        }
        return;
      }
      XXH3_128bits_update(&state, rbuf, static_cast<size_t>(n));
    }
  }

  struct HashFilesWorker {
    const char * const * segments;
    const size_t file_count;
    std::atomic<size_t> & next_index;
    uint8_t * output_data;

    /** Hash all files in parallel: spawns N-1 threads + uses calling thread. */
    static void run(const char * const * segments, size_t file_count, uint8_t * output, int concurrency) {
      int hw = static_cast<int>(std::thread::hardware_concurrency());
      if (FSH_UNLIKELY(hw <= 2)) {
        hw = 2;
      }
      int tc = concurrency > 0 ? concurrency : hw * 2;
      if (FSH_UNLIKELY(tc > MAX_STACK_THREADS)) {
        tc = MAX_STACK_THREADS;
      }
      if (static_cast<size_t>(tc) > file_count) {
        tc = static_cast<int>(file_count);
      }

      std::atomic<size_t> next_index{0};
      HashFilesWorker worker{segments, file_count, next_index, output};

      const int spawned = tc - 1;
      std::thread threads[MAX_STACK_THREADS];
      for (int i = 0; i < spawned; ++i)
        threads[i] = std::thread(worker);
      worker();  // calling thread does work too
      for (int i = 0; i < spawned; ++i)
        threads[i].join();
    }

    void operator()() const {
      alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
      const size_t fc = this->file_count;
      uint8_t * const out = this->output_data;
      const char * const * const segs = this->segments;
      std::atomic<size_t> & next = this->next_index;

      for (;;) {
        const size_t idx = next.fetch_add(1, std::memory_order_relaxed);
        if (FSH_UNLIKELY(idx >= fc)) {
          break;
        }

        const char * const path = segs[idx];
        uint8_t * const dest = out + idx * 16;

        // Prefetch next path string + write-warm the output cache line.
        FSH_PREFETCH(segs[idx + 1]);
        FSH_PREFETCH_W(dest);

        FileHandle file(path);
        const int64_t n = file.read(rbuf, READ_BUFFER_SIZE);
        if (FSH_UNLIKELY(n < 0)) {
          memset(dest, 0, 16);  // zero hash for unreadable files
          continue;
        }

        const size_t bytes = static_cast<size_t>(n);
        if (FSH_LIKELY(bytes < READ_BUFFER_SIZE)) {
          // Entire file in one read — one-shot hash (common fast path).
          XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(dest), XXH3_128bits(rbuf, bytes));
          continue;
        }

        hash_large_file(rbuf, bytes, file, dest);
      }
    }
  };

}  // namespace fast_fs_hash
