#ifndef _FAST_FS_HASH_CACHE_HELPERS_H
#define _FAST_FS_HASH_CACHE_HELPERS_H

#include "cache-constants.h"

#include <algorithm>

namespace fast_fs_hash {

  /** Max threads for CacheOpen (mostly stat, occasional read+hash on change).
   *  Fewer threads optimal — stat() is kernel-bound, more threads = VFS contention. */
  static constexpr int MAX_OPEN_THREADS = 4;

  /** Max threads for CacheWriter (stat + read + hash on all unresolved entries).
   *  More threads than open — heavier I/O benefits from deeper queue depth. */
  static constexpr int MAX_WRITE_THREADS = 8;

  /** Compute batch size for work-stealing and clamp threadCount to useful range. */
  inline size_t computeBatchSize(int & threadCount, size_t fileCount) {
    const size_t batch = std::clamp(fileCount / static_cast<size_t>(threadCount * 8), size_t{4}, size_t{64});

    const int maxUseful = static_cast<int>((fileCount + batch - 1) / batch);
    if (threadCount > maxUseful) {
      threadCount = maxUseful;
    }
    if (threadCount < 1) [[unlikely]] {
      threadCount = 1;
    }

    return batch;
  }

}  // namespace fast_fs_hash

#endif
