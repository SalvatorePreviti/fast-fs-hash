#ifndef _FAST_FS_HASH_CACHE_CONSTANTS_H
#define _FAST_FS_HASH_CACHE_CONSTANTS_H

#include "includes.h"

namespace fast_fs_hash {

  /** Stat-match aggregate result across all worker threads. Ordered by severity. */
  enum class MatchResult : uint32_t {
    OK = 0,          // all entries matched
    STAT_DIRTY = 1,  // stat metadata changed but content hash still matches
    CHANGED = 2,     // content changed (size or hash mismatch)
  };

  /**
   * Per-file state encoded in high 2 bits of CacheEntry::ino.
   * Real inode occupies the lower 62 bits (no filesystem uses >62-bit inodes).
   * stat_into always clears the high 2 bits, so disk data is clean.
   * ino == 0 naturally means NOT_CHECKED (calloc'd entry).
   */
  static constexpr unsigned INO_STATE_SHIFT = 62;
  static constexpr uint64_t INO_STATE_MASK = 3ULL << INO_STATE_SHIFT;
  static constexpr uint64_t INO_VALUE_MASK = ~INO_STATE_MASK;

  static constexpr uint64_t CACHE_S_NOT_CHECKED = 0;
  static constexpr uint64_t CACHE_S_DONE        = 1ULL << INO_STATE_SHIFT;
  static constexpr uint64_t CACHE_S_HAS_OLD     = 2ULL << INO_STATE_SHIFT;
  static constexpr uint64_t CACHE_S_STAT_DONE   = 3ULL << INO_STATE_SHIFT;

  // ── Format limits ──────────────────────────────────────────────────

  static constexpr uint32_t CACHE_MAX_FILE_COUNT = 1048576u;   // 1M files
  static constexpr uint32_t CACHE_MAX_PATHS_LEN = 128u << 20;  // 128 MiB
  static constexpr uint32_t CACHE_MAX_UD_PAYLOADS = 64u << 20; // 64 MiB
  static constexpr size_t CACHE_MAX_BODY_SIZE = 256u << 20;     // 256 MiB (total body)
  static constexpr size_t CACHE_MAX_FILE_SIZE = 256u << 20;     // 256 MiB (on-disk file)


  // ── dir_fd heuristic ──────────────────────────────────────────────

  static constexpr size_t MIN_DIR_FD_FILES = 8;

}  // namespace fast_fs_hash

#endif
