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
   *   open_read(), open_write(), open_locked().
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

    // ── Read-only constructors (for hashing hot path) ──────────────────

    /** Open by absolute path (UTF-8) for sequential reading. */
    explicit FfshFile(const char * path) noexcept { this->fd = open_rd(path); }

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
    }

    // ── Default + move constructors ─────────────────────────────────────

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

    // ── Lifecycle ──────────────────────────────────────────────────────

    /** Close the fd. Safe to call multiple times. */
    inline void close() noexcept {
      if (this->fd >= 0) {
        close_fd(this->fd);
        this->fd = -1;
      }
    }

    /** Release ownership of the fd without closing. */
    inline int release() noexcept {
      const int f = this->fd;
      this->fd = -1;
      return f;
    }

    // ── Locking ────────────────────────────────────────────────────────

    /**
     * Open-or-create a cache file and acquire an exclusive fcntl lock.
     *
     * @param path      Cache file path.
     * @param timeoutMs -1 = block forever, 0 = non-blocking try, >0 = timeout in ms.
     * @param outError  Set to an error string on failure.
     * @return FfshFile with the locked fd, or invalid on failure.
     */
    static FSH_NO_INLINE FfshFile open_locked(const char * path, int timeoutMs, const char *& outError) noexcept {
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
        if (fcntl_lock_(f.fd, F_SETLKW) != 0) [[unlikely]] {
          f.close();
          outError = "CacheLock: fcntl F_SETLKW failed";
          return f;
        }
      } else {
        struct timespec start;
        clock_gettime(CLOCK_MONOTONIC, &start);
        int sleepUs = 500;

        for (;;) {
          if (fcntl_lock_(f.fd, F_SETLK) == 0) [[likely]] {
            break;
          }
          if (errno != EAGAIN && errno != EACCES) [[unlikely]] {
            f.close();
            outError = "CacheLock: fcntl failed";
            return f;
          }

          struct timespec now;
          clock_gettime(CLOCK_MONOTONIC, &now);
          const int64_t elapsedMs =
            (now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000;
          if (elapsedMs >= static_cast<int64_t>(timeoutMs)) [[unlikely]] {
            f.close();
            outError = "CacheLock: timeout waiting for cache lock";
            return f;
          }

          const struct timespec ts = {0, static_cast<long>(sleepUs) * 1000L};
          ::nanosleep(&ts, nullptr);
          if (sleepUs < 50000) {
            sleepUs += sleepUs / 2;
          }
        }
      }

      return f;
    }

    /** Convert this FfshFile to a FfshFileHandle (the fd itself). Releases ownership. */
    FSH_FORCE_INLINE FfshFileHandle to_file_handle() noexcept {
      const FfshFileHandle h = static_cast<FfshFileHandle>(this->fd);
      this->fd = -1;
      return h;
    }

    /** Create an FfshFile from a FfshFileHandle. Takes ownership. */
    static FSH_FORCE_INLINE FfshFile from_file_handle(FfshFileHandle handle) noexcept {
      FfshFile f;
      if (handle != FFSH_FILE_HANDLE_INVALID) [[likely]] {
        f.fd = static_cast<int>(handle);
      }
      return f;
    }

    /** Release a FfshFileHandle (unlock + close). */
    static inline void release_file_handle(FfshFileHandle handle) noexcept {
      if (handle == FFSH_FILE_HANDLE_INVALID) [[unlikely]] {
        return;
      }
      const int fd = static_cast<int>(handle);
      struct flock fl{};
      fl.l_type   = F_UNLCK;
      fl.l_whence = SEEK_SET;
      fl.l_start  = 0;
      fl.l_len    = 1;
      ::fcntl(fd, F_SETLK, &fl);
      ::close(fd);
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
      fl.l_type   = F_WRLCK;
      fl.l_whence = SEEK_SET;
      fl.l_start  = 0;
      fl.l_len    = 1;
      const int rc = ::fcntl(fd, F_GETLK, &fl);
      ::close(fd);
      if (rc != 0) [[unlikely]] {
        return false;
      }
      return fl.l_type != F_UNLCK;
    }

    // ── Advise the OS about read patterns ──────────────────────────────

    /** Advise the OS that we'll read this file sequentially. */
    FSH_FORCE_INLINE void hint_sequential() noexcept {
#  if defined(__APPLE__) && defined(F_RDAHEAD)
      fcntl(this->fd, F_RDAHEAD, 1);
#  elif defined(POSIX_FADV_SEQUENTIAL)
      posix_fadvise(this->fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#  endif
    }

    // ── Read methods ───────────────────────────────────────────────────

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
      if (::fstat(this->fd, &st) != 0) return -1;
      return static_cast<int64_t>(st.st_size);
    }

    /** Read len bytes from file_offset into dest (positional read). Returns bytes read or -1. */
    inline int64_t pread_at(uint8_t * dest, size_t file_offset, size_t len) const noexcept {
      size_t total = 0;
      while (total < len) {
        const ssize_t n = ::pread(this->fd, dest + total, len - total, static_cast<off_t>(file_offset + total));
        if (n > 0) [[likely]] {
          total += static_cast<size_t>(n);
          continue;
        }
        if (n == 0) break;
        if (errno == EINTR) [[unlikely]]
          continue;
        return total > 0 ? static_cast<int64_t>(total) : -1;
      }
      return static_cast<int64_t>(total);
    }

    // ── Write methods ──────────────────────────────────────────────────

    /** Write all bytes. Returns true on success. */
    inline bool write_all(const uint8_t * data, size_t len) noexcept {
      size_t total = 0;
      while (total < len) {
        const ssize_t n = ::write(this->fd, data + total, len - total);
        if (n > 0) {
          total += static_cast<size_t>(n);
          continue;
        }
        if (errno == EINTR) [[unlikely]]
          continue;
        return false;
      }
      return true;
    }

    /** Truncate the file to the given length. Returns true on success. */
    inline bool truncate(size_t len) noexcept {
      return ::ftruncate(this->fd, static_cast<off_t>(len)) == 0;
    }

    /** Seek to a position from the beginning of the file. Returns true on success. */
    inline bool seek(size_t offset) noexcept {
      return ::lseek(this->fd, static_cast<off_t>(offset), SEEK_SET) >= 0;
    }

    /** Flush file data to disk. Returns true on success. */
    inline bool fsync_data() noexcept {
#  if defined(__APPLE__)
      return ::fcntl(this->fd, F_FULLFSYNC) == 0 || ::fsync(this->fd) == 0;
#  elif defined(__linux__)
      return ::fdatasync(this->fd) == 0;
#  else
      return ::fsync(this->fd) == 0;
#  endif
    }

    // ── Static factories ───────────────────────────────────────────────

    /** Open a file for reading. */
    static inline FfshFile open_read(const char * path) noexcept {
      FfshFile f;
      f.fd = open_rd(path);
      return f;
    }

    /** Open a file for writing (with mkdir on ENOENT). */
    static inline FfshFile open_write(const char * path) noexcept {
      FfshFile f;
      f.fd = open_wr_mkdir(path);
      return f;
    }

    // ── Static helpers ──────────────────────────────────────────────────

    /** pread on an unowned fd (no close on destruct). */
    static inline int64_t pread_fd(int raw_fd, uint8_t * dest, size_t file_offset, size_t len) noexcept {
      size_t total = 0;
      while (total < len) {
        const ssize_t n = ::pread(raw_fd, dest + total, len - total, static_cast<off_t>(file_offset + total));
        if (n > 0) [[likely]] {
          total += static_cast<size_t>(n);
          continue;
        }
        if (n == 0) break;
        if (errno == EINTR) [[unlikely]]
          continue;
        return total > 0 ? static_cast<int64_t>(total) : -1;
      }
      return static_cast<int64_t>(total);
    }

    /** Close a raw fd. */
    static inline void close_fd(int f) noexcept { ::close(f); }

    // ── Stat helpers ──────────────────────────────────────────────────────

    /** stat a file and write raw stat fields into a CacheEntry. Returns false on error. */
    static FSH_FORCE_INLINE bool stat_into(const char * path, CacheEntry & entry) noexcept {
      struct stat st;
      if (::stat(path, &st) != 0) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      return stat_from_struct_(st, entry);
    }

    /** fstatat: stat relative to a directory fd. Falls back to stat() when dir_fd < 0. */
    static FSH_FORCE_INLINE bool stat_into_at(
      int dir_fd, const char * path, CacheEntry & entry) noexcept {
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
    // ── fcntl lock helper ──────────────────────────────────────────────

    /** Apply or try an exclusive fcntl lock on byte 0 of fd. */
    static FSH_FORCE_INLINE int fcntl_lock_(int fd, int cmd) noexcept {
      struct flock fl{};
      fl.l_type   = F_WRLCK;
      fl.l_whence = SEEK_SET;
      fl.l_start  = 0;
      fl.l_len    = 1;
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

    // ── Platform file operations ───────────────────────────────────────

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

    static inline int open_wr(const char * path) noexcept {
      return ::open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0666);
    }

    static inline int open_rw(const char * path) noexcept {
      return ::open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0666);
    }

    static inline int mkdir_p(const char * path, size_t len) noexcept {
      char buf[FSH_MAX_PATH];
      if (len >= sizeof(buf)) return -1;
      memcpy(buf, path, len);
      buf[len] = '\0';
      for (size_t i = 1; i < len; ++i) {
        if (buf[i] == '/') {
          buf[i] = '\0';
          if (::mkdir(buf, 0777) != 0 && errno != EEXIST) return -1;
          buf[i] = '/';
        }
      }
      return (::mkdir(buf, 0777) == 0 || errno == EEXIST) ? 0 : -1;
    }

    static inline int open_wr_mkdir(const char * path) noexcept {
      int f = open_wr(path);
      if (f >= 0 || errno != ENOENT) [[likely]]
        return f;
      const size_t len = strlen(path);
      size_t sep = len;
      while (sep > 0 && path[sep - 1] != '/')
        --sep;
      if (sep > 1 && mkdir_p(path, sep - 1) == 0) {
        f = open_wr(path);
      }
      return f;
    }

    static inline int open_rw_mkdir(const char * path) noexcept {
      int f = open_rw(path);
      if (f >= 0 || errno != ENOENT) [[likely]]
        return f;
      const size_t len = strlen(path);
      size_t sep = len;
      while (sep > 0 && path[sep - 1] != '/')
        --sep;
      if (sep > 1 && mkdir_p(path, sep - 1) == 0) {
        f = open_rw(path);
      }
      return f;
    }

    // ── Stat internal helper ───────────────────────────────────────────

    static FSH_FORCE_INLINE bool stat_from_struct_(
      const struct stat & st, CacheEntry & entry) noexcept {
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

      entry.writeStat(static_cast<uint64_t>(st.st_ino) & INO_VALUE_MASK, mtimeNs, ctimeNs, static_cast<uint64_t>(st.st_size));
      return true;
    }
  };

  // ── DirFd: RAII directory file descriptor ─────────────────────────────

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

  // ── PathResolver: per-thread path resolution context (POSIX) ──────────

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
      hash_open_file_(rf, dest, rbuf, rbs);
      return true;
    }

   private:
    static FSH_FORCE_INLINE void hash_open_file_(
      FfshFile & rf, Hash128 & dest, unsigned char * rbuf, size_t rbs) noexcept {
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
      rf.hint_sequential();
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
