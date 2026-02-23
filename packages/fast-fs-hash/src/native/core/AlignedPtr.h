#ifndef _FAST_FS_HASH_ALIGNED_PTR_H
#define _FAST_FS_HASH_ALIGNED_PTR_H

#include "includes.h"

/** RAII wrapper for aligned_malloc / aligned_free.  Zero-overhead unique_ptr
 *  for cache-line-aligned buffers — move-only, automatically frees on scope exit.
 *  Constructor takes element count — allocation size is count × sizeof(T). */
template <typename T = unsigned char>
struct AlignedPtr : NonCopyable {
  T * ptr = nullptr;

  AlignedPtr() noexcept = default;
  explicit AlignedPtr(size_t alignment, size_t count) noexcept {
    if (count == 0) [[unlikely]] {
      return;
    }
    constexpr size_t kElemSize = sizeof(T);
    if (count > (SIZE_MAX / kElemSize)) [[unlikely]] {
      return;
    }
    this->ptr = static_cast<T *>(aligned_malloc(alignment, count * kElemSize));
  }

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
