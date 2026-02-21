#ifndef _FAST_FS_HASH_HASH_FILES_WORKER_H
#define _FAST_FS_HASH_HASH_FILES_WORKER_H

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

  /** Maximum thread count (maximum number of threads to use) */
  static constexpr int MAX_STACK_THREADS = 16;

  /** Batch size bounds for dynamic work-stealing granularity. */
  static constexpr size_t MIN_WORK_BATCH = 1;
  static constexpr size_t MAX_WORK_BATCH = 32;

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
          memset(dest, 0, 16);  // rare: read error mid-stream
        }
        return;
      }
      XXH3_128bits_update(&state, rbuf, static_cast<size_t>(n));
    }
  }

  struct HashFilesWorker {
    const char * const * segments;
    const size_t file_count;
    const size_t work_batch;
    std::atomic<size_t> & next_index;
    uint8_t * output_data;

    /** Hash all files in parallel: spawns N-1 threads + uses calling thread. */
    static void run(const char * const * segments, size_t file_count, uint8_t * output, int concurrency) {
      // Compute thread count.
      // - User-provided concurrency takes precedence when > 0.
      // - Default: hardware_concurrency (1 thread per core — optimal for
      //   hot-cache CPU-bound workloads; sufficient I/O overlap for cold cache).
      // - Floor of 2 ensures parallelism even on single-core machines.
      // - Capped by MAX_STACK_THREADS and by the number of batches that
      //   actually have work.
      int hw = static_cast<int>(std::thread::hardware_concurrency());
      if (FSH_UNLIKELY(hw < 2)) hw = 2;

      int tc = concurrency > 0 ? concurrency : hw;
      if (FSH_UNLIKELY(tc > MAX_STACK_THREADS)) tc = MAX_STACK_THREADS;
      if (FSH_UNLIKELY(tc < 1)) tc = 1;

      // Dynamic batch size — target ~4 rounds per thread for good load
      // balancing while keeping atomic contention low.
      size_t batch = file_count / static_cast<size_t>(tc * 4);
      if (batch < MIN_WORK_BATCH) batch = MIN_WORK_BATCH;
      if (batch > MAX_WORK_BATCH) batch = MAX_WORK_BATCH;

      // Cap threads to the number of batches that actually have work.
      int max_useful = static_cast<int>((file_count + batch - 1) / batch);
      if (tc > max_useful) tc = max_useful;
      if (FSH_UNLIKELY(tc < 1)) tc = 1;

      std::atomic<size_t> next_index{0};
      HashFilesWorker worker{segments, file_count, batch, next_index, output};

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
      const size_t wb = this->work_batch;
      uint8_t * const out = this->output_data;
      const char * const * const segs = this->segments;
      std::atomic<size_t> & next = this->next_index;

      for (;;) {
        // Batch work stealing — claim `wb` files per atomic to reduce
        // cache-line bouncing between cores.
        const size_t base = next.fetch_add(wb, std::memory_order_relaxed);
        if (FSH_UNLIKELY(base >= fc)) break;
        const size_t batch_end = base + wb < fc ? base + wb : fc;

        for (size_t idx = base; idx < batch_end; ++idx) {
          const char * const path = segs[idx];
          uint8_t * const dest = out + idx * 16;

          // Prefetch next path string + write-warm the output cache line.
          FSH_PREFETCH(segs[idx + 1]);
          FSH_PREFETCH_W(dest);

          // Skip empty paths — rare (consecutive null terminators).
          if (FSH_UNLIKELY(path[0] == '\0')) {
            memset(dest, 0, 16);
            continue;
          }

          FileHandle file(path);
          const int64_t n = file.read(rbuf, READ_BUFFER_SIZE);
          if (FSH_UNLIKELY(n < 0)) {
            memset(dest, 0, 16);  // rare: unreadable file
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
    }
  };

}  // namespace fast_fs_hash

#endif
