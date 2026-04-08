#ifndef _FAST_FS_HASH_FFSH_FILE_POSIX_H
#define _FAST_FS_HASH_FFSH_FILE_POSIX_H

#ifndef _WIN32

#  include "../includes.h"
#  include "../file-hash-cache/file-hash-cache-format.h"

#  include <sys/file.h>
#  include <time.h>

namespace fast_fs_hash {

  /** Opaque file handle token — the fd itself. -1 = invalid. */
  using FfshFileHandle = int32_t;
  static constexpr FfshFileHandle FFSH_FILE_HANDLE_INVALID = -1;

  /**
   * RAII file handle — POSIX implementation.
   *
   * Read-only constructors (hashing hot path):
   *   O_RDONLY | O_CLOEXEC (+ O_NOATIME on Linux).
   *   Supports openat() for dir-fd-relative access.
   *
   * Read/write factories (cache files):
   *   open_locked().
   *
   * Locking:
   *   open_locked() opens/creates the file and acquires an exclusive
   *   flock(2) lock. flock locks are per-open-file-description (per-OFD),
   *   so two open() calls in the same process — including from different
   *   worker_threads — get independent locks and serialize correctly.
   *   (POSIX fcntl byte-range locks are per-PROCESS and would silently
   *   collapse cross-thread serialization, so we cannot use them here.)
   *   The lock is released when close() is called or the fd is closed.
   *   Supports blocking, non-blocking, and timeout.
   *
   * On destruction: closes fd.
   */
  class FfshFile : NonCopyable {
   public:
    int fd = -1;

    /** Open by absolute path (UTF-8) for sequential reading. */
    explicit FfshFile(const char * path) noexcept { this->fd = open_rd(path); }

    /** Open relative to a directory fd via openat().
     *  Avoids a second full path resolution when the file has already been
     *  located relative to an open directory (e.g. from fstatat). */
    FfshFile(int dir_fd, const char * rel_path) noexcept {
#  ifdef __linux__
      this->fd = openat_eintr_(dir_fd, rel_path, O_RDONLY | O_CLOEXEC | O_NOATIME);
      if (this->fd < 0 && errno == EPERM) [[unlikely]] {
        this->fd = openat_eintr_(dir_fd, rel_path, O_RDONLY | O_CLOEXEC);
      }
#  else
      this->fd = openat_eintr_(dir_fd, rel_path, O_RDONLY | O_CLOEXEC);
#  endif
    }

    FfshFile() noexcept = default;

    ~FfshFile() noexcept {
      if (this->fd >= 0) {
        close_fd(this->fd);
      }
    }

    FfshFile(FfshFile && other) noexcept : fd(other.fd) { other.fd = -1; }

    FfshFile & operator=(FfshFile && other) noexcept {
      if (this != &other) {
        if (this->fd >= 0) {
          close_fd(this->fd);
        }
        this->fd = other.fd;
        other.fd = -1;
      }
      return *this;
    }

    /** Returns true if the file was opened successfully. */
    FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->fd >= 0; }

    /** Close the fd (releases any flock). Safe to call multiple times. */
    inline void close() noexcept {
      if (this->fd >= 0) {
        close_fd(this->fd);
        this->fd = -1;
      }
    }

    /** Release ownership of the fd without closing. Caller is responsible for closing. */
    inline int release() noexcept {
      const int f = this->fd;
      this->fd = -1;
      return f;
    }

    /**
     * Lock cancellation token — POSIX implementation.
     *
     * All cancellable lock paths use poll_lock_ (non-blocking flock(LOCK_NB)
     * with exponential backoff). fire() sets fired_=true; poll_lock_ checks
     * is_fired() between attempts and exits promptly.
     *
     * Why not close the fd to wake a blocked flock?
     * POSIX doesn't guarantee that closing an fd from thread B wakes a
     * blocked flock() on that fd in thread A. Polling with non-blocking
     * flock(LOCK_NB) is the only portable approach.
     */
    struct LockCancelList;

    struct LockCancel : NonCopyable {
      std::atomic<bool> fired_{false};
      const volatile uint8_t * cancelByte_ = nullptr;
      LockCancel * prev_ = nullptr;
      LockCancel * next_ = nullptr;
      LockCancelList * list_ = nullptr;

      bool is_fired() const noexcept {
        return this->fired_.load(std::memory_order_acquire) || (this->cancelByte_ && *this->cancelByte_ != 0);
      }

      /** Signal cancellation. Safe to call from any thread, multiple times. */
      void fire() noexcept {
        this->fired_.store(true, std::memory_order_release);
      }
    };

    /** JS-thread-only doubly-linked list of active LockCancel tokens.
     *  Workers register on construction, unregister on destruction.
     *  fire_all() before pool.shutdown() ensures poll_lock_ threads see
     *  is_fired()==true and exit within one sleep interval. */
    struct LockCancelList {
      LockCancel * head_ = nullptr;

      void add(LockCancel * c) noexcept {
        c->list_ = this;
        c->prev_ = nullptr;
        c->next_ = this->head_;
        if (this->head_) {
          this->head_->prev_ = c;
        }
        this->head_ = c;
      }

      void remove(LockCancel * c) noexcept {
        if (c->list_ != this) {
          return;
        }
        if (c->prev_) {
          c->prev_->next_ = c->next_;
        } else {
          this->head_ = c->next_;
        }
        if (c->next_) {
          c->next_->prev_ = c->prev_;
        }
        c->list_ = nullptr;
      }

      void fire_all() noexcept {
        for (LockCancel * c = this->head_; c; c = c->next_) {
          c->fire();
        }
      }

      /** Find the LockCancel whose cancelByte_ matches the given pointer and fire it.
       *  Called from JS thread when AbortSignal fires (via cacheFireCancel). */
      bool fire_by_cancel_byte(const volatile uint8_t * cancelByte) noexcept {
        if (!cancelByte) {
          return false;
        }
        for (LockCancel * c = this->head_; c; c = c->next_) {
          if (c->cancelByte_ == cancelByte) {
            c->fire();
            return true;
          }
        }
        return false;
      }
    };

    /**
     * Open-or-create a cache file and acquire an exclusive flock(2) lock.
     *
     * Returns an invalid FfshFile on failure (lock contention, timeout, cancel, I/O error).
     * Callers check `if (!file)` — lock failure is a normal status, not an exception.
     *
     * @param path      Cache file path.
     * @param timeoutMs -1 = block forever, 0 = non-blocking try, >0 = timeout in ms.
     * @param cancel    Optional LockCancel — fire() sets fired_ flag; poll_lock_ exits within one sleep.
     * @return FfshFile with the locked fd, or invalid on failure.
     */
    static FSH_NO_INLINE FfshFile open_locked(
      const char * path,
      int timeoutMs,
      LockCancel * cancel = nullptr) noexcept {
      FfshFile f;

      if (!path || path[0] == '\0') [[unlikely]] {
        return f;
      }
      if (strlen(path) >= FSH_MAX_PATH) [[unlikely]] {
        return f;
      }

      f.fd = open_rw_mkdir_fd_(path);
      if (f.fd < 0) [[unlikely]] {
        return f;
      }

      if (timeoutMs == 0) {
        if (flock_op_(f.fd, LOCK_EX | LOCK_NB) != 0) [[unlikely]] {
          f.close();
          return f;
        }
      } else if (cancel) {
        // Cancel present: poll with non-blocking flock + exponential backoff.
        // cacheFireCancel (called from JS) sets fired_ flag; poll_lock_ checks
        // is_fired() between attempts and exits within one sleep interval (≤25ms).
        if (poll_lock_(f.fd, LOCK_EX, timeoutMs < 0 ? INT_MAX : timeoutMs, cancel) != 0) [[unlikely]] {
          f.close();
          return f;
        }
      } else if (timeoutMs < 0) {
        if (flock_op_(f.fd, LOCK_EX) != 0) [[unlikely]] {
          f.close();
          return f;
        }
      } else {
        // Finite timeout, no cancel: poll with backoff.
        if (poll_lock_(f.fd, LOCK_EX, timeoutMs, nullptr) != 0) [[unlikely]] {
          f.close();
          return f;
        }
      }

      return f;
    }

    /** Open-or-create a file for read/write with mkdir-p. No locking. */
    static FSH_NO_INLINE FfshFile open_rw(const char * path) noexcept {
      FfshFile f;
      if (!path || path[0] == '\0') [[unlikely]] {
        return f;
      }
      f.fd = open_rw_mkdir_fd_(path);
      return f;
    }

    /** Non-blocking check: returns true if the file is currently locked by another holder.
     *  Opens a fresh fd (a new OFD) and tries flock(LOCK_EX|LOCK_NB). Since flock locks
     *  are per-OFD, this correctly competes with holders in this process *and* in others.
     *  Releases the trial lock immediately on success (or via close on failure). */
    static inline bool is_locked(const char * cachePath) noexcept {
      if (!cachePath || cachePath[0] == '\0') [[unlikely]] {
        return false;
      }
      const int fd = open_eintr_(cachePath, O_RDONLY | O_CLOEXEC);
      if (fd < 0) [[unlikely]] {
        return false;
      }
      const int rc = flock_op_(fd, LOCK_EX | LOCK_NB);
      if (rc == 0) {
        // Got the lock — file was unlocked. Release before closing for clarity.
        flock_op_(fd, LOCK_UN);
      }
      ::close(fd);
      return rc != 0;
    }

    /**
     * Wait until the file is no longer exclusively locked, or timeout/cancellation.
     *
     * Without cancel: blocking flock(LOCK_SH) blocks with zero CPU until the
     * exclusive holder releases. With cancel or finite timeout: poll_lock_
     * with non-blocking flock(LOCK_SH | LOCK_NB) + exponential backoff.
     *
     * @param cachePath  File path.
     * @param timeoutMs  -1 = block forever, 0 = non-blocking, >0 = timeout in ms.
     * @param cancel     Optional LockCancel — fire() sets fired_ flag; poll exits within one sleep.
     * @return true if the file is (now) unlocked, false on timeout/cancel/error.
     */
    static FSH_NO_INLINE bool wait_unlocked(
      const char * cachePath, int timeoutMs, LockCancel * cancel = nullptr) noexcept {
      if (!cachePath || cachePath[0] == '\0') [[unlikely]] {
        return true;
      }
      const int fd = open_eintr_(cachePath, O_RDONLY | O_CLOEXEC);
      if (fd < 0) [[unlikely]] {
        return true;  // Can't open → not locked (or doesn't exist)
      }

      bool acquired = false;
      if (timeoutMs == 0) {
        acquired = flock_op_(fd, LOCK_SH | LOCK_NB) == 0;
      } else if (cancel) {
        // Cancel present: poll with non-blocking flock + backoff.
        // See open_locked comment — POSIX doesn't guarantee fd-close wakes blocked flock.
        acquired = poll_lock_(fd, LOCK_SH, timeoutMs < 0 ? INT_MAX : timeoutMs, cancel) == 0;
      } else if (timeoutMs < 0) {
        acquired = flock_op_(fd, LOCK_SH) == 0;
      } else {
        acquired = poll_lock_(fd, LOCK_SH, timeoutMs, nullptr) == 0;
      }

      // close() releases the flock — no explicit LOCK_UN needed.
      ::close(fd);
      return acquired;
    }

    /**
     * Read up to len bytes into buf. Returns bytes read (> 0), 0 on EOF, or -1 on error.
     * Retries automatically on EINTR.
     */
    FSH_FORCE_INLINE int64_t read(void * buf, size_t len) noexcept {
      for (;;) {
        ssize_t n = ::read(this->fd, buf, len);
        if (n >= 0) [[likely]] {
          return static_cast<int64_t>(n);
        }
        if (errno == EINTR) [[likely]] {
          continue;
        }
        return -1;
      }
    }

    /**
     * Read up to len bytes into buf, retrying until len bytes are read,
     * EOF is reached, or an error occurs.
     */
    FSH_FORCE_INLINE int64_t read_at_most(void * buf, size_t len) noexcept {
      size_t total = 0;
      auto * p = static_cast<unsigned char *>(buf);
      while (total < len) {
        const int64_t n = this->read(p + total, len - total);
        if (n <= 0) [[unlikely]] {
          return total > 0 ? static_cast<int64_t>(total) : n;
        }
        total += static_cast<size_t>(n);
      }
      return static_cast<int64_t>(total);
    }

    /** Return the file size in bytes, or -1 on error. */
    inline int64_t fsize() const noexcept {
      struct stat st{};
      if (fstat_eintr_(this->fd, st) != 0) {
        return -1;
      }
      return static_cast<int64_t>(st.st_size);
    }

    /** Write all bytes. Returns true on success.
     *  Retries on EINTR. Treats n <= 0 (other than EINTR) as fatal. */
    inline bool write_all(const uint8_t * data, size_t len) noexcept {
      size_t total = 0;
      while (total < len) {
        const ssize_t n = ::write(this->fd, data + total, len - total);
        if (n > 0) [[likely]] {
          total += static_cast<size_t>(n);
          continue;
        }
        if (n == 0 || errno != EINTR) [[likely]] {
          return false;
        }
      }
      return true;
    }

    /** Truncate the file to the given length. Returns true on success. */
    inline bool truncate(size_t len) noexcept { return ftruncate_eintr_(this->fd, static_cast<off_t>(len)) == 0; }

    /** Pre-allocate contiguous space. Best-effort, failure is ignored. */
    inline void preallocate(size_t len) noexcept {
#  if defined(__APPLE__) && defined(F_PREALLOCATE)
      fstore_t fst{};
      fst.fst_flags = F_ALLOCATECONTIG;  // try contiguous first
      fst.fst_posmode = F_PEOFPOSMODE;
      fst.fst_length = static_cast<off_t>(len);
      if (::fcntl(this->fd, F_PREALLOCATE, &fst) != 0) {
        fst.fst_flags = F_ALLOCATEALL;  // fall back to non-contiguous
        ::fcntl(this->fd, F_PREALLOCATE, &fst);
      }
#  elif defined(__linux__)
      ::posix_fallocate(this->fd, 0, static_cast<off_t>(len));
#  endif
    }

    /** Seek to a position from the beginning of the file. Returns true on success. */
    inline bool seek(size_t offset) noexcept { return ::lseek(this->fd, static_cast<off_t>(offset), SEEK_SET) >= 0; }

    /** Close a raw fd. */
    static inline void close_fd(int f) noexcept { ::close(f); }

    /** fstatat: stat relative to a directory fd. Falls back to stat() when dir_fd < 0. */
    static FSH_FORCE_INLINE bool stat_into_at(int dir_fd, const char * path, CacheEntry & entry) noexcept {
      struct stat st;
      if (dir_fd >= 0) {
        if (fstatat_eintr_(dir_fd, path, st, 0) != 0) [[unlikely]] {
          entry.clearStat();
          return false;
        }
      } else {
        if (stat_eintr_(path, st) != 0) [[unlikely]] {
          entry.clearStat();
          return false;
        }
      }
      return stat_from_struct_(st, entry);
    }

    /** fstat: stat an already-open file descriptor. */
    static FSH_FORCE_INLINE bool fstat_into(int fd, CacheEntry & entry) noexcept {
      struct stat st;
      if (fstat_eintr_(fd, st) != 0) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      return stat_from_struct_(st, entry);
    }

    /** Open a file for reading only (no lock). Returns raw fd, -1 on error. */
    static inline int open_rd(const char * path) noexcept {
#  ifdef __linux__
      int f = open_eintr_(path, O_RDONLY | O_CLOEXEC | O_NOATIME);
      if (f < 0 && errno == EPERM) [[unlikely]] {
        f = open_eintr_(path, O_RDONLY | O_CLOEXEC);
      }
      return f;
#  else
      return open_eintr_(path, O_RDONLY | O_CLOEXEC);
#  endif
    }

   private:
    /** Apply a flock(2) operation, retrying on EINTR.
     *  `op` is one of LOCK_SH/LOCK_EX/LOCK_UN, optionally OR'd with LOCK_NB.
     *  Returns 0 on success, -1 on error (errno set). For LOCK_NB contention,
     *  errno is EWOULDBLOCK (== EAGAIN on every supported POSIX target). */
    static FSH_FORCE_INLINE int flock_op_(int fd, int op) noexcept {
      for (;;) {
        const int rc = ::flock(fd, op);
        if (rc == 0) [[likely]] {
          return 0;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    //
    // EINTR-safe syscall wrappers.
    //
    // Node.js uses libuv which installs signal handlers (SIGCHLD, SIGPIPE,
    // SIGWINCH, etc.), so any slow syscall we make can return -1/EINTR even
    // though the user didn't do anything. Retry all interruptible syscalls.
    //

    /** EINTR-safe fstat. */
    static FSH_FORCE_INLINE int fstat_eintr_(int fd, struct stat & st) noexcept {
      for (;;) {
        const int rc = ::fstat(fd, &st);
        if (rc == 0) [[likely]] {
          return 0;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** EINTR-safe stat. */
    static FSH_FORCE_INLINE int stat_eintr_(const char * path, struct stat & st) noexcept {
      for (;;) {
        const int rc = ::stat(path, &st);
        if (rc == 0) [[likely]] {
          return 0;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** EINTR-safe fstatat. */
    static FSH_FORCE_INLINE int fstatat_eintr_(int dir_fd, const char * path, struct stat & st, int flags) noexcept {
      for (;;) {
        const int rc = ::fstatat(dir_fd, path, &st, flags);
        if (rc == 0) [[likely]] {
          return 0;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** EINTR-safe open(path, flags). */
    static FSH_FORCE_INLINE int open_eintr_(const char * path, int flags) noexcept {
      for (;;) {
        const int rc = ::open(path, flags);
        if (rc >= 0) [[likely]] {
          return rc;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** EINTR-safe open(path, flags, mode). */
    static FSH_FORCE_INLINE int open_eintr_(const char * path, int flags, mode_t mode) noexcept {
      for (;;) {
        const int rc = ::open(path, flags, mode);
        if (rc >= 0) [[likely]] {
          return rc;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** EINTR-safe openat. */
    static FSH_FORCE_INLINE int openat_eintr_(int dir_fd, const char * rel_path, int flags) noexcept {
      for (;;) {
        const int rc = ::openat(dir_fd, rel_path, flags);
        if (rc >= 0) [[likely]] {
          return rc;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** EINTR-safe ftruncate. */
    static FSH_FORCE_INLINE int ftruncate_eintr_(int fd, off_t len) noexcept {
      for (;;) {
        const int rc = ::ftruncate(fd, len);
        if (rc == 0) [[likely]] {
          return 0;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    /** Sleep for the given number of milliseconds via nanosleep.
     *  EINTR-safe: nanosleep updates the remaining-time argument on EINTR,
     *  so we loop until the full duration has elapsed. Without this, a stray
     *  signal (libuv, SIGCHLD, etc.) would cut the backoff short and turn the
     *  poll loop into a busy spin. */
    static FSH_NO_INLINE void poll_sleep_(int ms) noexcept {
      struct timespec ts{};
      ts.tv_sec = ms / 1000;
      ts.tv_nsec = (ms % 1000) * 1000000L;
      while (::nanosleep(&ts, &ts) != 0) {
        if (errno != EINTR) {
          return;
        }
        // ts now contains the remaining time — loop and sleep the rest.
      }
    }

    /**
     * Polling lock acquisition with timeout and optional cancellation.
     * Non-blocking flock(LOCK_NB) with exponential backoff (1ms → 25ms cap).
     * @param fd        File descriptor to lock.
     * @param lock_type LOCK_EX or LOCK_SH (LOCK_NB is added internally).
     * @param timeoutMs Maximum wait in ms.
     * @param cancel    Optional cancellation token.
     * @return 0 on success, -1 on timeout/cancel/error.
     */
    static FSH_NO_INLINE int poll_lock_(
      int fd, int lock_type, int timeoutMs, LockCancel * cancel = nullptr) noexcept {
      if (cancel && cancel->is_fired()) [[unlikely]] {
        return -1;
      }
      struct timespec start;
      clock_gettime(CLOCK_MONOTONIC, &start);
      int sleepMs = 1;
      const int try_op = lock_type | LOCK_NB;
      for (;;) {
        if (::flock(fd, try_op) == 0) {
          return 0;
        }
        // EWOULDBLOCK is the contention case. EAGAIN == EWOULDBLOCK on Linux/macOS/FreeBSD,
        // but check both names defensively. Anything else is a real error.
        const int e = errno;
        if (e != EWOULDBLOCK && e != EAGAIN && e != EINTR) [[unlikely]] {
          return -1;
        }
        if (cancel && cancel->is_fired()) [[unlikely]] {
          return -1;
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        const int64_t elapsedMs = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsedMs >= static_cast<int64_t>(timeoutMs)) [[unlikely]] {
          return -1;
        }
        // Clamp sleep to remaining timeout so we don't overshoot
        const int remainMs = static_cast<int>(static_cast<int64_t>(timeoutMs) - elapsedMs);
        int actualSleep = sleepMs < remainMs ? sleepMs : remainMs;
        if (actualSleep < 1) {
          actualSleep = 1;
        }
        poll_sleep_(actualSleep);
        // Advance the backoff interval (independent of clamping)
        if (sleepMs < 25) {
          sleepMs = sleepMs * 2;
          if (sleepMs > 25) {
            sleepMs = 25;
          }
        }
      }
    }

    static inline int open_rw_fd_(const char * path) noexcept {
      return open_eintr_(path, O_RDWR | O_CREAT | O_CLOEXEC, 0666);
    }

    static inline int mkdir_p(const char * path, size_t len) noexcept {
      char buf[FSH_MAX_PATH];
      if (len >= sizeof(buf)) {
        return -1;
      }
      memcpy(buf, path, len);
      buf[len] = '\0';
      for (size_t i = 1; i < len; ++i) {
        if (buf[i] == '/') {
          buf[i] = '\0';
          if (::mkdir(buf, 0777) != 0 && errno != EEXIST) {
            return -1;
          }
          buf[i] = '/';
        }
      }
      return (::mkdir(buf, 0777) == 0 || errno == EEXIST) ? 0 : -1;
    }

    static inline int open_rw_mkdir_fd_(const char * path) noexcept {
      int f = open_rw_fd_(path);
      if (f >= 0 || errno != ENOENT) [[likely]] {
        return f;
      }
      const size_t len = strlen(path);
      size_t sep = len;
      while (sep > 0 && path[sep - 1] != '/')
        --sep;
      if (sep > 1 && mkdir_p(path, sep - 1) == 0) {
        f = open_rw_fd_(path);
      }
      return f;
    }

    static FSH_FORCE_INLINE bool stat_from_struct_(const struct stat & st, CacheEntry & entry) noexcept {
#  if defined(__APPLE__)
      const uint64_t mtimeNs =
        static_cast<uint64_t>(st.st_mtimespec.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_mtimespec.tv_nsec);
      const uint64_t ctimeNs =
        static_cast<uint64_t>(st.st_ctimespec.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_ctimespec.tv_nsec);
#  else
      const uint64_t mtimeNs =
        static_cast<uint64_t>(st.st_mtim.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_mtim.tv_nsec);
      const uint64_t ctimeNs =
        static_cast<uint64_t>(st.st_ctim.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_ctim.tv_nsec);
#  endif

      entry.writeStat(
        static_cast<uint64_t>(st.st_ino) & INO_VALUE_MASK, mtimeNs, ctimeNs, static_cast<uint64_t>(st.st_size));
      return true;
    }
  };

  /** RAII directory fd for fstatat()/openat() — avoids repeated kernel path
   *  resolution of the root prefix. Skipped for small file counts where the
   *  open()+close() overhead dominates. Falls back gracefully (fd < 0). */
  struct DirFd : NonCopyable {
    int fd;

    /** Default-construct an invalid DirFd (fd = -1). Used when the actual open is deferred. */
    DirFd() noexcept : fd(-1) {}

    explicit DirFd(const char * root_path, size_t file_count) noexcept : fd(-1) {
      if (file_count < MIN_DIR_FD_FILES) {
        return;
      }
      // EINTR-safe open loop (libuv/Node may deliver signals mid-syscall).
      for (;;) {
        const int rc = ::open(root_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (rc >= 0) {
          this->fd = rc;
          return;
        }
        if (errno != EINTR) {
          return;
        }
      }
    }

    ~DirFd() noexcept {
      if (fd >= 0) {
        ::close(fd);
      }
    }

    /** Move constructor — transfers ownership of the fd. */
    DirFd(DirFd && other) noexcept : fd(other.fd) { other.fd = -1; }

    /** Move assignment — closes any owned fd, then transfers ownership. */
    DirFd & operator=(DirFd && other) noexcept {
      if (this != &other) {
        if (this->fd >= 0) {
          ::close(this->fd);
        }
        this->fd = other.fd;
        other.fd = -1;
      }
      return *this;
    }
  };

#  include "hash-file-helpers.h"

  /**
   * Per-thread path resolver for cache stat/hash workers.
   *
   * Concatenates a root prefix with relative packed paths into a fixed
   * path_buf: [rootPath/][relativePath\0]. On POSIX, optionally uses a
   * DirFd for fstatat()/openat() — avoids repeated kernel path resolution
   * of the root prefix when many files share the same directory.
   *
   * Lifecycle: init() once with root path, then resolve()+stat/hash per file.
   */
  struct PathResolver : NonCopyable {
    char path_buf[FSH_MAX_PATH];
    const DirFd * dir;
    size_t prefix_len;

    FSH_FORCE_INLINE void init(const DirFd & dir_fd, const char * root_path, size_t root_path_len) noexcept {
      this->dir = &dir_fd;
      size_t len = root_path_len;
      if (len > 0 && root_path[len - 1] == '/') [[likely]] {
        --len;
      }
      if (len >= FSH_MAX_PATH - 1) [[unlikely]] {
        len = FSH_MAX_PATH - 2;
      }
      memcpy(this->path_buf, root_path, len);
      this->path_buf[len] = '/';
      this->prefix_len = len + 1;
    }

    FSH_FORCE_INLINE void resolve(const uint8_t * packed_path, size_t path_len) noexcept {
      char * dst = this->path_buf + this->prefix_len;
      memcpy(dst, packed_path, path_len);
      dst[path_len] = '\0';
    }

    FSH_FORCE_INLINE bool stat_into(CacheEntry & entry) const noexcept {
      const char * path = this->dir->fd >= 0 ? this->path_buf + this->prefix_len : this->path_buf;
      return FfshFile::stat_into_at(this->dir->fd, path, entry);
    }

    FSH_FORCE_INLINE FfshFile open_file() const noexcept {
      if (this->dir->fd >= 0) {
        return FfshFile(this->dir->fd, this->path_buf + this->prefix_len);
      }
      return FfshFile(this->path_buf);
    }

    FSH_FORCE_INLINE void hash_file(Hash128 & dest, unsigned char * rbuf, size_t rbs) const noexcept {
      FfshFile rf = this->open_file();
      if (!rf) [[unlikely]] {
        dest.set_zero();
        return;
      }
      hash_open_file(rf, dest, rbuf, rbs);
    }

    /** Combined stat + hash: opens file once, fstats the fd, then reads and hashes.
     *  Saves one syscall vs separate stat_into() + hash_file(). */
    FSH_FORCE_INLINE bool stat_and_hash_file(
      CacheEntry & entry, Hash128 & dest, unsigned char * rbuf, size_t rbs) const noexcept {
      FfshFile rf = this->open_file();
      if (!rf) [[unlikely]] {
        entry.clearStat();
        dest.set_zero();
        return false;
      }
      if (!FfshFile::fstat_into(rf.fd, entry)) [[unlikely]] {
        dest.set_zero();
        return false;
      }
#  if defined(__APPLE__) && defined(F_RDADVISE)
      // Kick off kernel readahead for large files while we set up hashing.
      if (entry.size > rbs) {
        struct radvisory ra;
        ra.ra_offset = 0;
        ra.ra_count = static_cast<int>(entry.size <= INT_MAX ? entry.size : INT_MAX);
        ::fcntl(rf.fd, F_RDADVISE, &ra);
      }
#  endif
      hash_open_file(rf, dest, rbuf, rbs);
      return true;
    }
  };

}  // namespace fast_fs_hash

#endif  // !_WIN32

#endif
