#ifndef _FAST_FS_HASH_OWNED_BUF_H
#define _FAST_FS_HASH_OWNED_BUF_H

#include "includes.h"

namespace fast_fs_hash {

  /**
   * RAII wrapper for a malloc'd buffer with tracked length.
   * Move-only. Automatically frees on destruction.
   * Supports release (transfer ownership out).
   *
   * Template parameter T is the element type (default: uint8_t).
   * Length is in elements, not bytes.
   */
  template <typename T = uint8_t>
  struct OwnedBuf : NonCopyable {
    T * ptr = nullptr;
    size_t len = 0;

    inline OwnedBuf() noexcept = default;

    /** Allocate zeroed buffer of `count` elements (calloc). */
    static inline OwnedBuf calloc(size_t count) noexcept {
      OwnedBuf b;
      if (count > 0) {
        b.ptr = static_cast<T *>(::calloc(count, sizeof(T)));
        if (b.ptr) {
          b.len = count;
        }
      }
      return b;
    }

    /** Allocate uninitialized buffer of `count` elements (malloc). */
    static inline OwnedBuf alloc(size_t count) noexcept {
      OwnedBuf b;
      if (count > 0) {
        if constexpr (sizeof(T) > 1) {
          if (count > SIZE_MAX / sizeof(T)) [[unlikely]] {
            return b;
          }
        }
        b.ptr = static_cast<T *>(::malloc(count * sizeof(T)));
        if (b.ptr) {
          b.len = count;
        }
      }
      return b;
    }

    /** Take ownership of an existing malloc'd pointer. */
    static inline OwnedBuf take(T * p, size_t count) noexcept {
      OwnedBuf b;
      b.ptr = p;
      b.len = p ? count : 0;
      return b;
    }

    inline ~OwnedBuf() noexcept { ::free(this->ptr); }

    FSH_FORCE_INLINE OwnedBuf(OwnedBuf && o) noexcept : ptr(o.ptr), len(o.len) {
      o.ptr = nullptr;
      o.len = 0;
    }

    FSH_FORCE_INLINE OwnedBuf & operator=(OwnedBuf && o) noexcept {
      if (this != &o) [[likely]] {
        ::free(this->ptr);
        this->ptr = o.ptr;
        this->len = o.len;
        o.ptr = nullptr;
        o.len = 0;
      }
      return *this;
    }

    FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->ptr != nullptr; }

    /** Release ownership — caller must free(). */
    inline T * release() noexcept {
      T * p = this->ptr;
      this->ptr = nullptr;
      this->len = 0;
      return p;
    }

    /** Reset to empty, freeing the current buffer. */
    inline void reset() noexcept {
      ::free(this->ptr);
      this->ptr = nullptr;
      this->len = 0;
    }
  };

}  // namespace fast_fs_hash

#endif
