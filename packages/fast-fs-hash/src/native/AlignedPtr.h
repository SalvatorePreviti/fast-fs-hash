/**
 * AlignedPtr — RAII wrapper for cache-line-aligned heap allocations.
 *
 * Provides portable aligned_malloc / aligned_free and a move-only
 * smart pointer (AlignedPtr<T>) that automatically frees on scope exit.
 */

#ifndef _FAST_FS_HASH_ALIGNED_PTR_H
#define _FAST_FS_HASH_ALIGNED_PTR_H

#include "includes.h"

/** RAII wrapper for aligned_malloc / aligned_free.  Zero-overhead unique_ptr
 *  for cache-line-aligned buffers — move-only, automatically frees on scope exit. */
template <typename T = void>
struct AlignedPtr : NonCopyable {
  T * ptr = nullptr;

  AlignedPtr() noexcept = default;
  explicit AlignedPtr(size_t alignment, size_t size) noexcept : ptr(static_cast<T *>(aligned_malloc(alignment, size))) {}

  ~AlignedPtr() noexcept { aligned_free(this->ptr); }

  FSH_FORCE_INLINE AlignedPtr(AlignedPtr && o) noexcept : ptr(o.ptr) { o.ptr = nullptr; }
  FSH_FORCE_INLINE AlignedPtr & operator=(AlignedPtr && o) noexcept {
    if (this != &o) [[likely]] {
      aligned_free(this->ptr);
      this->ptr = o.ptr;
      o.ptr = nullptr;
    }
    return *this;
  }

  FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->ptr != nullptr; }
  FSH_FORCE_INLINE T * release() noexcept {
    T * p = this->ptr;
    this->ptr = nullptr;
    return p;
  }
};

#endif
