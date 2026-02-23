#ifndef _FAST_FS_HASH_PROCESS_LOCK_H
#define _FAST_FS_HASH_PROCESS_LOCK_H

#include "../includes.h"

/**
 * Cross-process named lock.
 *
 * POSIX: process-shared pthread_mutex in POSIX shared memory (shm_open).
 *   Owner PID tracked for crash recovery (stale lock detection via kill(pid,0)).
 *   Reference counted — shm_unlink when last mapping is released.
 * Windows: named mutex via CreateMutexW (kernel-managed, auto-released on crash).
 */

namespace fast_fs_hash {

  struct ProcessLockHandle;

  /** Acquire a cross-process lock by pre-hashed shm name.
   *  @param shmName   Pre-computed name from hashLockName().
   *  @param timeoutMs  -1=infinite, 0=try-once, >0=wait up to N ms.
   *  @param outError   Set to error string on failure, nullptr on success. */
  ProcessLockHandle * processLockAcquire(const char * shmName, int timeoutMs, const char *& outError) noexcept;

  /** Release a previously acquired lock. Safe to call with nullptr. */
  void processLockRelease(ProcessLockHandle * handle) noexcept;

  /** Check if a lock is currently held by any process. Takes pre-hashed shm name. */
  bool processLockIsLocked(const char * shmName) noexcept;

  static constexpr size_t PROCESS_LOCK_STACK_SIZE = 64 * 1024;

  // ── Name hashing ─────────────────────────────────────────────────────

  static FSH_FORCE_INLINE void encodeBase36(uint64_t v, char * FSH_RESTRICT out, int len) noexcept {
    static constexpr char B36[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    for (int i = len - 1; i >= 0; --i) {
      out[i] = B36[v % 36];
      v /= 36;
    }
  }

  /** Hash name → "/L" + 25 base36 = 27 chars. Buffer must be >= 28 bytes. */
  static FSH_FORCE_INLINE void hashLockName(
    const char * FSH_RESTRICT name, size_t nameLen, char * FSH_RESTRICT out) noexcept {
    const XXH128_hash_t h = XXH3_128bits(name, nameLen);
    out[0] = '/';
    out[1] = 'L';
    encodeBase36(h.low64, out + 2, 13);
    encodeBase36(h.high64, out + 15, 12);
    out[27] = '\0';
  }

}  // namespace fast_fs_hash

// ─── Windows ─────────────────────────────────────────────────────────

#ifdef _WIN32

namespace fast_fs_hash {

  struct ProcessLockHandle {
    HANDLE mutex;
  };

  inline ProcessLockHandle * processLockAcquire(const char * shmName, int timeoutMs, const char *& outError) noexcept {
    outError = nullptr;

    wchar_t wname[48];
    if (swprintf(wname, 48, L"Global\\fsh-%hs", shmName + 2) <= 0) [[unlikely]] {
      outError = "ProcessLock: name format failed";
      return nullptr;
    }

    HANDLE mutex = CreateMutexW(nullptr, FALSE, wname);
    if (!mutex) [[unlikely]] {
      outError = "ProcessLock: CreateMutexW failed";
      return nullptr;
    }

    const DWORD waitMs = (timeoutMs < 0) ? INFINITE : static_cast<DWORD>(timeoutMs);
    const DWORD result = WaitForSingleObject(mutex, waitMs);
    if (result != WAIT_OBJECT_0 && result != WAIT_ABANDONED) [[unlikely]] {
      CloseHandle(mutex);
      outError =
        (result == WAIT_TIMEOUT) ? "ProcessLock: timeout waiting for lock" : "ProcessLock: WaitForSingleObject failed";
      return nullptr;
    }

    auto * handle = static_cast<ProcessLockHandle *>(malloc(sizeof(ProcessLockHandle)));
    if (!handle) [[unlikely]] {
      ReleaseMutex(mutex);
      CloseHandle(mutex);
      outError = "ProcessLock: allocation failed";
      return nullptr;
    }
    handle->mutex = mutex;
    return handle;
  }

  inline void processLockRelease(ProcessLockHandle * handle) noexcept {
    if (handle) {
      ReleaseMutex(handle->mutex);
      CloseHandle(handle->mutex);
      free(handle);
    }
  }

  inline bool processLockIsLocked(const char * shmName) noexcept {
    wchar_t wname[48];
    swprintf(wname, 48, L"Global\\fsh-%hs", shmName + 2);

    HANDLE mutex = OpenMutexW(SYNCHRONIZE, FALSE, wname);
    if (!mutex) {
      return false;
    }
    const DWORD result = WaitForSingleObject(mutex, 0);
    if (result == WAIT_OBJECT_0 || result == WAIT_ABANDONED) {
      ReleaseMutex(mutex);
      CloseHandle(mutex);
      return false;
    }
    CloseHandle(mutex);
    return true;
  }

}  // namespace fast_fs_hash

#else

// ─── POSIX ───────────────────────────────────────────────────────────

#  include <sys/mman.h>
#  include <signal.h>
#  include <time.h>

namespace fast_fs_hash {

  struct ShmLockState {
    std::atomic<uint64_t> magic;  // SHM_LOCK_MAGIC when initialized
    std::atomic<pid_t> ownerPid;  // PID of current holder, 0 = unlocked
    std::atomic<int32_t> mapCount;  // number of active shm mappings (for shm_unlink)
    std::atomic<int32_t> initFlag;  // CAS flag: 0=uninit, 1=initializing, 2=ready
    pthread_mutex_t mutex;
  };

  static constexpr uint64_t SHM_LOCK_MAGIC = 0x6673684C6F636B32ULL;  // "fshLock2" (v2 with mapCount)
  static constexpr size_t SHM_LOCK_SIZE = sizeof(ShmLockState);

  struct ProcessLockHandle {
    ShmLockState * state;
    int shmFd;
    char shmName[28];
  };

  static inline bool isPidAlive(pid_t pid) noexcept {
    if (pid <= 0) {
      return false;
    }
    return kill(pid, 0) == 0 || errno != ESRCH;
  }

  /** Initialize mutex in shared memory. Called only by the winner of the CAS race.
   *  @param resetMapCount  true for first-time init, false for recovery (preserve existing count). */
  FSH_NO_INLINE static bool initShmMutex(ShmLockState * state, bool resetMapCount) noexcept {
    pthread_mutexattr_t attr;
    if (pthread_mutexattr_init(&attr) != 0) {
      return false;
    }
    pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
    const int rc = pthread_mutex_init(&state->mutex, &attr);
    pthread_mutexattr_destroy(&attr);
    if (rc != 0) {
      return false;
    }
    state->ownerPid.store(0, std::memory_order_relaxed);
    if (resetMapCount) {
      state->mapCount.store(0, std::memory_order_relaxed);
    }
    state->magic.store(SHM_LOCK_MAGIC, std::memory_order_release);
    state->initFlag.store(2, std::memory_order_release);
    return true;
  }

  /** Ensure the shm is initialized. Thread/process-safe via CAS on initFlag.
   *  @param resetMapCount  true for first-time init, false for recovery. */
  static inline bool ensureInitialized(ShmLockState * state, bool resetMapCount = true) noexcept {
    int32_t expected = 0;
    if (state->initFlag.compare_exchange_strong(expected, 1, std::memory_order_acq_rel)) {
      return initShmMutex(state, resetMapCount);
    }
    // Someone else is initializing or already done. Spin-wait for ready.
    for (int i = 0; i < 10100; ++i) {
      if (state->initFlag.load(std::memory_order_acquire) == 2) {
        return true;
      }
      if (i > 100) {
        struct timespec ts = {0, 100000L};  // 100µs
        nanosleep(&ts, nullptr);
      } else if (i > 5) {
        cpu_pause();
      }
    }
    return false;  // Init stuck — give up
  }

  /** Try to recover a stale lock from a dead owner. CAS-safe. */
  static inline bool tryRecoverStaleLock(ShmLockState * state) noexcept {
    const pid_t owner = state->ownerPid.load(std::memory_order_acquire);
    if (owner == 0 || isPidAlive(owner)) {
      return false;
    }
    // Owner is dead. CAS ownerPid to 0 to claim recovery rights.
    pid_t expected = owner;
    if (!state->ownerPid.compare_exchange_strong(expected, 0, std::memory_order_acq_rel)) {
      return false;  // Another recoverer beat us
    }
    // Reinitialize the mutex (the dead process may have left it locked).
    // Preserve mapCount — existing mappings are still valid.
    pthread_mutex_destroy(&state->mutex);
    state->initFlag.store(0, std::memory_order_release);
    return ensureInitialized(state, false);
  }

  /** Open and map shm. Increments mapCount. Returns nullptr on failure. */
  static inline ShmLockState * openShmState(const char * shmName, int & outFd) noexcept {
    const int fd = shm_open(shmName, O_RDWR | O_CREAT, 0666);
    if (fd < 0) [[unlikely]] {
      return nullptr;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) [[unlikely]] {
      close(fd);
      return nullptr;
    }
    if (static_cast<size_t>(st.st_size) < SHM_LOCK_SIZE) {
      if (ftruncate(fd, static_cast<off_t>(SHM_LOCK_SIZE)) != 0) [[unlikely]] {
        close(fd);
        return nullptr;
      }
    }
    void * mem = mmap(nullptr, SHM_LOCK_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mem == MAP_FAILED) [[unlikely]] {
      close(fd);
      return nullptr;
    }
    auto * state = static_cast<ShmLockState *>(mem);
    if (!ensureInitialized(state)) [[unlikely]] {
      munmap(mem, SHM_LOCK_SIZE);
      close(fd);
      return nullptr;
    }
    state->mapCount.fetch_add(1, std::memory_order_relaxed);
    outFd = fd;
    return state;
  }

  /** Unmap and close. Decrements mapCount. If last mapping, shm_unlink. */
  static inline void closeShmState(ShmLockState * state, int fd, const char * shmName) noexcept {
    const int32_t prev = state->mapCount.fetch_sub(1, std::memory_order_acq_rel);
    munmap(state, SHM_LOCK_SIZE);
    close(fd);
    if (prev <= 1 && shmName) {
      shm_unlink(shmName);
    }
  }

  inline ProcessLockHandle * processLockAcquire(const char * shmName, int timeoutMs, const char *& outError) noexcept {
    outError = nullptr;

    int shmFd = -1;
    auto * state = openShmState(shmName, shmFd);
    if (!state) [[unlikely]] {
      outError = "ProcessLock: shm_open/mmap failed";
      return nullptr;
    }

    const pid_t myPid = getpid();

    // Fast path — uncontended
    if (pthread_mutex_trylock(&state->mutex) == 0) [[likely]] {
      goto acquired;
    }
    if (tryRecoverStaleLock(state)) {
      if (pthread_mutex_trylock(&state->mutex) == 0) [[likely]] {
        goto acquired;
      }
    }
    if (timeoutMs == 0) {
      closeShmState(state, shmFd, shmName);
      outError = "ProcessLock: lock not available";
      return nullptr;
    }

    {
      struct timespec start;
      clock_gettime(CLOCK_MONOTONIC, &start);
      int sleepMs = 1;

      for (;;) {
        const struct timespec ts = {0, sleepMs * 1000000L};
        nanosleep(&ts, nullptr);
        if (sleepMs < 50) {
          sleepMs *= 2;
        }

        if (pthread_mutex_trylock(&state->mutex) == 0) [[likely]] {
          goto acquired;
        }
        if (tryRecoverStaleLock(state)) {
          if (pthread_mutex_trylock(&state->mutex) == 0) [[likely]] {
            goto acquired;
          }
        }

        if (timeoutMs > 0) {
          struct timespec now;
          clock_gettime(CLOCK_MONOTONIC, &now);
          const int64_t elapsedMs = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
          if (elapsedMs >= timeoutMs) {
            closeShmState(state, shmFd, shmName);
            outError = "ProcessLock: timeout waiting for lock";
            return nullptr;
          }
        }
      }
    }

  acquired:
    state->ownerPid.store(myPid, std::memory_order_release);
    auto * handle = static_cast<ProcessLockHandle *>(malloc(sizeof(ProcessLockHandle)));
    if (!handle) [[unlikely]] {
      state->ownerPid.store(0, std::memory_order_release);
      pthread_mutex_unlock(&state->mutex);
      closeShmState(state, shmFd, shmName);
      outError = "ProcessLock: allocation failed";
      return nullptr;
    }
    handle->state = state;
    handle->shmFd = shmFd;
    memcpy(handle->shmName, shmName, sizeof(handle->shmName));
    return handle;
  }

  inline void processLockRelease(ProcessLockHandle * handle) noexcept {
    if (!handle) {
      return;
    }
    auto * state = handle->state;
    state->ownerPid.store(0, std::memory_order_release);
    pthread_mutex_unlock(&state->mutex);
    closeShmState(state, handle->shmFd, handle->shmName);
    free(handle);
  }

  inline bool processLockIsLocked(const char * shmName) noexcept {
    const int fd = shm_open(shmName, O_RDONLY, 0);
    if (fd < 0) {
      return false;
    }
    void * mem = mmap(nullptr, SHM_LOCK_SIZE, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);
    if (mem == MAP_FAILED) {
      return false;
    }
    const auto * state = static_cast<const ShmLockState *>(mem);
    bool locked = false;
    if (state->magic.load(std::memory_order_acquire) == SHM_LOCK_MAGIC) {
      const pid_t owner = state->ownerPid.load(std::memory_order_acquire);
      locked = owner != 0 && isPidAlive(owner);
    }
    munmap(mem, SHM_LOCK_SIZE);
    return locked;
  }

}  // namespace fast_fs_hash

#endif  // _WIN32

#endif  // _FAST_FS_HASH_PROCESS_LOCK_H
