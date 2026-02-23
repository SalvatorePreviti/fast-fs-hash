#ifndef _FAST_FS_HASH_HASH128_H
#define _FAST_FS_HASH_HASH128_H

#include "includes.h"

namespace fast_fs_hash {

  /**
   * 128-bit hash value with multi-typed access via union:
   *   - bytes[16] for serialization / byte-level access
   *   - u64[2] for fast comparison and zeroing (2 loads on all platforms)
   *   - xxh for direct XXH128_hash_t assignment (no memcpy)
   *   - u128 for single-instruction ops where __uint128_t is available
   *
   * Always 16 bytes. Layout-compatible with XXH128_hash_t on LE platforms.
   */
  union Hash128 {
#if defined(__SIZEOF_INT128__)
    __uint128_t u128;
#endif
    XXH128_hash_t xxh;
    uint64_t u64[2];
    uint8_t bytes[16];

    FSH_FORCE_INLINE bool is_zero() const noexcept {
#if defined(__SIZEOF_INT128__)
      return this->u128 == 0;
#else
      return (this->u64[0] | this->u64[1]) == 0;
#endif
    }

    FSH_FORCE_INLINE void set_zero() noexcept {
#if defined(__SIZEOF_INT128__)
      this->u128 = 0;
#else
      this->u64[0] = 0;
      this->u64[1] = 0;
#endif
    }

    FSH_FORCE_INLINE bool operator==(const Hash128 & other) const noexcept {
#if defined(__SIZEOF_INT128__)
      return this->u128 == other.u128;
#else
      return this->u64[0] == other.u64[0] && this->u64[1] == other.u64[1];
#endif
    }

    FSH_FORCE_INLINE bool operator!=(const Hash128 & other) const noexcept {
#if defined(__SIZEOF_INT128__)
      return this->u128 != other.u128;
#else
      return this->u64[0] != other.u64[0] || this->u64[1] != other.u64[1];
#endif
    }

    /** Write an XXH128 result (native/LE endian for cache internal use). */
    FSH_FORCE_INLINE void from_xxh128(XXH128_hash_t h) noexcept { this->xxh = h; }

    /** Write an XXH128 result in canonical (big-endian) form for public API output. */
    FSH_FORCE_INLINE void from_xxh128_canonical(XXH128_hash_t h) noexcept {
      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this), h);
    }
  };

  static_assert(sizeof(Hash128) == 16);
  static_assert(sizeof(XXH128_hash_t) == 16);

}  // namespace fast_fs_hash

#endif
