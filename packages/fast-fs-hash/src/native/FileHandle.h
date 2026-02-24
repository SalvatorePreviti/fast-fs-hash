#ifndef _FAST_FS_HASH_FILE_HANDLE_H
#define _FAST_FS_HASH_FILE_HANDLE_H

#include "includes.h"

namespace fast_fs_hash {

#ifndef _WIN32

  /** RAII file handle wrapping a POSIX file descriptor, opened for sequential reading.
   *  Applies OS-level read-ahead hints (F_RDAHEAD on macOS, posix_fadvise on Linux).
   *  Uses O_NOATIME on Linux to avoid unnecessary atime metadata writes. */
  class FileHandle : NonCopyable {
    int fd_;

   public:
    explicit FileHandle(const char * path) noexcept {
#  ifdef __linux__
      // O_NOATIME avoids atime metadata writes — significant I/O saving.
      // Requires ownership of the file or CAP_FOWNER; silently retry without it.
      this->fd_ = ::open(path, O_RDONLY | O_CLOEXEC | O_NOATIME);
      if (this->fd_ < 0 && errno == EPERM) [[unlikely]] {
        this->fd_ = ::open(path, O_RDONLY | O_CLOEXEC);
      }
#  else
      this->fd_ = ::open(path, O_RDONLY | O_CLOEXEC);
#  endif
    }

    /** Advise the OS that we'll read this file sequentially.
     *  Only useful for multi-read (large file) paths — the one-shot
     *  hot path skips this to avoid the extra syscall. */
    FSH_FORCE_INLINE void hint_sequential() noexcept {
#  ifdef F_RDAHEAD
      fcntl(this->fd_, F_RDAHEAD, 1);
#  endif
#  ifdef POSIX_FADV_SEQUENTIAL
      posix_fadvise(this->fd_, 0, 0, POSIX_FADV_SEQUENTIAL);
#  endif
    }

    ~FileHandle() noexcept {
      if (this->fd_ >= 0) {
        ::close(this->fd_);
      }
    }

    /** Returns true if the file was opened successfully. */
    FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->fd_ >= 0; }

    /**
     * Read up to len bytes into buf. Returns bytes read (> 0), 0 on EOF, or -1 on error.
     * Retries automatically on EINTR (signal interruption).
     */
    FSH_FORCE_INLINE int64_t read(void * buf, size_t len) noexcept {
      for (;;) {
        ssize_t n = ::read(this->fd_, buf, len);
        if (n >= 0) [[likely]] {
          return static_cast<int64_t>(n);
        }
        if (errno == EINTR) [[likely]] {
          continue;
        }
        return -1;
      }
    }
  };

#else  // _WIN32, there is always a #ifndef _WIN32. Why? Why Microsoft? Why do you do this, why?

  /**
   * WPath — Windows-only RAII UTF-8 → UTF-16 path converter.
   *
   * Converts once, then the resulting wchar_t pointer can be passed to
   * both FileHandle and file_stat_to without repeating the conversion.
   * Uses a caller-provided scratch buffer when large enough; otherwise
   * heap-allocates (freed on destruction).
   */
  struct WPath : NonCopyable {
    const wchar_t * data = nullptr;

    /**
     * @param utf8_path   NUL-terminated UTF-8 path.
     * @param scratch     Optional pre-allocated wchar_t buffer.
     * @param scratch_cap Capacity of scratch in wchar_t units.
     */
    explicit WPath(const char * utf8_path, wchar_t * scratch = nullptr, int scratch_cap = 0) noexcept {
      int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, nullptr, 0);
      if (wlen <= 0) [[unlikely]]
        return;
      if (scratch && scratch_cap >= wlen) {
        MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, scratch, wlen);
        this->data = scratch;
      } else {
        this->heap_ = static_cast<wchar_t *>(malloc(static_cast<size_t>(wlen) * sizeof(wchar_t)));
        if (!this->heap_) [[unlikely]]
          return;
        MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, this->heap_, wlen);
        this->data = this->heap_;
      }
    }

    ~WPath() noexcept { free(this->heap_); }

    explicit operator bool() const noexcept { return this->data != nullptr; }

   private:
    wchar_t * heap_ = nullptr;
  };

  /** RAII file handle using Win32 CreateFileW for maximum throughput on Windows.
   *  Accepts either a pre-converted UTF-16 path (via WPath) or a raw UTF-8
   *  path (convenience constructor that converts internally). */
  class FileHandle : NonCopyable {
    HANDLE h_;

   public:
    /** Open from a pre-converted UTF-16 path (zero-allocation fast path). */
    explicit FileHandle(const wchar_t * wpath) noexcept : h_(INVALID_HANDLE_VALUE) {
      if (!wpath) [[unlikely]]
        return;
      this->h_ = CreateFileW(
        wpath,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr);
    }

    /** Open from a UTF-8 path (convenience — converts internally via WPath). */
    explicit FileHandle(const char * path) noexcept : h_(INVALID_HANDLE_VALUE) {
      WPath wp(path);
      if (!wp) [[unlikely]]
        return;
      this->h_ = CreateFileW(
        wp.data,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr);
    }

    ~FileHandle() noexcept {
      if (this->h_ != INVALID_HANDLE_VALUE) {
        CloseHandle(this->h_);
      }
    }

    /** Returns true if the file was opened successfully. */
    FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->h_ != INVALID_HANDLE_VALUE; }

    /** No-op on Windows — FILE_FLAG_SEQUENTIAL_SCAN is set at open time. */
    FSH_FORCE_INLINE void hint_sequential() noexcept {}

    /** Read up to len bytes into buf. Returns bytes read (> 0), 0 on EOF, or -1 on error. */
    FSH_FORCE_INLINE int64_t read(void * buf, size_t len) noexcept {
      DWORD to_read = len > 0x7FFFFFFFu ? 0x7FFFFFFFu : static_cast<DWORD>(len);
      DWORD bytes_read = 0;
      if (!ReadFile(this->h_, buf, to_read, &bytes_read, nullptr)) [[unlikely]] {
        return -1;
      }
      return static_cast<int64_t>(bytes_read);
    }
  };

#endif

}  // namespace fast_fs_hash

#endif
