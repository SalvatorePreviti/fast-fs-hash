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
   *   fcntl byte-range lock. The lock is released when close() is called
   *   or the fd is closed. Supports blocking, non-blocking, and timeout.
   *
   * On destruction: closes fd.
   */
  class FfshFile : NonCopyable {
   public:
    int fd = -1;

    /** Open by absolute path (UTF-8) for sequential reading. */
    explicit FfshFile(const char * path) noexcept {
      this->fd = open_rd(path);
      hint_sequential_if_open_();
    }

    /** Open relative to a directory fd via openat().
     *  Avoids a second full path resolution when the file has already been
     *  located relative to an open directory (e.g. from fstatat). */
    FfshFile(int dir_fd, const char * rel_path) noexcept {
#  ifdef __linux__
      this->fd = ::openat(dir_fd, rel_path, O_RDONLY | O_CLOEXEC | O_NOATIME);
      if (this->fd < 0 && errno == EPERM) [[unlikely]] {
        this->fd = ::openat(dir_fd, rel_path, O_RDONLY | O_CLOEXEC);
      }
#  else
      this->fd = ::openat(dir_fd, rel_path, O_RDONLY | O_CLOEXEC);
#  endif
      hint_sequential_if_open_();
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

    /** Close the fd (releases any fcntl lock). Safe to call multiple times. */
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
     * Lock cancellation token — allows another thread to interrupt a blocking
     * fcntl F_SETLKW by closing the fd, causing EBADF.
     *
     * Usage: set(fd) before blocking fcntl, clear() after it returns.
     * Another thread calls fire() to close the fd and interrupt the wait.
     * Thread-safe — fire() is callable from any thread (e.g. shutdown).
     */
    struct LockCancelList;

    struct LockCancel : NonCopyable {
      std::atomic<int> fd_{-1};
      std::atomic<bool> fired_{false};
      const volatile uint8_t * cancelByte_ = nullptr;
      LockCancel * prev_ = nullptr;
      LockCancel * next_ = nullptr;
      LockCancelList * list_ = nullptr;

      void set(int lockFd) noexcept { this->fd_.store(lockFd, std::memory_order_release); }

      void clear() noexcept { this->fd_.store(-1, std::memory_order_release); }

      bool is_fired() const noexcept {
        return this->fired_.load(std::memory_order_acquire) || (this->cancelByte_ && *this->cancelByte_ != 0);
      }

      /** Close the fd to interrupt a blocked fcntl. Safe to call multiple times. */
      void fire() noexcept {
        this->fired_.store(true, std::memory_order_release);
        const int f = this->fd_.exchange(-1, std::memory_order_acq_rel);
        if (f >= 0) {
          ::close(f);
        }
      }
    };

    /** JS-thread-only doubly-linked list of active LockCancel tokens.
     *  Workers register on construction, unregister on destruction.
     *  fire_all() is called before pool.shutdown() to unblock any threads
     *  stuck in fcntl(F_SETLKW). */
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
    };

    /**
     * Open-or-create a cache file and acquire an exclusive fcntl lock.
     *
     * @param path      Cache file path.
     * @param timeoutMs -1 = block forever, 0 = non-blocking try, >0 = timeout in ms.
     * @param outError  Set to an error string on failure.
     * @param cancel    Optional LockCancel — fire() closes the fd to interrupt blocking fcntl.
     * @return FfshFile with the locked fd, or invalid on failure.
     */
    static FSH_NO_INLINE FfshFile open_locked(
      const char * path,
      int timeoutMs,
      const char *& outError,
      LockCancel * cancel = nullptr) noexcept {
      outError = nullptr;
      FfshFile f;

      if (!path || path[0] == '\0') [[unlikely]] {
        outError = "CacheLock: empty cache path";
        return f;
      }
      if (strlen(path) >= FSH_MAX_PATH) [[unlikely]] {
        outError = "CacheLock: cache path too long";
        return f;
      }

      f.fd = open_rw_mkdir(path);
      if (f.fd < 0) [[unlikely]] {
        outError = "CacheLock: failed to open cache file for locking";
        return f;
      }

      if (timeoutMs == 0) {
        if (fcntl_lock_(f.fd, F_SETLK) != 0) [[unlikely]] {
          f.close();
          outError = "CacheLock: lock not available";
          return f;
        }
      } else if (timeoutMs < 0) {
        if (!cancel) {
          // Simple infinite wait — no cancellation needed.
          if (fcntl_lock_(f.fd, F_SETLKW) != 0) [[unlikely]] {
            f.close();
            outError = "CacheLock: failed to acquire exclusive lock";
            return f;
          }
        } else {
          // Infinite wait with cancel: use poll_lock_ so the thread remains
          // interruptible via cancel->is_fired(). Never use blocking F_SETLKW
          // with a cancel token — pool.shutdown() must be able to join all threads.
          if (poll_lock_(f.fd, F_WRLCK, INT_MAX, cancel) != 0) [[unlikely]] {
            f.close();
            outError = cancel->is_fired() ? "CacheLock: lock acquisition cancelled"
                                          : "CacheLock: failed to acquire exclusive lock";
            return f;
          }
        }
      } else {
        // Finite timeout: poll with exponential backoff (+ optional cancel check).
        if (poll_lock_(f.fd, F_WRLCK, timeoutMs, cancel) != 0) [[unlikely]] {
          f.close();
          if (cancel && cancel->is_fired()) {
            outError = "CacheLock: lock acquisition cancelled";
          } else {
            outError = "CacheLock: timed out waiting for exclusive lock";
          }
          return f;
        }
      }

      return f;
    }

    /** Convert this FfshFile to a FfshFileHandle (the raw fd). Releases ownership. */
    FSH_FORCE_INLINE FfshFileHandle to_file_handle() noexcept { return static_cast<FfshFileHandle>(this->release()); }

    /** Create an FfshFile from a FfshFileHandle. Takes ownership. */
    static FSH_FORCE_INLINE FfshFile from_file_handle(FfshFileHandle handle) noexcept {
      FfshFile f;
      if (handle != FFSH_FILE_HANDLE_INVALID) [[likely]] {
        f.fd = static_cast<int>(handle);
      }
      return f;
    }

    /** Non-blocking check: returns true if the file is currently locked by another holder. */
    static inline bool is_locked(const char * cachePath) noexcept {
      if (!cachePath || cachePath[0] == '\0') [[unlikely]] {
        return false;
      }
      const int fd = ::open(cachePath, O_RDONLY | O_CLOEXEC, 0);
      if (fd < 0) [[unlikely]] {
        return false;
      }
      struct flock fl{};
      fl.l_type = F_WRLCK;
      fl.l_whence = SEEK_SET;
      fl.l_start = 0;
      fl.l_len = 1;
      const int rc = ::fcntl(fd, F_GETLK, &fl);
      ::close(fd);
      if (rc != 0) [[unlikely]] {
        return false;
      }
      return fl.l_type != F_UNLCK;
    }

    /**
     * Wait until the file is no longer exclusively locked, or timeout/cancellation.
     *
     * Uses F_SETLKW (shared read lock) — the kernel blocks with zero CPU until
     * the exclusive holder releases. Cancellable via LockCancel::fire() which
     * closes the fd, causing fcntl to return EBADF.
     *
     * @param cachePath  File path.
     * @param timeoutMs  -1 = block forever, 0 = non-blocking, >0 = timeout in ms.
     * @param cancel     Optional LockCancel — fire() closes the fd to interrupt.
     * @return true if the file is (now) unlocked, false on timeout/cancel/error.
     */
    static FSH_NO_INLINE bool wait_unlocked(
      const char * cachePath, int timeoutMs, LockCancel * cancel = nullptr) noexcept {
      if (!cachePath || cachePath[0] == '\0') [[unlikely]] {
        return true;
      }
      const int fd = ::open(cachePath, O_RDONLY | O_CLOEXEC, 0);
      if (fd < 0) [[unlikely]] {
        return true;  // Can't open → not locked (or doesn't exist)
      }

      bool acquired = false;
      bool fd_stolen = false;  // true if fire() already closed our fd
      if (timeoutMs == 0) {
        acquired = fcntl_lock_rd_(fd, F_SETLK) == 0;
      } else if (timeoutMs < 0) {
        if (!cancel) {
          acquired = fcntl_lock_rd_(fd, F_SETLKW) == 0;
        } else if (cancel->cancelByte_) {
          // cancelByte present — poll instead of blocking F_SETLKW.
          acquired = poll_lock_(fd, F_RDLCK, INT_MAX, cancel) == 0;
        } else {
          // fire() can close the fd from another thread → track fd_stolen.
          acquired = fcntl_lock_cancellable_(fd, F_RDLCK, cancel) == 0;
          // Only check fd_stolen when acquisition failed — on success, clear()
          // already disarmed the fd before fire() could close it.
          fd_stolen = !acquired && cancel->is_fired();
        }
      } else {
        acquired = poll_lock_(fd, F_RDLCK, timeoutMs, cancel) == 0;
      }

      // close() releases the fcntl lock — no explicit F_UNLCK needed.
      // Skip if fire() already closed the fd (only possible via fcntl_lock_cancellable_).
      if (!fd_stolen) {
        ::close(fd);
      }
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
      if (::fstat(this->fd, &st) != 0) {
        return -1;
      }
      return static_cast<int64_t>(st.st_size);
    }

    /** Write all bytes. Returns true on success. */
    inline bool write_all(const uint8_t * data, size_t len) noexcept {
      size_t total = 0;
      while (total < len) {
        const ssize_t n = ::write(this->fd, data + total, len - total);
        if (n > 0) {
          total += static_cast<size_t>(n);
          continue;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return false;
      }
      return true;
    }

    /** Truncate the file to the given length. Returns true on success. */
    inline bool truncate(size_t len) noexcept { return ::ftruncate(this->fd, static_cast<off_t>(len)) == 0; }

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
        if (::fstatat(dir_fd, path, &st, 0) != 0) [[unlikely]] {
          entry.clearStat();
          return false;
        }
      } else {
        if (::stat(path, &st) != 0) [[unlikely]] {
          entry.clearStat();
          return false;
        }
      }
      return stat_from_struct_(st, entry);
    }

    /** fstat: stat an already-open file descriptor. */
    static FSH_FORCE_INLINE bool fstat_into(int fd, CacheEntry & entry) noexcept {
      struct stat st;
      if (::fstat(fd, &st) != 0) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      return stat_from_struct_(st, entry);
    }

   private:
    /** Hint sequential access immediately after open (read-only constructors). */
    FSH_FORCE_INLINE void hint_sequential_if_open_() noexcept {
      if (this->fd < 0) [[unlikely]] {
        return;
      }
#  if defined(__APPLE__) && defined(F_RDAHEAD)
      ::fcntl(this->fd, F_RDAHEAD, 1);
#  elif defined(POSIX_FADV_SEQUENTIAL)
      ::posix_fadvise(this->fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#  endif
    }

    /** Apply or try a fcntl lock on byte 0 of fd. Retries on EINTR. */
    static FSH_FORCE_INLINE int fcntl_lock_type_(int fd, int cmd, short lock_type) noexcept {
      struct flock fl{};
      fl.l_type = lock_type;
      fl.l_whence = SEEK_SET;
      fl.l_start = 0;
      fl.l_len = 1;
      for (;;) {
        const int rc = ::fcntl(fd, cmd, &fl);
        if (rc == 0) [[likely]] {
          return 0;
        }
        if (errno == EINTR) [[unlikely]] {
          continue;
        }
        return -1;
      }
    }

    static FSH_FORCE_INLINE int fcntl_lock_(int fd, int cmd) noexcept { return fcntl_lock_type_(fd, cmd, F_WRLCK); }
    static FSH_FORCE_INLINE int fcntl_lock_rd_(int fd, int cmd) noexcept { return fcntl_lock_type_(fd, cmd, F_RDLCK); }

    /**
     * Blocking lock (F_SETLKW) with cancellation via fd-close.
     * Registers the fd with LockCancel so fire() can close it from another thread.
     * Retries on EINTR (spurious signals) unless fire() was called.
     * Returns 0 on success, -1 on cancel or error.
     */
    static FSH_NO_INLINE int fcntl_lock_cancellable_(int fd, short lock_type, LockCancel * cancel) noexcept {
      cancel->set(fd);
      struct flock fl{};
      fl.l_type = lock_type;
      fl.l_whence = SEEK_SET;
      fl.l_start = 0;
      fl.l_len = 1;
      for (;;) {
        const int rc = ::fcntl(fd, F_SETLKW, &fl);
        if (rc == 0) [[likely]] {
          cancel->clear();
          return 0;
        }
        // EBADF = fire() closed our fd (cancellation). EINTR = spurious signal.
        if (errno == EINTR && !cancel->is_fired()) [[unlikely]] {
          continue;
        }
        cancel->clear();
        return -1;
      }
    }

    /**
     * Polling lock acquisition with timeout and optional cancellation.
     * Non-blocking F_SETLK with exponential backoff (1ms → 50ms).
     * Returns 0 on success, -1 on timeout/cancel/error.
     */
    static FSH_NO_INLINE void poll_sleep_(int & sleepMs) noexcept {
      struct timespec ts{};
      ts.tv_nsec = sleepMs * 1000000L;
      ::nanosleep(&ts, nullptr);
      if (sleepMs < 50) {
        sleepMs = sleepMs * 2;
        if (sleepMs > 50) {
          sleepMs = 50;
        }
      }
    }

    static FSH_NO_INLINE int poll_lock_(
      int fd, short lock_type, int timeoutMs, LockCancel * cancel = nullptr) noexcept {
      struct flock fl{};
      fl.l_type = lock_type;
      fl.l_whence = SEEK_SET;
      fl.l_start = 0;
      fl.l_len = 1;
      struct timespec start;
      clock_gettime(CLOCK_MONOTONIC, &start);
      int sleepMs = 1;
      for (;;) {
        if (::fcntl(fd, F_SETLK, &fl) == 0) {
          return 0;
        }
        if (errno != EAGAIN && errno != EACCES) [[unlikely]] {
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
        poll_sleep_(sleepMs);
      }
    }

    static inline int open_rd(const char * path) noexcept {
#  ifdef __linux__
      int f = ::open(path, O_RDONLY | O_CLOEXEC | O_NOATIME);
      if (f < 0 && errno == EPERM) [[unlikely]] {
        f = ::open(path, O_RDONLY | O_CLOEXEC);
      }
      return f;
#  else
      return ::open(path, O_RDONLY | O_CLOEXEC);
#  endif
    }

    static inline int open_rw(const char * path) noexcept { return ::open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0666); }

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

    static inline int open_rw_mkdir(const char * path) noexcept {
      int f = open_rw(path);
      if (f >= 0 || errno != ENOENT) [[likely]] {
        return f;
      }
      const size_t len = strlen(path);
      size_t sep = len;
      while (sep > 0 && path[sep - 1] != '/')
        --sep;
      if (sep > 1 && mkdir_p(path, sep - 1) == 0) {
        f = open_rw(path);
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

    explicit DirFd(const char * root_path, size_t file_count) noexcept :
      fd(file_count >= MIN_DIR_FD_FILES ? ::open(root_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) : -1) {}

    ~DirFd() noexcept {
      if (fd >= 0) {
        ::close(fd);
      }
    }
  };

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
      hash_open_file_(rf, dest, rbuf, rbs);
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
      hash_open_file_(rf, dest, rbuf, rbs);
      return true;
    }

   private:
    static FSH_FORCE_INLINE void hash_open_file_(FfshFile & rf, Hash128 & dest, unsigned char * rbuf, size_t rbs) noexcept {
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
      XXH3_state_t state;
      XXH3_128bits_reset(&state);
      XXH3_128bits_update(&state, rbuf, rbs);
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
  };

}  // namespace fast_fs_hash

#endif  // !_WIN32

#endif
