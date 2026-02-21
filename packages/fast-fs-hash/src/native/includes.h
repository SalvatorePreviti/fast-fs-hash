#ifndef _FAST_FS_HASH_INCLUDES_H
#define _FAST_FS_HASH_INCLUDES_H

#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <atomic>
#include <thread>

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

// xxHash — header-only, inlined into this compilation unit.
#define XXH_INLINE_ALL
#include "xxhash.h"

#if defined(__GNUC__) || defined(__clang__)
#  define FSH_PREFETCH(ptr) __builtin_prefetch(ptr, 0, 3)
#  define FSH_PREFETCH_W(ptr) __builtin_prefetch(ptr, 1, 1)
#elif defined(_MSC_VER)
#  include <intrin.h>
#  define FSH_PREFETCH(ptr) _mm_prefetch(reinterpret_cast<const char *>(ptr), _MM_HINT_T0)
#  define FSH_PREFETCH_W(ptr) _mm_prefetch(reinterpret_cast<const char *>(ptr), _MM_HINT_T0)
#else
#  define FSH_PREFETCH(ptr) ((void)0)
#  define FSH_PREFETCH_W(ptr) ((void)0)
#endif

/** Branch prediction hints — likely / unlikely. */
#if defined(__GNUC__) || defined(__clang__)
#  define FSH_LIKELY(x) __builtin_expect(!!(x), 1)
#  define FSH_UNLIKELY(x) __builtin_expect(!!(x), 0)
#else
#  define FSH_LIKELY(x) (x)
#  define FSH_UNLIKELY(x) (x)
#endif

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

/** Portable aligned allocation (posix_memalign / _aligned_malloc). */
FSH_FORCE_INLINE void * aligned_malloc(size_t alignment, size_t size) noexcept {
  void * p;
#ifdef _MSC_VER
  p = _aligned_malloc(size, alignment);
#else
  if (FSH_UNLIKELY(posix_memalign(&p, alignment, size) != 0)) return nullptr;
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

/** CRTP-free non-copyable base. Inherit to delete copy ctor/assign. */
struct NonCopyable {
  NonCopyable() = default;
  ~NonCopyable() = default;
  NonCopyable(const NonCopyable &) = delete;
  NonCopyable & operator=(const NonCopyable &) = delete;
};

#endif