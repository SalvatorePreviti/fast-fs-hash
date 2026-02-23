#ifndef _FAST_FS_HASH_HASH_FILES_WORKER_H
#define _FAST_FS_HASH_HASH_FILES_WORKER_H

#include "FfshFile.h"
#include "ThreadPool.h"

#include <algorithm>

namespace fast_fs_hash {

  /** Output buffer alignment — cache-line aligned for optimal prefetch
   *  and to avoid false sharing between threads writing adjacent slots. */
  static constexpr size_t OUTPUT_ALIGNMENT = 64;

  /**
   * Large-file streaming hash — cold path, kept out-of-line to minimize
   * icache pressure in the hot single-read loop. The XXH3_state_t (576 B)
   * lives only on this frame, not on the hot-path stack.
   */
  FSH_NO_INLINE inline void hashLargeFile(unsigned char * rbuf, size_t initial_bytes, FfshFile & file, uint8_t * dest) {
    XXH3_state_t state;
    XXH3_128bits_reset(&state);
    XXH3_128bits_update(&state, rbuf, initial_bytes);
    for (;;) {
      const int64_t n = file.read(rbuf, READ_BUFFER_SIZE);
      if (n <= 0) [[unlikely]] {
        if (n == 0) [[likely]] {
          XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(dest), XXH3_128bits_digest(&state));
        } else {
          memset(dest, 0, 16);  // rare: read error mid-stream
        }
        return;
      }
      XXH3_128bits_update(&state, rbuf, static_cast<size_t>(n));
    }
  }

  /**
   * Per-thread file open context.
   * Eliminates #ifdef _WIN32 from the HashFilesWorker inner loop.
   * On POSIX: open directly from UTF-8 path (no conversion needed).
   * On Windows: convert UTF-8 → UTF-16 via WPath scratch, then open wide.
   */
  struct FileOpener {
#ifdef _WIN32
    wchar_t scratch[FSH_MAX_PATH];

    FSH_FORCE_INLINE FfshFile open(const char * path) const noexcept {
      WPath wp(path, const_cast<wchar_t *>(this->scratch), FSH_MAX_PATH);
      return FfshFile(wp.data);
    }
#else
    FSH_FORCE_INLINE FfshFile open(const char * path) const noexcept { return FfshFile(path); }
#endif
  };

  /** Max threads for parallel file hashing. Measured optimal at ~10 threads
   *  on M3/M4 (705 files, 23 MiB) — beyond that, filesystem contention dominates. */
  static constexpr int MAX_HASH_THREADS = 10;

  /**
   * Parallel file hasher using the ThreadPool fork-join mechanism.
   * Each thread hashes a batch of files, writing 128-bit xxHash digests
   * to a shared output buffer. Work-stealing via atomic nextIndex.
   */
  struct HashFilesWorker {
    // Cache line 0: read-only config (set once by run(), read by all threads)
    const char * const * segments = nullptr;
    size_t fileCount = 0;
    uint8_t * outputData = nullptr;
    size_t workBatch = 0;
    bool throwOnError = false;
    const ThreadPool * pool_ = nullptr;

    void init(const char * const * segs, size_t count, uint8_t * output) noexcept {
      this->segments = segs;
      this->fileCount = count;
      this->outputData = output;
    }

    struct Job : ForkJob<Job, MAX_HASH_THREADS> {
      HashFilesWorker * owner;
      void (*onDone)(void *);
      void * onDoneArg;

      void forkWork() noexcept {
        alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
        this->owner->processFiles(rbuf);
      }
      void forkDone() noexcept {
        if (this->onDone) {
          this->onDone(this->onDoneArg);
        }
      }
    };

    alignas(64) mutable std::atomic<size_t> nextIndex{0};
    mutable std::atomic<bool> hasError{false};

    Job job_;

    /** Launch parallel hashing on the given pool. Calls on_done when complete. */
    void run(ThreadPool & pool, int concurrency, void (*on_done)(void *), void * done_arg) {
      this->pool_ = &pool;
      this->job_.owner = this;
      this->job_.onDone = on_done;
      this->job_.onDoneArg = done_arg;

      int tc = ThreadPool::compute_threads(concurrency, this->fileCount, MAX_HASH_THREADS, 4);

      const size_t batch = std::clamp(this->fileCount / static_cast<size_t>(tc * 4), size_t{1}, size_t{32});

      {
        const int maxUseful = static_cast<int>((this->fileCount + batch - 1) / batch);
        if (tc > maxUseful) {
          tc = maxUseful;
        }
        if (tc < 1) [[unlikely]] {
          tc = 1;
        }
      }

      this->workBatch = batch;
      this->nextIndex.store(0, std::memory_order_relaxed);

      pool.submit(this->job_, tc);
    }

    /** Per-thread work loop. `rbuf_raw` is stack-allocated by the pool thread. */
    FSH_FORCE_INLINE void processFiles(unsigned char * rbuf_raw) const {
      unsigned char * FSH_RESTRICT const rbuf = assume_aligned<64>(rbuf_raw);
      const size_t fc = this->fileCount;
      const size_t wb = this->workBatch;
      uint8_t * FSH_RESTRICT const out = assume_aligned<OUTPUT_ALIGNMENT>(this->outputData);
      const char * const * FSH_RESTRICT const segs = this->segments;
      const bool toe = this->throwOnError;
      const ThreadPool * pool = this->pool_;

      FileOpener opener;

      for (;;) {
        if (pool->is_shutdown()) [[unlikely]] {
          break;
        }
        const size_t base = this->nextIndex.fetch_add(wb, std::memory_order_relaxed);
        if (base >= fc) [[unlikely]] {
          break;
        }
        const size_t batchEnd = base + wb < fc ? base + wb : fc;

        FSH_PREFETCH_W(out + base * 16);

        for (size_t idx = base; idx < batchEnd; ++idx) {
          const char * const path = segs[idx];
          uint8_t * const dest = out + idx * 16;

          if (idx + 1 < batchEnd) [[likely]] {
            FSH_PREFETCH(segs[idx + 1]);
            FSH_PREFETCH_W(dest + 16);
          }

          if (path[0] == '\0') [[unlikely]] {
            memset(dest, 0, 16);
            continue;
          }

          FfshFile file = opener.open(path);
          if (!file) [[unlikely]] {
            memset(dest, 0, 16);
            if (toe) {
              this->hasError.store(true, std::memory_order_relaxed);
            }
            continue;
          }

          const int64_t n = file.read_at_most(rbuf, READ_BUFFER_SIZE);
          if (n < 0) [[unlikely]] {
            memset(dest, 0, 16);
            if (toe) {
              this->hasError.store(true, std::memory_order_relaxed);
            }
            continue;
          }

          const size_t bytes = static_cast<size_t>(n);
          if (bytes < READ_BUFFER_SIZE) [[likely]] {
            XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(dest), XXH3_128bits(rbuf, bytes));
            continue;
          }

          hashLargeFile(rbuf, READ_BUFFER_SIZE, file, dest);
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
