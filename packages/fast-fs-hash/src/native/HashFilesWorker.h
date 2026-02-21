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

  /** Tracks active worker threads across all concurrent hash operations.
   *  Prevents over-subscription when multiple async hash calls overlap
   *  (e.g. several JS promises each calling hashFiles in parallel).
   *  Read/written with relaxed ordering — best-effort coordination is
   *  sufficient; momentary over-shoot is harmless, starvation cannot
   *  happen because every caller is guaranteed at least 1 thread. */
  inline std::atomic<int> g_active_hash_threads{0};

  /**
   * Large-file streaming hash — cold path, kept out-of-line to minimize
   * icache pressure in the hot single-read loop.  The XXH3_state_t (576 B)
   * lives only on this frame, not on the hot-path stack.
   */
  FSH_NO_INLINE static void hash_large_file(unsigned char * rbuf, size_t initial_bytes, FileHandle & file, uint8_t * dest) {
    file.hint_sequential();  // worth the syscall only when multiple reads follow

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
    size_t file_count;
    uint8_t * output_data;

    /** Set by run() before spawning threads. */
    size_t work_batch = 0;

    /** Work-stealing counter — mutable because process_files() is const
     *  (it never mutates the configuration fields; this is a sync primitive). */
    mutable std::atomic<size_t> next_index{0};

    /** Hash all files in parallel: spawns N-1 threads + uses calling thread.
     *  Threads share `this` pointer (no struct copies). */
    void run(int concurrency) {
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

      // Avoid global over-subscription when multiple bulk hash operations
      // run concurrently (e.g. parallel JS promises each calling hashFiles).
      // Best-effort: momentary over-shoot is harmless, but every caller
      // is guaranteed at least 1 thread so starvation cannot occur.
      {
        int active = g_active_hash_threads.load(std::memory_order_relaxed);
        int budget = hw - active;
        if (budget < 1) budget = 1;
        if (tc > budget) tc = budget;
      }

      // Dynamic batch size — target ~4 rounds per thread for good load
      // balancing while keeping atomic contention low.
      size_t batch = this->file_count / static_cast<size_t>(tc * 4);
      if (batch < MIN_WORK_BATCH) batch = MIN_WORK_BATCH;
      if (batch > MAX_WORK_BATCH) batch = MAX_WORK_BATCH;

      // Cap threads to the number of batches that actually have work.
      int max_useful = static_cast<int>((this->file_count + batch - 1) / batch);
      if (tc > max_useful) tc = max_useful;
      if (FSH_UNLIKELY(tc < 1)) tc = 1;

      this->work_batch = batch;
      this->next_index.store(0, std::memory_order_relaxed);

      g_active_hash_threads.fetch_add(tc, std::memory_order_relaxed);

      const int spawned = tc - 1;
      std::thread threads[MAX_STACK_THREADS];
      for (int i = 0; i < spawned; ++i)
        threads[i] = std::thread(&HashFilesWorker::process_files, this);
      this->process_files();  // calling thread does work too
      for (int i = 0; i < spawned; ++i)
        threads[i].join();

      g_active_hash_threads.fetch_sub(tc, std::memory_order_relaxed);
    }

    /** Per-thread work loop — const because it only reads configuration
     *  fields; the mutable next_index is the sole shared write target. */
    void process_files() const {
      alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
      const size_t fc = this->file_count;
      const size_t wb = this->work_batch;
      uint8_t * const out = assume_aligned<OUTPUT_ALIGNMENT>(this->output_data);
      const char * const * const segs = this->segments;

      for (;;) {
        // Batch work stealing — claim `wb` files per atomic to reduce
        // cache-line bouncing between cores.
        const size_t base = this->next_index.fetch_add(wb, std::memory_order_relaxed);
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

          hash_large_file(rbuf, READ_BUFFER_SIZE, file, dest);
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
