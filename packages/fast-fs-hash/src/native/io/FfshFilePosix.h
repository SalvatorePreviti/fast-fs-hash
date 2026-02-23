#ifndef _FAST_FS_HASH_FFSH_FILE_POSIX_H
#define _FAST_FS_HASH_FFSH_FILE_POSIX_H

#ifndef _WIN32

#  include "../includes.h"
#  include "../file-hash-cache/file-hash-cache-format.h"

namespace fast_fs_hash {

  /**
   * RAII file handle — POSIX implementation.
   *
   * Read-only constructors (hashing hot path):
   *   O_RDONLY | O_CLOEXEC (+ O_NOATIME on Linux).
   *   Supports openat() for dir-fd-relative access.
   *
   * Read/write factories (cache files):
   *   open_read(), open_write(), open_tmp().
   *   Atomic write: open_tmp() → write_all() → commit(dest_path).
   *
   * On destruction: closes fd, and if a tmp_path is set (write mode),
   * unlinks the temp file and frees the path buffer.
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

    ~FfshFile() noexcept { this->cleanup(); }

    FfshFile(FfshFile && other) noexcept : fd(other.fd), tmp_path_(other.tmp_path_), write_start_(other.write_start_) {
      other.fd = -1;
      other.tmp_path_ = nullptr;
    }

    FfshFile & operator=(FfshFile && other) noexcept {
      if (this != &other) {
        this->cleanup();
        this->fd = other.fd;
        this->tmp_path_ = other.tmp_path_;
        this->write_start_ = other.write_start_;
        other.fd = -1;
        other.tmp_path_ = nullptr;
      }
      return *this;
    }

    /** Returns true if the file was opened successfully. */
    FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->fd >= 0; }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /** Close the fd. Safe to call multiple times. Does NOT unlink tmp. */
    inline void close() noexcept {
      if (this->fd >= 0) {
        close_fd(this->fd);
        this->fd = -1;
      }
    }

    /** Release ownership of the fd without closing or unlinking. Frees tmp_path. */
    inline int release() noexcept {
      const int f = this->fd;
      this->fd = -1;
      free(this->tmp_path_);
      this->tmp_path_ = nullptr;
      return f;
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

    /**
     * Close the fd and atomically rename tmp → dest.
     * On rename failure, checks "newer wins".
     * Returns true on success. Frees tmp_path regardless.
     */
    inline bool commit(const char * dest_path) noexcept {
      this->close();
      char * tmp = this->tmp_path_;
      const auto ws = this->write_start_;
      this->tmp_path_ = nullptr;

      if (!tmp) return false;

      if (::rename(tmp, dest_path) == 0) [[likely]] {
        free(tmp);
        return true;
      }

      // "Newer wins": if dest was modified after we started, accept it
      ::unlink(tmp);
      const bool ok = file_modified_since(dest_path, ws);
      free(tmp);
      return ok;
    }

    // ── Static factories ───────────────────────────────────────────────

    /** Open a file for reading. */
    static inline FfshFile open_read(const char * path) noexcept {
      FfshFile f;
      f.fd = open_rd(path);
      return f;
    }

    /** Open a file for writing (with mkdir on ENOENT). No tmp cleanup. */
    static inline FfshFile open_write(const char * path) noexcept {
      FfshFile f;
      f.fd = open_wr_mkdir(path);
      return f;
    }

    /**
     * Open a temp file for atomic writing.
     * Generates a unique tmp path from cache_path (appends .PID_SEQ.tmp).
     */
    static inline FfshFile open_tmp(const char * cache_path) noexcept {
      FfshFile f;
      const size_t path_len = strlen(cache_path);
      auto * buf = static_cast<char *>(malloc(path_len + 64));
      if (!buf) return f;
      make_tmp_path(buf, cache_path, path_len);
      f.tmp_path_ = buf;
      f.write_start_ = get_time();
      f.fd = open_wr_mkdir(buf);
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

    /** Standalone atomic rename with newer-wins. */
    static inline bool atomic_rename(const char * tmp_path, const char * dest_path) noexcept {
      const WriteTime ws = get_time();
      if (::rename(tmp_path, dest_path) == 0) [[likely]]
        return true;
      if (file_modified_since(dest_path, ws)) {
        ::unlink(tmp_path);
        return true;
      }
      ::unlink(tmp_path);
      return false;
    }

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
    char * tmp_path_ = nullptr;

    struct WriteTime {
      struct timespec ts{};
    };

    WriteTime write_start_{};

    // ── Cleanup ────────────────────────────────────────────────────────

    inline void cleanup() noexcept {
      if (this->fd >= 0) {
        close_fd(this->fd);
        this->fd = -1;
      }
      if (this->tmp_path_) {
        ::unlink(this->tmp_path_);
        free(this->tmp_path_);
        this->tmp_path_ = nullptr;
      }
    }

    // ── Timestamp helpers ──────────────────────────────────────────────

    static inline WriteTime get_time() noexcept {
      WriteTime t{};
      clock_gettime(CLOCK_REALTIME, &t.ts);
      return t;
    }

    static inline bool file_modified_since(const char * path, WriteTime start) noexcept {
      struct stat st{};
      if (::stat(path, &st) != 0) return false;
#  if defined(__APPLE__)
      const auto & mts = st.st_mtimespec;
#  else
      const auto & mts = st.st_mtim;
#  endif
      return mts.tv_sec > start.ts.tv_sec || (mts.tv_sec == start.ts.tv_sec && mts.tv_nsec >= start.ts.tv_nsec);
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

    // ── Temp path generation ───────────────────────────────────────────

    static inline void make_tmp_path(char * dst, const char * cache_path, size_t path_len) noexcept {
      static std::atomic<uint32_t> counter{0};
      const uint32_t seq = counter.fetch_add(1, std::memory_order_relaxed);
      char suffix[64];
      const int suffix_len = snprintf(suffix, sizeof(suffix), ".%u_%x.tmp", static_cast<unsigned>(getpid()), seq);
      memcpy(dst, cache_path, path_len);
      memcpy(dst + path_len, suffix, static_cast<size_t>(suffix_len) + 1);
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
