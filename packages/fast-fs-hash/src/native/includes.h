#ifndef _FAST_FS_HASH_INCLUDES_H
#define _FAST_FS_HASH_INCLUDES_H

#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <atomic>
#include <memory>
#include <thread>

#ifdef _MSC_VER
#  include <malloc.h>
#endif

#include <napi.h>

#ifndef _WIN32
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <unistd.h>
#else
#  ifndef NOMINMAX
#    define NOMINMAX  // prevent windows.h from defining min/max macros
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#endif

// xxHash — linked separately (compiled via CMakeLists.txt).
// On x86_64: xxh_x86dispatch.c provides runtime AVX2/AVX512 dispatch.
// On other platforms: xxhash.c with platform-native SIMD (e.g. NEON on ARM64).
// XXH_STATIC_LINKING_ONLY exposes the full XXH3_state_t struct definition
// (needed for stack-allocated streaming state in XXHash128Wrap).
#define XXH_STATIC_LINKING_ONLY
#include "xxhash.h"

// ── Prefetch hints ───────────────────────────────────────────────────────

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

// ── Inline control ───────────────────────────────────────────────────────

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

// ── Alignment ────────────────────────────────────────────────────────────

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
  if (posix_memalign(&p, alignment, size) != 0) [[unlikely]]
    return nullptr;
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

#endif