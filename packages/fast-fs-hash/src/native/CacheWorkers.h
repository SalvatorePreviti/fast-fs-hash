#ifndef _FAST_FS_HASH_CACHE_WORKERS_H
#define _FAST_FS_HASH_CACHE_WORKERS_H

#include "HashFilesWorker.h"
#include "FileStat.h"

namespace fast_fs_hash {

  /** Entry stride: 32-byte stat + 16-byte hash = 48 bytes. Matches ENTRY_STRIDE in constants.ts. */
  static constexpr size_t CACHE_ENTRY_STRIDE = 48;

  /** Per-file state flags — must match constants in constants.ts. */
  static constexpr uint8_t CACHE_F_NOT_CHECKED = 0;
  static constexpr uint8_t CACHE_F_DONE = 1;
  static constexpr uint8_t CACHE_F_NEED_HASH = 2;
  static constexpr uint8_t CACHE_F_HAS_OLD = 3;

  /**
   * Open + read + hash a single file, writing 16-byte canonical digest to dest.
   * Same fast path as HashFilesWorker: one-shot for files < 256 KiB, streaming
   * for larger.  On error (open/read failure), dest is zeroed.
   */
  FSH_FORCE_INLINE static void hash_file_to(const char * path, uint8_t * dest, unsigned char * rbuf) {
    FileHandle file(path);
    if (!file) [[unlikely]] {
      memset(dest, 0, 16);
      return;
    }

    const int64_t n = file.read(rbuf, READ_BUFFER_SIZE);
    if (n < 0) [[unlikely]] {
      memset(dest, 0, 16);
      return;
    }

    const size_t bytes = static_cast<size_t>(n);
    if (bytes < READ_BUFFER_SIZE) [[likely]] {
      // Entire file in one read — one-shot hash (common fast path).
      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(dest), XXH3_128bits(rbuf, bytes));
      return;
    }

    // Large file — streaming hash (cold path, kept out-of-line in HashFilesWorker.h).
    hash_large_file(rbuf, READ_BUFFER_SIZE, file, dest);
  }

  /**
   * Parallel stat + compare against old cache entries with early exit.
   *
   * For each file:
   *   1. stat() -> write 32-byte stat section to entries_buf
   *   2. Compare 32 bytes with old_buf at same offset
   *   3. If match: copy 16-byte hash from old -> F_DONE
   *   4. If size matches but metadata changed: rehash -> compare content hash
   *   5. Else: F_NEED_HASH + set changed=true, early_exit=true
   */
  struct CacheStatMatchRunner {
    //  - Cache line 0: read-only config
    const char * const * segments;
    size_t file_count;
    uint8_t * entries_buf;
    const uint8_t * old_buf;
    uint8_t * file_states;
    size_t work_batch = 0;

    //  - Cache line 1: hot contended atomic (work-stealing counter)
    alignas(64) mutable std::atomic<size_t> next_index{0};

    //  - Cache line 2: early-exit signalling
    alignas(64) mutable std::atomic<bool> early_exit{false};
    mutable std::atomic<bool> changed{false};

    /**
     * Run parallel stat+match.  Returns false on OOM only.
     * After completion, changed.load() tells whether any file differs.
     */
    bool run(int concurrency) {
      int hw = static_cast<int>(std::thread::hardware_concurrency());
      if (hw < 2) [[unlikely]]
        hw = 2;

      int tc = concurrency > 0 ? concurrency : hw;
      if (tc > MAX_STACK_THREADS) [[unlikely]]
        tc = MAX_STACK_THREADS;
      if (tc < 1) [[unlikely]]
        tc = 1;

      {
        int active = g_active_hash_threads.load(std::memory_order_relaxed);
        int budget = hw - active;
        if (budget < 1) budget = 1;
        if (tc > budget) tc = budget;
      }

      size_t batch = this->file_count / static_cast<size_t>(tc * 4);
      if (batch < MIN_WORK_BATCH) batch = MIN_WORK_BATCH;
      if (batch > MAX_WORK_BATCH) batch = MAX_WORK_BATCH;

      int max_useful = static_cast<int>((this->file_count + batch - 1) / batch);
      if (tc > max_useful) tc = max_useful;
      if (tc < 1) [[unlikely]]
        tc = 1;

      this->work_batch = batch;
      this->next_index.store(0, std::memory_order_relaxed);
      this->early_exit.store(false, std::memory_order_relaxed);
      this->changed.store(false, std::memory_order_relaxed);

      // Pre-allocate read buffer slab (needed for rehash path).
      AlignedPtr<unsigned char> slab(64, static_cast<size_t>(tc) * READ_BUFFER_SIZE);
      if (!slab) [[unlikely]]
        return false;

      g_active_hash_threads.fetch_add(tc, std::memory_order_relaxed);

      const int spawned = tc - 1;
      std::thread threads[MAX_STACK_THREADS];
      for (int i = 0; i < spawned; ++i)
        threads[i] =
          std::thread(&CacheStatMatchRunner::process_files, this, slab.ptr + static_cast<size_t>(i + 1) * READ_BUFFER_SIZE);
      this->process_files(slab.ptr);
      for (int i = 0; i < spawned; ++i)
        threads[i].join();

      g_active_hash_threads.fetch_sub(tc, std::memory_order_relaxed);
      return true;
    }

    /** Per-thread stat+match loop. */
    FSH_FORCE_INLINE void process_files(unsigned char * rbuf_raw) const {
      unsigned char * const rbuf = assume_aligned<64>(rbuf_raw);
      const size_t fc = this->file_count;
      const size_t wb = this->work_batch;
      uint8_t * const ent = this->entries_buf;
      const uint8_t * const old = this->old_buf;
      uint8_t * const states = this->file_states;
      const char * const * const segs = this->segments;

      for (;;) {
        const size_t base = this->next_index.fetch_add(wb, std::memory_order_relaxed);
        if (base >= fc) [[unlikely]]
          break;
        const size_t batch_end = base + wb < fc ? base + wb : fc;

        for (size_t idx = base; idx < batch_end; ++idx) {
          // Cooperative early exit — stop on first detected change.
          if (this->early_exit.load(std::memory_order_relaxed)) [[unlikely]]
            return;

          const char * const path = segs[idx];
          const size_t eOff = idx * CACHE_ENTRY_STRIDE;

          // Prefetch next iteration's path string, old entry, and write-warm output slots.
          if (idx + 1 < batch_end) [[likely]] {
            FSH_PREFETCH(segs[idx + 1]);
            FSH_PREFETCH(old + (idx + 1) * CACHE_ENTRY_STRIDE);
            FSH_PREFETCH_W(ent + (idx + 1) * CACHE_ENTRY_STRIDE);
          }
          FSH_PREFETCH_W(ent + eOff);

          // Skip empty paths (rare: consecutive null terminators in pathsBuf).
          if (path[0] == '\0') [[unlikely]] {
            memset(ent + eOff, 0, 32);
            states[idx] = CACHE_F_DONE;
            continue;
          }

          // 1. stat() -> write 32-byte record to entries_buf
          const bool stat_ok = file_stat_to(path, ent + eOff);

          // 2. Compare 32-byte stat section with old entry
          if (memcmp(ent + eOff, old + eOff, 32) == 0) [[likely]] {
            // Stat matches — copy hash from old cache.
            memcpy(ent + eOff + 32, old + eOff + 32, 16);
            states[idx] = CACHE_F_DONE;
            continue;
          }

          // 3. Size matches but metadata changed? -> rehash and compare content hash.
          if (stat_ok) [[likely]] {
            uint64_t new_size, old_size;
            memcpy(&new_size, ent + eOff + 24, 8);
            memcpy(&old_size, old + eOff + 24, 8);

            if (new_size == old_size && new_size > 0) [[unlikely]] {
              hash_file_to(path, ent + eOff + 32, rbuf);
              if (memcmp(ent + eOff + 32, old + eOff + 32, 16) == 0) [[likely]] {
                // Content hash matches — entry is unchanged.
                states[idx] = CACHE_F_DONE;
              } else {
                // Content hash differs — cache is invalid.
                states[idx] = CACHE_F_NEED_HASH;
                this->changed.store(true, std::memory_order_relaxed);
                this->early_exit.store(true, std::memory_order_relaxed);
              }
              continue;
            }
          }

          // 4. Size differs, stat failed, or file appeared/disappeared — changed.
          states[idx] = CACHE_F_NEED_HASH;
          this->changed.store(true, std::memory_order_relaxed);
          this->early_exit.store(true, std::memory_order_relaxed);
        }
      }
    }
  };

  /**
   * Parallel stat + hash for entries that still need work.
   * Skips F_DONE entries.  No early exit — all remaining entries must be completed.
   */
  struct CacheCompleteRunner {
    const char * const * segments;
    size_t file_count;
    uint8_t * entries_buf;
    uint8_t * file_states;
    size_t work_batch = 0;

    alignas(64) mutable std::atomic<size_t> next_index{0};

    /** Run parallel stat+hash.  Returns false on OOM only. */
    bool run(int concurrency) {
      int hw = static_cast<int>(std::thread::hardware_concurrency());
      if (hw < 2) [[unlikely]]
        hw = 2;

      int tc = concurrency > 0 ? concurrency : hw;
      if (tc > MAX_STACK_THREADS) [[unlikely]]
        tc = MAX_STACK_THREADS;
      if (tc < 1) [[unlikely]]
        tc = 1;

      {
        int active = g_active_hash_threads.load(std::memory_order_relaxed);
        int budget = hw - active;
        if (budget < 1) budget = 1;
        if (tc > budget) tc = budget;
      }

      size_t batch = this->file_count / static_cast<size_t>(tc * 4);
      if (batch < MIN_WORK_BATCH) batch = MIN_WORK_BATCH;
      if (batch > MAX_WORK_BATCH) batch = MAX_WORK_BATCH;

      int max_useful = static_cast<int>((this->file_count + batch - 1) / batch);
      if (tc > max_useful) tc = max_useful;
      if (tc < 1) [[unlikely]]
        tc = 1;

      this->work_batch = batch;
      this->next_index.store(0, std::memory_order_relaxed);

      AlignedPtr<unsigned char> slab(64, static_cast<size_t>(tc) * READ_BUFFER_SIZE);
      if (!slab) [[unlikely]]
        return false;

      g_active_hash_threads.fetch_add(tc, std::memory_order_relaxed);

      const int spawned = tc - 1;
      std::thread threads[MAX_STACK_THREADS];
      for (int i = 0; i < spawned; ++i)
        threads[i] =
          std::thread(&CacheCompleteRunner::process_files, this, slab.ptr + static_cast<size_t>(i + 1) * READ_BUFFER_SIZE);
      this->process_files(slab.ptr);
      for (int i = 0; i < spawned; ++i)
        threads[i].join();

      g_active_hash_threads.fetch_sub(tc, std::memory_order_relaxed);
      return true;
    }

    /** Per-thread stat+hash loop for remaining entries. */
    FSH_FORCE_INLINE void process_files(unsigned char * rbuf_raw) const {
      unsigned char * const rbuf = assume_aligned<64>(rbuf_raw);
      const size_t fc = this->file_count;
      const size_t wb = this->work_batch;
      uint8_t * const ent = this->entries_buf;
      uint8_t * const states = this->file_states;
      const char * const * const segs = this->segments;

      for (;;) {
        const size_t base = this->next_index.fetch_add(wb, std::memory_order_relaxed);
        if (base >= fc) [[unlikely]]
          break;
        const size_t batch_end = base + wb < fc ? base + wb : fc;

        for (size_t idx = base; idx < batch_end; ++idx) {
          const uint8_t state = states[idx];
          if (state == CACHE_F_DONE) [[likely]]
            continue;

          const char * const path = segs[idx];
          const size_t eOff = idx * CACHE_ENTRY_STRIDE;

          // Prefetch next non-done entry's path and write-warm its output slot.
          if (idx + 1 < batch_end) [[likely]] {
            FSH_PREFETCH(segs[idx + 1]);
            FSH_PREFETCH_W(ent + (idx + 1) * CACHE_ENTRY_STRIDE);
          }
          FSH_PREFETCH_W(ent + eOff);

          // Skip empty paths.
          if (path[0] == '\0') [[unlikely]] {
            continue;
          }

          if (state == CACHE_F_HAS_OLD) {
            // Old entry (stat + hash) pre-populated in entries_buf from remapped cache.
            // Re-stat into temp, compare with old stat — if unchanged, hash is valid.
            uint8_t tmp[32];
            const bool sok = file_stat_to(path, tmp);
            if (sok && memcmp(tmp, ent + eOff, 32) == 0) [[likely]] {
              // Stat unchanged — hash at eOff+32 is still valid.
              states[idx] = CACHE_F_DONE;
              continue;
            }
            // Overwrite stat section.
            memcpy(ent + eOff, tmp, 32);
            if (sok) [[likely]] {
              // Stat changed — rehash.
              hash_file_to(path, ent + eOff + 32, rbuf);
            } else {
              // Stat failed — zero hash (file disappeared).
              memset(ent + eOff + 32, 0, 16);
            }
            // State stays F_HAS_OLD (changed — stat/hash differ).
            continue;
          }

          // F_NOT_CHECKED: need full stat + hash.
          // F_NEED_HASH: stat already written, just need hash.
          if (state == CACHE_F_NOT_CHECKED) [[likely]] {
            if (!file_stat_to(path, ent + eOff)) {
              // Stat failed — entry zeroed by file_stat_to, zero hash too.
              memset(ent + eOff + 32, 0, 16);
              // State stays F_NOT_CHECKED (changed).
              continue;
            }
          }

          hash_file_to(path, ent + eOff + 32, rbuf);
          // State stays as original (F_NOT_CHECKED or F_NEED_HASH — changed).
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
