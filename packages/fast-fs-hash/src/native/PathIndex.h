#ifndef _FAST_FS_HASH_PATH_INDEX_H
#define _FAST_FS_HASH_PATH_INDEX_H

#include "includes.h"

/**
 * Pre-computed path pointers into a null-separated buffer.
 * Skips the last segment if it lacks a trailing \0.
 * Two-pass: count nulls via memchr, exact malloc, fill pointers.
 */
struct PathIndex : NonCopyable {
  size_t count;
  const char ** segments;

  inline PathIndex(const uint8_t * buf, size_t len) noexcept : count(0), segments(nullptr) {
    if (len == 0 || buf == nullptr) {
      return;
    }

    const uint8_t * const end = buf + len;

    // Pass 1: count \0 terminators.
    size_t n = 0;
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

    // Allocate n + 1 slots: n real pointers + nullptr sentinel for prefetch.
    this->segments = static_cast<const char **>(malloc((n + 1) * sizeof(const char *)));
    if (!this->segments) {
      return;
    }
    this->segments[n] = nullptr;  // sentinel — prefetch of nullptr is harmless

    // Pass 2: fill pointers.
    const char ** dst = this->segments;
    for (const uint8_t * p = buf; p < end;) {
      const uint8_t * nul = static_cast<const uint8_t *>(memchr(p, 0, static_cast<size_t>(end - p)));
      if (!nul) {
        break;
      }
      *dst++ = reinterpret_cast<const char *>(p);
      p = nul + 1;
    }
    this->count = static_cast<size_t>(dst - this->segments);
  }

  inline ~PathIndex() { free(this->segments); }
};

#endif