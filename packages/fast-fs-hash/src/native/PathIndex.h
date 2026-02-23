#ifndef _FAST_FS_HASH_PATH_INDEX_H
#define _FAST_FS_HASH_PATH_INDEX_H

#include "includes.h"

/**
 * Pre-computed path pointers into a null-separated buffer.
 * Skips the last segment if it lacks a trailing \0.
 *
 * When maxCount is bounded (cache workers), allocates upfront
 * and fills in a single memchr pass. When unbounded (SIZE_MAX),
 * counts nulls first for an exact-sized allocation.
 */
struct PathIndex : NonCopyable {
  size_t count;
  const char ** segments;

  /** True if the constructor failed to allocate despite non-empty input (OOM). */
  FSH_FORCE_INLINE bool oom() const noexcept { return this->oom_; }

  inline PathIndex(const uint8_t * buf, size_t len, size_t maxCount = SIZE_MAX) noexcept :
    count(0), segments(nullptr), oom_(false) {
    if (len == 0 || buf == nullptr || maxCount == 0) {
      return;
    }

    const uint8_t * const end = buf + len;

    // Determine allocation size: bounded -> maxCount, unbounded -> count nulls.
    size_t n;
    if (maxCount != SIZE_MAX) {
      n = maxCount;
    } else {
      n = 0;
      for (const uint8_t * p = buf; p < end;) {
        p = static_cast<const uint8_t *>(memchr(p, 0, static_cast<size_t>(end - p)));
        if (!p) {
          break;
        }
        ++n;
        ++p;
      }
      if (n == 0) {
        return;
      }
    }

    // Allocate n + 1 slots (n pointers + nullptr sentinel for prefetch).
    this->segments = static_cast<const char **>(malloc((n + 1) * sizeof(const char *)));
    if (!this->segments) [[unlikely]] {
      this->oom_ = true;
      return;
    }

    // Single fill pass.
    const char ** dst = this->segments;
    const char ** const dstEnd = this->segments + n;
    for (const uint8_t * p = buf; p < end && dst < dstEnd;) {
      const uint8_t * nul = static_cast<const uint8_t *>(memchr(p, 0, static_cast<size_t>(end - p)));
      if (!nul) {
        break;
      }
      *dst++ = reinterpret_cast<const char *>(p);
      p = nul + 1;
    }
    this->count = static_cast<size_t>(dst - this->segments);
    this->segments[this->count] = nullptr;  // sentinel
  }

  inline ~PathIndex() { free(this->segments); }

 private:
  bool oom_;
};

#endif