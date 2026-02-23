#ifndef _FAST_FS_HASH_SPAWN_THREAD_H
#define _FAST_FS_HASH_SPAWN_THREAD_H

#include "../includes.h"

namespace fast_fs_hash {

  /**
   * Spawn a detached thread with a configurable stack size.
   * Cross-platform: pthread on POSIX, _beginthreadex on Windows.
   * Returns true on success, false on failure.
   */
#ifdef _WIN32
  using ThreadEntry = unsigned(__stdcall *)(void *);
#else
  using ThreadEntry = void * (*)(void *);
#endif

  static inline bool spawnDetachedThread(ThreadEntry entry, void * arg, size_t stackSize) noexcept {
#ifdef _WIN32
    const uintptr_t h = _beginthreadex(nullptr, static_cast<unsigned>(stackSize), entry, arg, 0, nullptr);
    if (!h) [[unlikely]] {
      return false;
    }
    CloseHandle(reinterpret_cast<HANDLE>(h));
    return true;
#else
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, stackSize);
    pthread_t th;
    const int rc = pthread_create(&th, &attr, entry, arg);
    pthread_attr_destroy(&attr);
    if (rc != 0) [[unlikely]] {
      return false;
    }
    pthread_detach(th);
    return true;
#endif
  }

}  // namespace fast_fs_hash

#endif
