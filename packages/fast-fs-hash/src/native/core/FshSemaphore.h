#ifndef _FAST_FS_HASH_SEMAPHORE_H
#define _FAST_FS_HASH_SEMAPHORE_H

#include "includes.h"

#ifdef __APPLE__
#  include <dispatch/dispatch.h>
#elif !defined(_WIN32)
#  include <semaphore.h>
#  include <time.h>
#  include <errno.h>
#endif

namespace fast_fs_hash {

  /** CPU spin hint — yields the pipeline without blocking. */
  FSH_FORCE_INLINE void cpu_pause() noexcept {
#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64) || defined(_M_IX86)
#  ifdef _MSC_VER
    _mm_pause();
#  else
    __builtin_ia32_pause();
#  endif
#elif defined(__aarch64__) || defined(_M_ARM64)
#  ifdef _MSC_VER
    __yield();
#  else
    __asm__ __volatile__("yield");
#  endif
#endif
  }

  /**
   * Lightweight platform counting semaphore + timed wait.
   *
   * macOS: dispatch_semaphore (user-space fast path).
   * Linux: POSIX sem_t.
   * Windows: Win32 Semaphore.
   */
  class Semaphore : NonCopyable {
   public:
    inline Semaphore() noexcept {
#ifdef __APPLE__
      this->sem_ = dispatch_semaphore_create(0);
#elif defined(_WIN32)
      this->sem_ = CreateSemaphoreW(nullptr, 0, 0x7FFFFFFF, nullptr);
#else
      sem_init(&this->sem_, 0, 0);
#endif
    }

    inline ~Semaphore() noexcept {
#ifdef __APPLE__
      if (this->sem_) {
        dispatch_release(this->sem_);
      }
#elif defined(_WIN32)
      if (this->sem_) {
        CloseHandle(this->sem_);
      }
#else
      sem_destroy(&this->sem_);
#endif
    }

    /** Post (signal) the semaphore, waking one waiting thread. */
    FSH_FORCE_INLINE void post() noexcept {
#ifdef __APPLE__
      dispatch_semaphore_signal(this->sem_);
#elif defined(_WIN32)
      ReleaseSemaphore(this->sem_, 1, nullptr);
#else
      sem_post(&this->sem_);
#endif
    }

    /** Wait up to ms milliseconds. Returns true if signaled, false on timeout. */
    inline bool wait_for_ms(int ms) noexcept {
#ifdef __APPLE__
      return dispatch_semaphore_wait(
        this->sem_, dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(ms) * 1000000)) == 0;
#elif defined(_WIN32)
      return WaitForSingleObject(this->sem_, ms) == WAIT_OBJECT_0;
#else
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      ts.tv_sec += ms / 1000;
      ts.tv_nsec += (ms % 1000) * 1000000L;
      if (ts.tv_nsec >= 1000000000L) [[unlikely]] {
        ts.tv_sec++;
        ts.tv_nsec -= 1000000000L;
      }
      for (;;) {
        if (sem_timedwait(&this->sem_, &ts) == 0) [[likely]] {
          return true;
        }
        if (errno != EINTR) [[likely]] {
          return false;
        }
      }
#endif
    }

   private:
#ifdef __APPLE__
    dispatch_semaphore_t sem_;
#elif defined(_WIN32)
    HANDLE sem_;
#else
    sem_t sem_;
#endif
  };

}  // namespace fast_fs_hash

#endif
