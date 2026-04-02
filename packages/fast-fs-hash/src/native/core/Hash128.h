#ifndef _FAST_FS_HASH_HASH128_H
#define _FAST_FS_HASH_HASH128_H

#include "includes.h"

namespace fast_fs_hash {

  /**
   * 128-bit hash value. Two implementations chosen at compile time:
   *   - __uint128_t platforms: single-register zero/compare/assign.
   *   - Others: dual uint64_t with byte overlay for serialization.
   * All writes go through the primary storage member, avoiding UB.
   */
#if defined(__SIZEOF_INT128__)

  union Hash128 {
    __uint128_t u128;
    uint8_t bytes[16];

    FSH_FORCE_INLINE bool is_zero() const noexcept { return this->u128 == 0; }
    FSH_FORCE_INLINE void set_zero() noexcept { this->u128 = 0; }

    FSH_FORCE_INLINE bool operator==(const Hash128 & other) const noexcept { return this->u128 == other.u128; }
    FSH_FORCE_INLINE bool operator!=(const Hash128 & other) const noexcept { return this->u128 != other.u128; }

    FSH_FORCE_INLINE void from_xxh128(XXH128_hash_t h) noexcept {
      // XXH128_hash_t {low64, high64} has identical memory layout to __uint128_t
      // on little-endian (all target platforms). memcpy compiles to a single
      // 128-bit store (STP on ARM64, MOVUPS on x86) — no shift/or decomposition.
      static_assert(sizeof(h) == 16);
      memcpy(this, &h, 16);
    }

    FSH_FORCE_INLINE void from_xxh128_canonical(XXH128_hash_t h) noexcept {
      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->bytes), h);
    }
  };

#else

  union Hash128 {
    uint64_t u64[2];
    uint8_t bytes[16];

    FSH_FORCE_INLINE bool is_zero() const noexcept { return (this->u64[0] | this->u64[1]) == 0; }
    FSH_FORCE_INLINE void set_zero() noexcept {
      this->u64[0] = 0;
      this->u64[1] = 0;
    }

    FSH_FORCE_INLINE bool operator==(const Hash128 & other) const noexcept {
      return this->u64[0] == other.u64[0] && this->u64[1] == other.u64[1];
    }
    FSH_FORCE_INLINE bool operator!=(const Hash128 & other) const noexcept {
      return this->u64[0] != other.u64[0] || this->u64[1] != other.u64[1];
    }

    FSH_FORCE_INLINE void from_xxh128(XXH128_hash_t h) noexcept {
      this->u64[0] = h.low64;
      this->u64[1] = h.high64;
    }

    FSH_FORCE_INLINE void from_xxh128_canonical(XXH128_hash_t h) noexcept {
      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->bytes), h);
    }
  };

#endif

  static_assert(sizeof(Hash128) == 16);
  static_assert(sizeof(XXH128_hash_t) == 16);

}  // namespace fast_fs_hash

#endif
