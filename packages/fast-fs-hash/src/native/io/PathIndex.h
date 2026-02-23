#ifndef _FAST_FS_HASH_PATH_INDEX_H
#define _FAST_FS_HASH_PATH_INDEX_H

#include "includes.h"

/**
 * Check whether a NUL-terminated relative path segment is unsafe.
 *
 * Detects directory traversal, absolute paths, and embedded NUL bytes
 * (the segment is already NUL-terminated so we check for interior NULs
 * only via the caller-provided length).
 *
 * Mirrors the JS `isUnsafeRelativePath()` in path-utils.ts.
 */
FSH_FORCE_INLINE bool is_unsafe_relative_path(const uint8_t * seg, size_t len) noexcept {
  if (len == 0) {
    return false;
  }

  // Absolute paths: leading '/' or '\'
  if (seg[0] == '/' || seg[0] == '\\') {
    return true;
  }

  // Windows drive letter (e.g. "C:")
  if (len >= 2 && seg[1] == ':') {
    return true;
  }

  // ".." at start
  if (seg[0] == '.' && len >= 2 && seg[1] == '.') {
    if (len == 2) {
      return true;
    }
    if (seg[2] == '/' || seg[2] == '\\') {
      return true;
    }
  }

  // Scan for embedded traversal: /../, \..\, /..\ , \../ , trailing /.. or \..
  // Also reject interior NUL bytes (should not appear in valid paths).
  for (size_t i = 1; i < len; ++i) {
    const uint8_t c = seg[i];
    if (c == '\0') {
      return true;
    }
    // Check for "/.." or "\.." starting at i-1
    if (c == '.' && i + 1 < len && seg[i + 1] == '.') {
      const uint8_t prev = seg[i - 1];
      if (prev == '/' || prev == '\\') {
        // "/.." or "\.." found — check what follows
        if (i + 2 >= len) {
          return true;  // trailing "/.."|"\.."
        }
        const uint8_t next = seg[i + 2];
        if (next == '/' || next == '\\') {
          return true;  // "/../"|"/..\"|"\..\"|"\\../"
        }
      }
    }
  }

  return false;
}

/**
 * Pre-computed path pointers into a null-separated buffer.
 * Skips the last segment if it lacks a trailing \0.
 *
 * When maxCount is bounded (cache workers), allocates upfront
 * and fills in a single memchr pass. When unbounded (SIZE_MAX),
 * counts nulls first for an exact-sized allocation.
 *
 * After construction, `max_seg_len` holds the length of the longest
 * segment (in bytes, excluding the NUL terminator). Callers can use
 * this to pre-allocate scratch buffers for path resolution.
 *
 * @tparam ValidatePaths  When `true`, each segment is checked for
 *   directory traversal attacks during the fill pass. If any unsafe
 *   path is found, `has_unsafe()` returns `true` after construction.
 *   The index is still fully built — callers should check `has_unsafe()`
 *   and reject the data before processing paths.
 */
template <bool ValidatePaths = false>
struct PathIndex : NonCopyable {
  size_t count;
  const char ** segments;
  size_t max_seg_len;

  /** True if the constructor failed to allocate despite non-empty input (OOM). */
  FSH_FORCE_INLINE bool oom() const noexcept { return this->oom_; }

  /** True if any segment contains a path traversal sequence. Only meaningful when ValidatePaths=true. */
  FSH_FORCE_INLINE bool has_unsafe() const noexcept { return this->has_unsafe_; }

  PathIndex() noexcept : count(0), segments(nullptr), max_seg_len(0), oom_(false), has_unsafe_(false) {}

  inline PathIndex(const uint8_t * buf, size_t len, size_t maxCount = SIZE_MAX) noexcept :
    count(0), segments(nullptr), max_seg_len(0), oom_(false), has_unsafe_(false) {
    this->init(buf, len, maxCount);
  }

  /** Initialize or re-initialize from a null-separated buffer. */
  inline void init(const uint8_t * buf, size_t len, size_t maxCount = SIZE_MAX) noexcept {
    free(this->segments);
    this->segments = nullptr;
    this->count = 0;
    this->max_seg_len = 0;
    this->oom_ = false;
    this->has_unsafe_ = false;

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

    // Single fill pass — also track the longest segment.
    const char ** dst = this->segments;
    const char ** const dstEnd = this->segments + n;
    size_t maxLen = 0;
    for (const uint8_t * p = buf; p < end && dst < dstEnd;) {
      const uint8_t * nul = static_cast<const uint8_t *>(memchr(p, 0, static_cast<size_t>(end - p)));
      if (!nul) {
        break;
      }
      *dst++ = reinterpret_cast<const char *>(p);
      const size_t segLen = static_cast<size_t>(nul - p);
      if (segLen > maxLen) {
        maxLen = segLen;
      }
      // Validate path safety during the same pass (compile-time branch).
      if constexpr (ValidatePaths) {
        if (!this->has_unsafe_ && is_unsafe_relative_path(p, segLen)) {
          this->has_unsafe_ = true;
        }
      }
      p = nul + 1;
    }
    this->count = static_cast<size_t>(dst - this->segments);
    this->max_seg_len = maxLen;
    this->segments[this->count] = nullptr;  // sentinel
  }

  inline ~PathIndex() { free(this->segments); }

 private:
  bool oom_;
  bool has_unsafe_;
};

#endif