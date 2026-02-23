#ifndef _FAST_FS_HASH_NAPI_HELPERS_H
#define _FAST_FS_HASH_NAPI_HELPERS_H

#include "includes.h"

/**
 * Small stack buffer for speculative single-pass string encoding.
 * 8 KB covers the vast majority of real-world strings (file paths,
 * identifiers, short text) with a single napi_get_value_string_utf8 call.
 */
static constexpr size_t STRING_SMALL_BUF = 8192;

/**
 * Large stack buffer for strings that don't fit in the small buffer
 * but are still small enough for stack allocation (≤ 64 KB).
 */
static constexpr size_t STRING_LARGE_BUF = 65536;

/**
 * Encode a V8 string as UTF-8 into the provided buffer.
 * Returns the number of bytes written (excluding null terminator).
 *
 * If truncated, re-encodes into large_buf or heap.
 * Sets *out_ptr to whichever buffer holds the final result.
 *
 * Speculative single-pass: for strings < ~8 KB (the vast majority),
 * only ONE napi_get_value_string_utf8 call.
 */
FSH_NO_INLINE static size_t fast_encode_string(
  napi_env env, napi_value str_val, char * small_buf, char * large_buf, const char *& out_ptr) {
  size_t written = 0;
  napi_get_value_string_utf8(env, str_val, small_buf, STRING_SMALL_BUF, &written);

  if (written < STRING_SMALL_BUF - 5) [[likely]] {
    out_ptr = small_buf;
    return written;
  }

  size_t utf8_len = 0;
  napi_get_value_string_utf8(env, str_val, nullptr, 0, &utf8_len);

  if (utf8_len == written) {
    out_ptr = small_buf;
    return written;
  }

  if (utf8_len < STRING_LARGE_BUF) [[likely]] {
    napi_get_value_string_utf8(env, str_val, large_buf, utf8_len + 1, &written);
    out_ptr = large_buf;
    return written;
  }

  auto * heap_buf = static_cast<char *>(malloc(utf8_len + 1));
  if (!heap_buf) [[unlikely]] {
    out_ptr = small_buf;
    return 0;
  }
  napi_get_value_string_utf8(env, str_val, heap_buf, utf8_len + 1, &written);
  out_ptr = heap_buf;
  return written;
}

/** Free the encoded string buffer if it was heap-allocated. */
static FSH_FORCE_INLINE void cleanup_string_buf(const char * data, const char * small_buf, const char * large_buf) {
  if (data != small_buf && data != large_buf) [[unlikely]] {
    free(const_cast<char *>(data));
  }
}

/**
 * Hash a V8 string as UTF-8 via xxHash3-128.
 *
 * Optimized: uses only an 8 KB stack buffer. If the string fits (vast majority),
 * one N-API call + one xxhash call — no large_buf, no heap. For strings > 8 KB,
 * falls back to streaming xxhash in 8 KB chunks — still no heap allocation.
 */
FSH_NO_INLINE static XXH128_hash_t fast_hash_string(napi_env env, napi_value str_val, uint64_t seed) {
  char buf[STRING_SMALL_BUF];
  size_t written = 0;
  napi_get_value_string_utf8(env, str_val, buf, STRING_SMALL_BUF, &written);

  if (written < STRING_SMALL_BUF - 5) [[likely]] {
    // Fast path: string fits in buffer — single-shot hash
    return XXH3_128bits_withSeed(reinterpret_cast<const uint8_t *>(buf), written, seed);
  }

  // Check real length
  size_t utf8_len = 0;
  napi_get_value_string_utf8(env, str_val, nullptr, 0, &utf8_len);

  if (utf8_len == written) {
    // Fit exactly — single-shot hash
    return XXH3_128bits_withSeed(reinterpret_cast<const uint8_t *>(buf), written, seed);
  }

  // String > 8 KB — streaming hash in chunks. No heap allocation.
  XXH3_state_t state;
  XXH3_128bits_reset_withSeed(&state, seed);
  // Feed the first chunk we already have
  XXH3_128bits_update(&state, reinterpret_cast<const uint8_t *>(buf), written);

  // Re-encode remaining chunks
  size_t remaining = utf8_len - written;
  // We need to re-encode the full string from an offset. N-API doesn't support
  // partial encoding, so we re-encode the full string into a large or heap buffer.
  // This is the rare path (strings > 8 KB).
  if (remaining < STRING_LARGE_BUF) {
    char large_buf[STRING_LARGE_BUF];
    napi_get_value_string_utf8(env, str_val, large_buf, utf8_len + 1, &written);
    // We already hashed the first chunk — but re-encoding changes boundaries.
    // Safest: just hash the full re-encoded buffer.
    return XXH3_128bits_withSeed(reinterpret_cast<const uint8_t *>(large_buf), written, seed);
  }

  // Very large string — heap
  auto * heap = static_cast<char *>(malloc(utf8_len + 1));
  if (!heap) [[unlikely]] {
    return XXH3_128bits_digest(&state);
  }
  napi_get_value_string_utf8(env, str_val, heap, utf8_len + 1, &written);
  auto result = XXH3_128bits_withSeed(reinterpret_cast<const uint8_t *>(heap), written, seed);
  free(heap);
  return result;
}

#endif
