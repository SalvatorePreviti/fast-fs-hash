#ifndef _FAST_FS_HASH_OUTPUT_BUFFER_H
#define _FAST_FS_HASH_OUTPUT_BUFFER_H

#include "includes.h"

/**
 * RAII wrapper for a hash output buffer that may be:
 *  - Owned (we malloc'd it — freed by destructor)
 *  - External (caller-provided — never freed by us)
 *
 * Supports releasing ownership for zero-copy transfer to Napi::Buffer.
 */
struct OutputBuffer : NonCopyable {
  uint8_t * data = nullptr;
  size_t len = 0;

  OutputBuffer() = default;
  ~OutputBuffer() {
    if (this->owned_) aligned_free(this->data);
  }

  /** Allocate an owned buffer. Returns true on success, false on OOM. */
  FSH_FORCE_INLINE bool allocate(size_t alignment, size_t size) noexcept {
    this->data = static_cast<uint8_t *>(aligned_malloc(alignment, size));
    this->len = size;
    this->owned_ = true;
    return this->data != nullptr;
  }

  FSH_FORCE_INLINE void free() noexcept {
    if (this->owned_) {
      this->owned_ = false;
      aligned_free(this->data);
      this->data = nullptr;
      this->len = 0;
    }
  }

  /** Attach an externally-owned buffer (will NOT be freed). */
  FSH_FORCE_INLINE void set_external(uint8_t * p, size_t n) noexcept {
    if (this->owned_) {
      this->owned_ = false;
      aligned_free(this->data);
    }
    this->data = p;
    this->len = n;
  }

  /** Release ownership — returns the pointer, caller is now responsible for freeing. */
  FSH_FORCE_INLINE uint8_t * release() noexcept {
    this->owned_ = false;
    return this->data;
  }

  /** True if we own the buffer (will free on destruction). */
  FSH_FORCE_INLINE bool owned() const noexcept { return this->owned_; }

 private:
  bool owned_ = false;
};

#endif
