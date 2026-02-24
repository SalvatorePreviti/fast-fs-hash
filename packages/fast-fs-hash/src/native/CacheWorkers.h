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
   * Hash from an already-opened file handle.  Shared implementation for
   * hash_file_to overloads — avoids code duplication.
   */
  FSH_FORCE_INLINE void hash_opened_file(FileHandle & file, uint8_t * dest, unsigned char * rbuf) {
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
      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(dest), XXH3_128bits(rbuf, bytes));
      return;
    }

    hash_large_file(rbuf, READ_BUFFER_SIZE, file, dest);
  }

  /**
   * Open + read + hash a single file from a UTF-8 path, writing 16-byte
   * canonical digest to dest.  On error, dest is zeroed.
   */
  FSH_FORCE_INLINE void hash_file_to(const char * path, uint8_t * dest, unsigned char * rbuf) {
    FileHandle file(path);
    hash_opened_file(file, dest, rbuf);
  }

#ifdef _WIN32
  /** Windows fast path: hash from a pre-converted UTF-16 path. */
  FSH_FORCE_INLINE void hash_file_to(const wchar_t * wpath, uint8_t * dest, unsigned char * rbuf) {
    FileHandle file(wpath);
    hash_opened_file(file, dest, rbuf);
  }
#endif

  /**
   * Copy a relative path to a destination buffer.
   * On Windows, converts forward slashes to backslashes (the OS separator).
   * On POSIX, this is just strcpy — forward slashes are native.
   */
  FSH_FORCE_INLINE void copy_rel_path(char * dst, const char * src) {
#ifdef _WIN32
    while (*src) {
      *dst++ = (*src == '/') ? '\\' : *src;
      ++src;
    }
    *dst = '\0';
#else
    strcpy(dst, src);
#endif
  }

  /**
   * Compute effective root length and prefix length for path resolution.
   * Strips trailing separator from root if present.
   *
   * @param root_path   Root directory string.
   * @param root_len    Length of root_path.
   * @param out_rl      Receives effective root length (trailing sep stripped).
   * @param out_prefix  Receives prefix length (rl + 1: root + separator).
   */
  FSH_FORCE_INLINE void compute_root_prefix(
    const char * root_path, size_t root_len, size_t & out_rl, size_t & out_prefix) {
    size_t rl = root_len;
    if (rl > 0 && (root_path[rl - 1] == '/' || root_path[rl - 1] == '\\'))
      --rl;
    out_rl = rl;
    out_prefix = rl + 1;
  }

  /**
   * Allocate a combined per-thread slab and pre-write the root prefix.
   *
   * Layout per thread: `[READ_BUFFER_SIZE | path_scratch_stride]`
   *
   * @param tc           Thread count.
   * @param root_path    Root directory (may have trailing separator).
   * @param root_len     Length of root_path.
   * @param max_seg_len  Longest relative path segment (from PathIndex).
   * @param out_slab     Receives the allocated slab (caller owns).
   * @param out_per_thread  Receives per-thread stride.
   * @param out_prefix_len  Receives prefix length for process_files.
   * @returns true on success, false on OOM.
   */
  FSH_FORCE_INLINE bool alloc_slab_with_scratch(
    int tc,
    const char * root_path, size_t root_len, size_t max_seg_len,
    AlignedPtr<unsigned char> & out_slab, size_t & out_per_thread,
    size_t & out_prefix_len, size_t & out_path_stride) {

    size_t rl, prefix_len;
    compute_root_prefix(root_path, root_len, rl, prefix_len);
    out_prefix_len = prefix_len;

    // Path scratch: prefix + max relative path + NUL, rounded to 64-byte boundary.
    const size_t path_stride = ((prefix_len + max_seg_len + 1) + 63) & ~size_t(63);
    out_path_stride = path_stride;

#ifdef _WIN32
    // On Windows, add a wchar_t scratch buffer for UTF-8 → UTF-16 conversion.
    // UTF-16 code-unit count ≤ UTF-8 byte count, so (prefix_len + max_seg_len + 1)
    // wchar_ts is always sufficient.  Aligned to 64 bytes.
    const size_t wpath_stride = (((prefix_len + max_seg_len + 1) * sizeof(wchar_t)) + 63) & ~size_t(63);
    out_per_thread = READ_BUFFER_SIZE + path_stride + wpath_stride;
#else
    out_per_thread = READ_BUFFER_SIZE + path_stride;
#endif

    AlignedPtr<unsigned char> slab(64, static_cast<size_t>(tc) * out_per_thread);
    if (!slab) [[unlikely]]
      return false;

    // Pre-write "rootPath/" into each thread's path scratch area.
    for (int i = 0; i < tc; ++i) {
      char * ps = reinterpret_cast<char *>(slab.ptr + static_cast<size_t>(i) * out_per_thread + READ_BUFFER_SIZE);
      memcpy(ps, root_path, rl);
#ifdef _WIN32
      ps[rl] = '\\';
#else
      ps[rl] = '/';
#endif
    }

    out_slab = std::move(slab);
    return true;
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
   *
   * Segments are relative paths (NUL-terminated pointers from PathIndex).
   * The root directory prefix is pre-written into each thread's scratch
   * buffer — only the relative tail is copied per file.
   */
  struct CacheStatMatchRunner {
    //  - Cache line 0: read-only config
    const char * const * segments;
    size_t file_count;
    uint8_t * entries_buf;
    const uint8_t * old_buf;
    uint8_t * file_states;
    const char * root_path;
    size_t root_len;
    size_t max_seg_len;
    size_t work_batch = 0;

    /** Per-thread argument block (lives on the caller's stack). */
    struct ThreadArg {
      CacheStatMatchRunner * self;
      unsigned char * base;
      size_t prefix_len;
      size_t path_stride;
    };

    /** Static thread entry point — no lambdas, no captures. */
    static void thread_proc(void * raw) {
      auto * a = static_cast<ThreadArg *>(raw);
      a->self->process_files(a->base, a->prefix_len, a->path_stride);
    }

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
      int hw = static_cast<int>(Thread::hardware_concurrency());
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

      // Allocate combined read-buffer + path-scratch slab, pre-write root prefix.
      AlignedPtr<unsigned char> slab;
      size_t per_thread, prefix_len, path_stride;
      if (!alloc_slab_with_scratch(tc, this->root_path, this->root_len, this->max_seg_len, slab, per_thread, prefix_len, path_stride))
          [[unlikely]]
        return false;

      g_active_hash_threads.fetch_add(tc, std::memory_order_relaxed);

      const int spawned = tc - 1;
      ThreadArg args[MAX_STACK_THREADS];
      Thread threads[MAX_STACK_THREADS];
      for (int i = 0; i < spawned; ++i) {
        auto * base = slab.ptr + static_cast<size_t>(i + 1) * per_thread;
        args[i] = {this, base, prefix_len, path_stride};
        threads[i] = Thread::create(thread_proc, &args[i]);
      }
      this->process_files(slab.ptr, prefix_len, path_stride);
      for (int i = 0; i < spawned; ++i)
        threads[i].join();

      g_active_hash_threads.fetch_sub(tc, std::memory_order_relaxed);
      return true;
    }

    /** Per-thread stat+match loop. */
    FSH_FORCE_INLINE void process_files(unsigned char * base, size_t prefix_len, size_t path_stride) const {
      unsigned char * const rbuf = assume_aligned<64>(base);
      char * const path_buf = reinterpret_cast<char *>(base + READ_BUFFER_SIZE);
      const size_t fc = this->file_count;
      const size_t wb = this->work_batch;
      uint8_t * const ent = this->entries_buf;
      const uint8_t * const old = this->old_buf;
      uint8_t * const states = this->file_states;
      const char * const * const segs = this->segments;

#ifdef _WIN32
      wchar_t * const wpath_scratch = reinterpret_cast<wchar_t *>(base + READ_BUFFER_SIZE + path_stride);
      const int wpath_cap = static_cast<int>(prefix_len + this->max_seg_len + 1);
#endif

      for (;;) {
        const size_t base_idx = this->next_index.fetch_add(wb, std::memory_order_relaxed);
        if (base_idx >= fc) [[unlikely]]
          break;
        const size_t batch_end = base_idx + wb < fc ? base_idx + wb : fc;

        for (size_t idx = base_idx; idx < batch_end; ++idx) {
          // Cooperative early exit — stop on first detected change.
          if (this->early_exit.load(std::memory_order_relaxed)) [[unlikely]]
            return;

          const char * const rel = segs[idx];
          const size_t eOff = idx * CACHE_ENTRY_STRIDE;

          // Prefetch next iteration's path string, old entry, and write-warm output slots.
          if (idx + 1 < batch_end) [[likely]] {
            FSH_PREFETCH(segs[idx + 1]);
            FSH_PREFETCH(old + (idx + 1) * CACHE_ENTRY_STRIDE);
            FSH_PREFETCH_W(ent + (idx + 1) * CACHE_ENTRY_STRIDE);
          }
          FSH_PREFETCH_W(ent + eOff);

          // Skip empty paths (rare: consecutive null terminators in pathsBuf).
          if (rel[0] == '\0') [[unlikely]] {
            memset(ent + eOff, 0, 32);
            states[idx] = CACHE_F_DONE;
            continue;
          }

          // Resolve: path_buf already holds "rootPath/", append relative path.
          copy_rel_path(path_buf + prefix_len, rel);

          // On Windows, convert the full path to UTF-16 once — used for
          // both stat and potential rehash, avoiding repeated conversion.
#ifdef _WIN32
          WPath wp(path_buf, wpath_scratch, wpath_cap);
          const auto * resolved_path = wp.data;
#else
          const auto * resolved_path = path_buf;
#endif

          // 1. stat() -> write 32-byte record to entries_buf
          const bool stat_ok = file_stat_to(resolved_path, ent + eOff);

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
              hash_file_to(resolved_path, ent + eOff + 32, rbuf);
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
   *
   * Like CacheStatMatchRunner, segments are relative paths with per-thread
   * scratch for root prefix prepend.
   */
  struct CacheCompleteRunner {
    const char * const * segments;
    size_t file_count;
    uint8_t * entries_buf;
    uint8_t * file_states;
    const char * root_path;
    size_t root_len;
    size_t max_seg_len;
    size_t work_batch = 0;

    /** Per-thread argument block (lives on the caller's stack). */
    struct ThreadArg {
      CacheCompleteRunner * self;
      unsigned char * base;
      size_t prefix_len;
      size_t path_stride;
    };

    /** Static thread entry point — no lambdas, no captures. */
    static void thread_proc(void * raw) {
      auto * a = static_cast<ThreadArg *>(raw);
      a->self->process_files(a->base, a->prefix_len, a->path_stride);
    }

    alignas(64) mutable std::atomic<size_t> next_index{0};

    /** Run parallel stat+hash.  Returns false on OOM only. */
    bool run(int concurrency) {
      int hw = static_cast<int>(Thread::hardware_concurrency());
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

      // Allocate combined read-buffer + path-scratch slab, pre-write root prefix.
      AlignedPtr<unsigned char> slab;
      size_t per_thread, prefix_len, path_stride;
      if (!alloc_slab_with_scratch(tc, this->root_path, this->root_len, this->max_seg_len, slab, per_thread, prefix_len, path_stride))
          [[unlikely]]
        return false;

      g_active_hash_threads.fetch_add(tc, std::memory_order_relaxed);

      const int spawned = tc - 1;
      ThreadArg args[MAX_STACK_THREADS];
      Thread threads[MAX_STACK_THREADS];
      for (int i = 0; i < spawned; ++i) {
        auto * base = slab.ptr + static_cast<size_t>(i + 1) * per_thread;
        args[i] = {this, base, prefix_len, path_stride};
        threads[i] = Thread::create(thread_proc, &args[i]);
      }
      this->process_files(slab.ptr, prefix_len, path_stride);
      for (int i = 0; i < spawned; ++i)
        threads[i].join();

      g_active_hash_threads.fetch_sub(tc, std::memory_order_relaxed);
      return true;
    }

    /** Per-thread stat+hash loop for remaining entries. */
    FSH_FORCE_INLINE void process_files(unsigned char * base, size_t prefix_len, size_t path_stride) const {
      unsigned char * const rbuf = assume_aligned<64>(base);
      char * const path_buf = reinterpret_cast<char *>(base + READ_BUFFER_SIZE);
      const size_t fc = this->file_count;
      const size_t wb = this->work_batch;
      uint8_t * const ent = this->entries_buf;
      uint8_t * const states = this->file_states;
      const char * const * const segs = this->segments;

#ifdef _WIN32
      wchar_t * const wpath_scratch = reinterpret_cast<wchar_t *>(base + READ_BUFFER_SIZE + path_stride);
      const int wpath_cap = static_cast<int>(prefix_len + this->max_seg_len + 1);
#endif

      for (;;) {
        const size_t base_idx = this->next_index.fetch_add(wb, std::memory_order_relaxed);
        if (base_idx >= fc) [[unlikely]]
          break;
        const size_t batch_end = base_idx + wb < fc ? base_idx + wb : fc;

        for (size_t idx = base_idx; idx < batch_end; ++idx) {
          const uint8_t state = states[idx];
          if (state == CACHE_F_DONE) [[likely]]
            continue;

          const char * const rel = segs[idx];
          const size_t eOff = idx * CACHE_ENTRY_STRIDE;

          // Prefetch next non-done entry's path and write-warm its output slot.
          if (idx + 1 < batch_end) [[likely]] {
            FSH_PREFETCH(segs[idx + 1]);
            FSH_PREFETCH_W(ent + (idx + 1) * CACHE_ENTRY_STRIDE);
          }
          FSH_PREFETCH_W(ent + eOff);

          // Skip empty paths.
          if (rel[0] == '\0') [[unlikely]] {
            continue;
          }

          // Resolve: path_buf already holds "rootPath/", append relative path.
          copy_rel_path(path_buf + prefix_len, rel);

          // On Windows, convert the full path to UTF-16 once — used for
          // both stat and rehash, avoiding repeated conversion.
#ifdef _WIN32
          WPath wp(path_buf, wpath_scratch, wpath_cap);
          const auto * resolved_path = wp.data;
#else
          const auto * resolved_path = path_buf;
#endif

          if (state == CACHE_F_HAS_OLD) {
            // Old entry (stat + hash) pre-populated in entries_buf from remapped cache.
            // Re-stat into temp, compare with old stat — if unchanged, hash is valid.
            uint8_t tmp[32];
            const bool sok = file_stat_to(resolved_path, tmp);
            if (sok && memcmp(tmp, ent + eOff, 32) == 0) [[likely]] {
              // Stat unchanged — hash at eOff+32 is still valid.
              states[idx] = CACHE_F_DONE;
              continue;
            }
            // Overwrite stat section.
            memcpy(ent + eOff, tmp, 32);
            if (sok) [[likely]] {
              // Stat changed — rehash.
              hash_file_to(resolved_path, ent + eOff + 32, rbuf);
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
            if (!file_stat_to(resolved_path, ent + eOff)) {
              // Stat failed — entry zeroed by file_stat_to, zero hash too.
              memset(ent + eOff + 32, 0, 16);
              // State stays F_NOT_CHECKED (changed).
              continue;
            }
          }

          hash_file_to(resolved_path, ent + eOff + 32, rbuf);
          // State stays as original (F_NOT_CHECKED or F_NEED_HASH — changed).
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
