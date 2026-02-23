#ifndef _FAST_FS_HASH_INCLUDES_H
#define _FAST_FS_HASH_INCLUDES_H

#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <atomic>
#include <memory>

#ifdef _MSC_VER
#  include <malloc.h>
#endif

#include <napi.h>

#ifndef _WIN32
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <unistd.h>
#  include <climits>
#else
#  ifndef NOMINMAX
#    define NOMINMAX  // prevent windows.h from defining min/max macros
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#endif

// Inline all xxHash code directly into this TU for full compiler visibility.
// On x86_64, separate binaries are built per ISA level (SSE2/AVX2/AVX-512)
// with the appropriate -march flag, so the compiler auto-vectorizes xxHash
// using the target's SIMD instructions. No runtime dispatch needed.
#define XXH_INLINE_ALL
#include "xxhash.h"

#if defined(__GNUC__) || defined(__clang__)
#  define FSH_PREFETCH(ptr) __builtin_prefetch(ptr, 0, 3)
#  define FSH_PREFETCH_W(ptr) __builtin_prefetch(ptr, 1, 1)
#elif defined(_MSC_VER) && (defined(_M_X64) || defined(_M_IX86))
#  include <intrin.h>
#  define FSH_PREFETCH(ptr) _mm_prefetch(reinterpret_cast<const char *>(ptr), _MM_HINT_T0)
#  define FSH_PREFETCH_W(ptr) _mm_prefetch(reinterpret_cast<const char *>(ptr), _MM_HINT_T0)
#else
#  define FSH_PREFETCH(ptr) ((void)0)
#  define FSH_PREFETCH_W(ptr) ((void)0)
#endif

// Note: branch prediction hints use C++20 [[likely]]/[[unlikely]] attributes
// directly at call sites instead of macros. All target compilers (GCC 9+,
// Clang 12+, MSVC 19.26+) support them and produce identical codegen
// to the old __builtin_expect approach, with the benefit of also working
// on MSVC where __builtin_expect is not available.

/** Force no-inline + cold for rare paths — keeps icache tight. */
#if defined(__GNUC__) || defined(__clang__)
#  define FSH_NO_INLINE __attribute__((noinline, cold))
#elif defined(_MSC_VER)
#  define FSH_NO_INLINE __declspec(noinline)
#else
#  define FSH_NO_INLINE
#endif

/** Force inline — use for small hot-path helpers. */
#if defined(__GNUC__) || defined(__clang__)
#  define FSH_FORCE_INLINE __attribute__((always_inline)) inline
#elif defined(_MSC_VER)
#  define FSH_FORCE_INLINE __forceinline
#else
#  define FSH_FORCE_INLINE inline
#endif

/** Pointer does not alias any other pointer in scope. */
#if defined(__GNUC__) || defined(__clang__) || defined(_MSC_VER)
#  define FSH_RESTRICT __restrict
#else
#  define FSH_RESTRICT
#endif

/** Hint to the compiler that a pointer is aligned to N bytes.
 *  Enables vectorized loads/stores without alignment checks on the hot path. */
template <size_t N, typename T>
FSH_FORCE_INLINE constexpr T * assume_aligned(T * ptr) noexcept {
#if defined(__cpp_lib_assume_aligned)
  return std::assume_aligned<N>(ptr);
#elif defined(__GNUC__) || defined(__clang__)
  return static_cast<T *>(__builtin_assume_aligned(ptr, N));
#else
  return ptr;
#endif
}

/** Portable aligned allocation (posix_memalign / _aligned_malloc). */
FSH_FORCE_INLINE void * aligned_malloc(size_t alignment, size_t size) noexcept {
  void * p;
#ifdef _MSC_VER
  p = _aligned_malloc(size, alignment);
#else
  if (posix_memalign(&p, alignment, size) != 0) [[unlikely]] {
    return nullptr;
  }
#endif
  return p;
}

/** Portable free for memory allocated with aligned_malloc. */
FSH_FORCE_INLINE void aligned_free(void * ptr) noexcept {
#ifdef _MSC_VER
  _aligned_free(ptr);
#else
  free(ptr);
#endif
}

#include "NonCopyable.h"

/** Maximum file path length.  Uses the OS-defined PATH_MAX when available,
 *  otherwise falls back to a safe 4096-byte default (covers all major platforms). */
#ifdef PATH_MAX
  static constexpr size_t FSH_MAX_PATH = PATH_MAX;
#else
  static constexpr size_t FSH_MAX_PATH = 4096;
#endif

namespace fast_fs_hash {
  /**
   * Per-thread read buffer size.
   * Covers the vast majority of source files in a single read.
   */
  static constexpr size_t READ_BUFFER_SIZE = 128 * 1024;

  /**
   * Offset of the magic/busy tag within the tagged streaming state allocation.
   * Layout: [XXH3_state_t][tag:uint64_t]
   * MAGIC_IDLE when available, MAGIC_BUSY while an async worker owns it.
   */
  static constexpr size_t STREAM_STATE_TAG_OFFSET = sizeof(XXH3_state_t);
  static constexpr uint64_t STREAM_STATE_MAGIC_IDLE = 0x5858'4833'7374'6174ULL;  // "XXH3stat"

  /** Restore the tag to MAGIC_IDLE after an async operation completes (JS-thread only). */
  static FSH_FORCE_INLINE void clearStreamBusy(uint8_t * state_ptr) noexcept {
    *reinterpret_cast<uint64_t *>(state_ptr + STREAM_STATE_TAG_OFFSET) = STREAM_STATE_MAGIC_IDLE;
  }
}  // namespace fast_fs_hash

#endif