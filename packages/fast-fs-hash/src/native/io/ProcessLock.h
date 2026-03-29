#ifndef _FAST_FS_HASH_PROCESS_LOCK_H
#define _FAST_FS_HASH_PROCESS_LOCK_H

#include "../includes.h"

/**
 * Cross-process named lock.
 *
 * Platform implementations:
 *   Linux:   shm + pthread_mutex (PTHREAD_MUTEX_ROBUST for crash recovery)
 *   macOS:   shm + pthread_mutex (PID-based crash recovery with destroy/reinit)
 *   FreeBSD: flock on lock file (shm pthread_mutex_destroy crashes on FreeBSD)
 *   Windows: LockFileEx on lock file
 */

namespace fast_fs_hash {

  struct ProcessLockHandle;

  ProcessLockHandle * processLockAcquire(const char * shmName, int timeoutMs, const char *& outError) noexcept;
  void processLockRelease(ProcessLockHandle * handle) noexcept;
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

// ─── Decide which backend to use ─────────────────────────────────────

#if defined(_WIN32) || defined(__FreeBSD__)
#  define FSH_LOCK_USE_FLOCK 1
#else
#  define FSH_LOCK_USE_SHM 1
#endif

// =====================================================================
// SHM backend (Linux, macOS)
// =====================================================================

#ifdef FSH_LOCK_USE_SHM

#  include <sys/mman.h>
#  include <signal.h>
#  include <time.h>

namespace fast_fs_hash {

  struct ShmLockState {
    std::atomic<uint64_t> magic;
    std::atomic<pid_t> ownerPid;
    std::atomic<int32_t> initFlag;  // 0=uninit, 1=initializing, 2=ready
    pthread_mutex_t mutex;
  };

  static constexpr uint64_t SHM_LOCK_MAGIC = 0x6673684C6F636B34ULL;  // "fshLock4"
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

  FSH_NO_INLINE static bool initShmMutex(ShmLockState * state) noexcept {
    pthread_mutexattr_t attr;
    if (pthread_mutexattr_init(&attr) != 0) {
      return false;
    }
    pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
#ifdef PTHREAD_MUTEX_ROBUST
    pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST);
#endif
    const int rc = pthread_mutex_init(&state->mutex, &attr);
    pthread_mutexattr_destroy(&attr);
    if (rc != 0) {
      return false;
    }
    state->ownerPid.store(0, std::memory_order_relaxed);
    state->magic.store(SHM_LOCK_MAGIC, std::memory_order_release);
    state->initFlag.store(2, std::memory_order_release);
    return true;
  }

  static inline bool ensureInitialized(ShmLockState * state) noexcept {
    int32_t expected = 0;
    if (state->initFlag.compare_exchange_strong(expected, 1, std::memory_order_acq_rel)) {
      return initShmMutex(state);
    }
    for (int i = 0; i < 10100; ++i) {
      if (state->initFlag.load(std::memory_order_acquire) == 2) {
        return true;
      }
      if (i > 100) {
        struct timespec ts = {0, 100000L};
        nanosleep(&ts, nullptr);
      } else if (i > 5) {
        cpu_pause();
      }
    }
    return false;
  }

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
    outFd = fd;
    return state;
  }

  static inline void closeShmState(ShmLockState * state, int fd) noexcept {
    munmap(state, SHM_LOCK_SIZE);
    close(fd);
  }

  /** Try to recover a stale lock. On Linux uses PTHREAD_MUTEX_ROBUST (EOWNERDEAD).
   *  On macOS falls back to PID check + destroy/reinit. */
  static inline bool tryRecoverStaleLock(const char * shmName, ShmLockState *& state, int & shmFd) noexcept {
    const pid_t owner = state->ownerPid.load(std::memory_order_acquire);
    if (owner == 0 || isPidAlive(owner)) {
      return false;
    }
    // Owner is dead — unlink stale segment and create fresh one.
    // This avoids pthread_mutex_destroy on a potentially corrupted mutex.
    closeShmState(state, shmFd);
    shm_unlink(shmName);
    state = openShmState(shmName, shmFd);
    return state != nullptr;
  }

  /** Handle the result of pthread_mutex_trylock / pthread_mutex_lock.
   *  Returns true if the lock was acquired (possibly after EOWNERDEAD recovery). */
  static inline bool handleLockResult(int rc, ShmLockState * state) noexcept {
#ifdef PTHREAD_MUTEX_ROBUST
    if (rc == EOWNERDEAD) [[unlikely]] {
      // Previous owner crashed — mark mutex consistent and claim it
      pthread_mutex_consistent(&state->mutex);
      return true;
    }
#else
    (void)state;
#endif
    return rc == 0;
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

    if (handleLockResult(pthread_mutex_trylock(&state->mutex), state)) [[likely]] {
      goto acquired;
    }
    if (tryRecoverStaleLock(shmName, state, shmFd)) {
      if (handleLockResult(pthread_mutex_trylock(&state->mutex), state)) [[likely]] {
        goto acquired;
      }
    }
    if (timeoutMs == 0) {
      closeShmState(state, shmFd);
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

        if (handleLockResult(pthread_mutex_trylock(&state->mutex), state)) [[likely]] {
          goto acquired;
        }
        if (tryRecoverStaleLock(shmName, state, shmFd)) {
          if (handleLockResult(pthread_mutex_trylock(&state->mutex), state)) [[likely]] {
            goto acquired;
          }
        }

        if (timeoutMs > 0) {
          struct timespec now;
          clock_gettime(CLOCK_MONOTONIC, &now);
          const int64_t elapsedMs = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
          if (elapsedMs >= timeoutMs) {
            closeShmState(state, shmFd);
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
      closeShmState(state, shmFd);
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

    // Best-effort cleanup: if no one else is waiting, unlink the shm segment
    if (pthread_mutex_trylock(&state->mutex) == 0) {
      pthread_mutex_unlock(&state->mutex);
      shm_unlink(handle->shmName);
    }

    closeShmState(state, handle->shmFd);
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

#endif  // FSH_LOCK_USE_SHM

// =====================================================================
// Flock/LockFileEx backend (FreeBSD, Windows)
// =====================================================================

#ifdef FSH_LOCK_USE_FLOCK

namespace fast_fs_hash {

  /** Lock dir env var name — configurable from TS via ProcessLock.lockDir. */
  static inline const char * getLockDir() noexcept {
    const char * dir = getenv("FAST_FS_HASH_LOCK_DIR");
    if (dir && dir[0]) {
      return dir;
    }
#ifdef _WIN32
    dir = getenv("TEMP");
    if (!dir) { dir = getenv("TMP"); }
    if (!dir) { dir = "."; }
#else
    dir = getenv("TMPDIR");
    if (!dir) { dir = "/tmp"; }
#endif
    return dir;
  }

  static inline void buildLockFilePath(const char * shmName, char * FSH_RESTRICT out, size_t outSize) noexcept {
    const char * dir = getLockDir();
#ifdef _WIN32
    snprintf(out, outSize, "%s\\fsh-lock-%s", dir, shmName + 2);
#else
    snprintf(out, outSize, "%s/fsh-lock-%s", dir, shmName + 2);
#endif
  }

}  // namespace fast_fs_hash

#ifdef _WIN32

// ── Windows: LockFileEx ──────────────────────────────────────────────

namespace fast_fs_hash {

  struct ProcessLockHandle {
    HANDLE hFile;
    char path[FSH_MAX_PATH];
  };

  inline ProcessLockHandle * processLockAcquire(
    const char * shmName, int timeoutMs, const char *& outError
  ) noexcept {
    outError = nullptr;

    char lockPath[FSH_MAX_PATH];
    buildLockFilePath(shmName, lockPath, sizeof(lockPath));

    HANDLE hFile = CreateFileA(lockPath, GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) [[unlikely]] {
      outError = "ProcessLock: failed to open lock file";
      return nullptr;
    }

    OVERLAPPED ov = {};
    DWORD flags = LOCKFILE_EXCLUSIVE_LOCK;

    if (timeoutMs == 0) {
      flags |= LOCKFILE_FAIL_IMMEDIATELY;
      if (!LockFileEx(hFile, flags, 0, 1, 0, &ov)) {
        CloseHandle(hFile);
        outError = "ProcessLock: lock not available";
        return nullptr;
      }
    } else if (timeoutMs < 0) {
      if (!LockFileEx(hFile, flags, 0, 1, 0, &ov)) [[unlikely]] {
        CloseHandle(hFile);
        outError = "ProcessLock: LockFileEx failed";
        return nullptr;
      }
    } else {
      flags |= LOCKFILE_FAIL_IMMEDIATELY;
      ULONGLONG start = GetTickCount64();
      int sleepMs = 1;
      for (;;) {
        OVERLAPPED ov2 = {};
        if (LockFileEx(hFile, flags, 0, 1, 0, &ov2)) [[likely]] {
          break;
        }
        if (GetTickCount64() - start >= static_cast<ULONGLONG>(timeoutMs)) {
          CloseHandle(hFile);
          outError = "ProcessLock: timeout waiting for lock";
          return nullptr;
        }
        Sleep(sleepMs);
        if (sleepMs < 50) { sleepMs *= 2; }
      }
    }

    auto * handle = static_cast<ProcessLockHandle *>(malloc(sizeof(ProcessLockHandle)));
    if (!handle) [[unlikely]] {
      CloseHandle(hFile);
      outError = "ProcessLock: allocation failed";
      return nullptr;
    }
    handle->hFile = hFile;
    memcpy(handle->path, lockPath, sizeof(handle->path));
    return handle;
  }

  inline void processLockRelease(ProcessLockHandle * handle) noexcept {
    if (handle) {
      CloseHandle(handle->hFile);
      DeleteFileA(handle->path);
      free(handle);
    }
  }

  inline bool processLockIsLocked(const char * shmName) noexcept {
    char lockPath[FSH_MAX_PATH];
    buildLockFilePath(shmName, lockPath, sizeof(lockPath));

    HANDLE hFile = CreateFileA(lockPath, GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) {
      return false;
    }
    OVERLAPPED ov = {};
    if (LockFileEx(hFile, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) {
      CloseHandle(hFile);
      return false;
    }
    CloseHandle(hFile);
    return true;
  }

}  // namespace fast_fs_hash

#else

// ── FreeBSD: flock ───────────────────────────────────────────────────

#  include <sys/file.h>
#  include <time.h>

namespace fast_fs_hash {

  struct ProcessLockHandle {
    int fd;
    char path[FSH_MAX_PATH];
  };

  inline ProcessLockHandle * processLockAcquire(
    const char * shmName, int timeoutMs, const char *& outError
  ) noexcept {
    outError = nullptr;

    char lockPath[FSH_MAX_PATH];
    buildLockFilePath(shmName, lockPath, sizeof(lockPath));

    const int fd = ::open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0666);
    if (fd < 0) [[unlikely]] {
      outError = "ProcessLock: failed to open lock file";
      return nullptr;
    }

    if (::flock(fd, LOCK_EX | LOCK_NB) == 0) [[likely]] {
      goto acquired;
    }

    if (timeoutMs == 0) {
      ::close(fd);
      outError = "ProcessLock: lock not available";
      return nullptr;
    }

    if (timeoutMs < 0) {
      for (;;) {
        if (::flock(fd, LOCK_EX) == 0) {
          goto acquired;
        }
        if (errno != EINTR) [[unlikely]] {
          ::close(fd);
          outError = "ProcessLock: flock failed";
          return nullptr;
        }
      }
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

        if (::flock(fd, LOCK_EX | LOCK_NB) == 0) [[likely]] {
          goto acquired;
        }

        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        const int64_t elapsedMs = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsedMs >= timeoutMs) {
          ::close(fd);
          outError = "ProcessLock: timeout waiting for lock";
          return nullptr;
        }
      }
    }

  acquired:
    auto * handle = static_cast<ProcessLockHandle *>(malloc(sizeof(ProcessLockHandle)));
    if (!handle) [[unlikely]] {
      ::close(fd);
      outError = "ProcessLock: allocation failed";
      return nullptr;
    }
    handle->fd = fd;
    memcpy(handle->path, lockPath, sizeof(handle->path));
    return handle;
  }

  inline void processLockRelease(ProcessLockHandle * handle) noexcept {
    if (handle) {
      ::close(handle->fd);
      ::unlink(handle->path);
      free(handle);
    }
  }

  inline bool processLockIsLocked(const char * shmName) noexcept {
    char lockPath[FSH_MAX_PATH];
    buildLockFilePath(shmName, lockPath, sizeof(lockPath));

    const int fd = ::open(lockPath, O_RDONLY | O_CLOEXEC, 0);
    if (fd < 0) {
      return false;
    }
    const int rc = ::flock(fd, LOCK_EX | LOCK_NB);
    if (rc == 0) {
      ::close(fd);
      return false;
    }
    ::close(fd);
    return errno == EWOULDBLOCK;
  }

}  // namespace fast_fs_hash

#endif  // _WIN32 vs FreeBSD

#endif  // FSH_LOCK_USE_FLOCK

#endif  // _FAST_FS_HASH_PROCESS_LOCK_H
