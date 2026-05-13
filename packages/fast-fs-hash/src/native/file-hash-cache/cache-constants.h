#ifndef _FAST_FS_HASH_CACHE_CONSTANTS_H
#define _FAST_FS_HASH_CACHE_CONSTANTS_H

#include "includes.h"

namespace fast_fs_hash {

  /** Stat-match aggregate result across all worker threads. Ordered by severity. */
  enum class MatchResult : uint32_t {
    OK = 0,  // all entries matched
    STAT_DIRTY = 1,  // stat metadata changed but content hash still matches
    CHANGED = 2,  // content changed (size or hash mismatch)
  };

  /**
   * Per-file state encoded in high 2 bits of CacheEntry::ino.
   * Real inode occupies the lower 62 bits (no filesystem uses >62-bit inodes).
   * stat_into always clears the high 2 bits, so disk data is clean.
   * ino == 0 naturally means NOT_CHECKED (calloc'd entry).
   */
  static constexpr unsigned INO_STATE_SHIFT = 62;
  static constexpr uint64_t INO_STATE_MASK = 3ULL << INO_STATE_SHIFT;
  static constexpr uint64_t INO_CHANGED_BIT = 1ULL << 61;  // content changed from cached version
  static constexpr uint64_t INO_VALUE_MASK = ~(INO_STATE_MASK | INO_CHANGED_BIT);

  static constexpr uint64_t CACHE_S_NOT_CHECKED = 0;
  static constexpr uint64_t CACHE_S_DONE = 1ULL << INO_STATE_SHIFT;
  static constexpr uint64_t CACHE_S_HAS_OLD = 2ULL << INO_STATE_SHIFT;
  static constexpr uint64_t CACHE_S_STAT_DONE = 3ULL << INO_STATE_SHIFT;

  static constexpr uint32_t CACHE_MAX_FILE_COUNT = 1048576u;  // 1M files
  static constexpr uint32_t CACHE_MAX_PATHS_LEN = 128u << 20;  // 128 MiB
  static constexpr uint32_t CACHE_MAX_COMPRESSED_PAYLOADS = 128u << 20;  // 128 MiB
  static constexpr uint32_t CACHE_MAX_UNCOMPRESSED_PAYLOADS = 128u << 20;  // 128 MiB
  static constexpr size_t CACHE_MAX_BODY_SIZE = 512u << 20;  // 512 MiB (total body)
  static constexpr size_t CACHE_MAX_FILE_SIZE = 512u << 20;  // 512 MiB (on-disk file)

  static constexpr size_t MIN_DIR_FD_FILES = 4;

  /** Minimum files in a SINGLE DIRECTORY before the macOS stat hot path
   *  promotes that directory to a getattrlistbulk job. Evaluated per
   *  directory — small dirs always stay on the per-file fstatat path even
   *  if other dirs cross the threshold.
   *
   *  Set high enough that bulk wins NET of the ~1 µs dir-bloat probe cost
   *  (see STAT_BULK_MAX_DIR_BLOAT). Bulk speedup vs N×fstatat on macOS
   *  arm64: ~0.95× at N=16, ~1.3× at N=32, ~1.7× at N=64. N=24 lands in
   *  the early-positive zone where bulk modestly beats fstatat even after
   *  paying the probe; lower thresholds risk net regression on borderline
   *  dirs. Tunable via FAST_FS_HASH_BULK_STAT_MIN env var. */
  static constexpr size_t STAT_BULK_PER_DIR_MIN = 20;

  /** Maximum allowed ratio of total directory entries to tracked entries
   *  before bulk-stat is rejected for a given directory. If a dir holds
   *  10× more siblings than we care about, the bulk enumeration returns
   *  mostly untracked names (we'd burn CPU on lookups that never match)
   *  and per-file fstatat wins. 8× tracks empirical micro-bench numbers:
   *  bulk's per-entry cost is ~500 ns regardless of match; lower_bound
   *  over our small sorted vec is ~10 ns. At 8× untracked the wasted
   *  per-entry work approaches the savings vs fstatat. */
  static constexpr size_t STAT_BULK_MAX_DIR_BLOAT = 8;

}  // namespace fast_fs_hash

#endif
