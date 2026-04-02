/**
 * hash-file-helpers.h — Shared file hashing helpers for PathResolver.
 *
 * Extracted from FfshFilePosix.h / FfshFileWin32.h to avoid duplication.
 * Depends on FfshFile (platform-specific) and Hash128 — must be included
 * inside namespace fast_fs_hash, after FfshFile is defined.
 */

#ifndef _FAST_FS_HASH_HASH_FILE_HELPERS_H
#define _FAST_FS_HASH_HASH_FILE_HELPERS_H

/** Large-file streaming hash — cold path, kept out-of-line to avoid
 *  putting the 576-byte XXH3_state_t on every caller's stack frame. */
static FSH_NO_INLINE void hash_large_file(
  FfshFile & rf, Hash128 & dest, unsigned char * rbuf, size_t initial_bytes, size_t rbs) noexcept {
  XXH3_state_t state;
  XXH3_128bits_reset(&state);
  XXH3_128bits_update(&state, rbuf, initial_bytes);
  for (;;) {
    const int64_t nr = rf.read(rbuf, rbs);
    if (nr <= 0) [[unlikely]] {
      if (nr == 0) [[likely]] {
        dest.from_xxh128(XXH3_128bits_digest(&state));
      } else {
        dest.set_zero();
      }
      return;
    }
    XXH3_128bits_update(&state, rbuf, static_cast<size_t>(nr));
  }
}

/** Hash an already-open file. Small files (< rbs) are hashed in one shot;
 *  large files fall through to the out-of-line streaming path. */
static FSH_FORCE_INLINE void hash_open_file(FfshFile & rf, Hash128 & dest, unsigned char * rbuf, size_t rbs) noexcept {
  const int64_t n = rf.read_at_most(rbuf, rbs);
  if (n < 0) [[unlikely]] {
    dest.set_zero();
    return;
  }
  const size_t bytes = static_cast<size_t>(n);
  if (bytes < rbs) [[likely]] {
    dest.from_xxh128(XXH3_128bits(rbuf, bytes));
    return;
  }
  hash_large_file(rf, dest, rbuf, rbs, rbs);
}

#endif
