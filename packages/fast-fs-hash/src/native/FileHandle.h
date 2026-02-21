/**
 * Platform abstraction layer for file I/O.
 *
 * Provides a unified RAII FileHandle that wraps:
 *   - POSIX: file descriptor with O_CLOEXEC, O_NOATIME, F_RDAHEAD, posix_fadvise
 *   - Windows: Win32 CreateFileW / ReadFile / GetFileSizeEx for maximum throughput
 *
 * All platform-specific #if/#else is confined to this header,
 * keeping the rest of the codebase platform-agnostic.
 */

#ifndef _FAST_FS_HASH_FILE_HANDLE_H
#define _FAST_FS_HASH_FILE_HANDLE_H

#include "includes.h"

namespace fast_fs_hash {

  // ── RAII file handle ───────────────────────────────────────────────────

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
      if (FSH_UNLIKELY(this->fd_ < 0 && errno == EPERM)) {
        this->fd_ = ::open(path, O_RDONLY | O_CLOEXEC);
      }
#  else
      this->fd_ = ::open(path, O_RDONLY | O_CLOEXEC);
#  endif

      if (FSH_LIKELY(this->fd_ >= 0)) {
#  ifdef F_RDAHEAD
        fcntl(this->fd_, F_RDAHEAD, 1);
#  endif
#  ifdef POSIX_FADV_SEQUENTIAL
        posix_fadvise(this->fd_, 0, 0, POSIX_FADV_SEQUENTIAL);
#  endif
      }
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
        if (FSH_LIKELY(n >= 0)) {
          return static_cast<int64_t>(n);
        }
        if (FSH_LIKELY(errno == EINTR)) {
          continue;
        }
        return -1;
      }
    }
  };

#else  // _WIN32, there is always a #ifndef _WIN32. Why? Why Microsoft? Why do you do this, why?

  /** RAII file handle using Win32 CreateFileW for maximum throughput on Windows.
   *  Uses UTF-8 → wchar_t path conversion with stack buffer for short paths. */
  class FileHandle : NonCopyable {
    HANDLE h_;

    // Stack buffer covers MAX_PATH (260) plus generous extra for long paths.
    // Only heap-allocates for paths > 512 wide chars (extremely rare).
    static constexpr int STACK_WPATH_SIZE = 512;

   public:
    explicit FileHandle(const char * path) noexcept : h_(INVALID_HANDLE_VALUE) {
      int wlen = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
      if (FSH_UNLIKELY(wlen <= 0)) return;

      wchar_t stack_buf[STACK_WPATH_SIZE];
      wchar_t * wpath = stack_buf;
      wchar_t * heap_buf = nullptr;

      if (FSH_UNLIKELY(wlen > STACK_WPATH_SIZE)) {
        heap_buf = static_cast<wchar_t *>(malloc(static_cast<size_t>(wlen) * sizeof(wchar_t)));
        if (!heap_buf) {
          return;
        }
        wpath = heap_buf;
      }

      MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, wlen);

      this->h_ = CreateFileW(
        wpath,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_DELETE,  // allow concurrent reads + deletion
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_SEQUENTIAL_SCAN,  // hint for OS read-ahead (like posix_fadvise)
        nullptr);

      if (heap_buf) {
        free(heap_buf);
      }
    }

    ~FileHandle() noexcept {
      if (this->h_ != INVALID_HANDLE_VALUE) {
        CloseHandle(this->h_);
      }
    }

    /** Returns true if the file was opened successfully. */
    FSH_FORCE_INLINE explicit operator bool() const noexcept { return this->h_ != INVALID_HANDLE_VALUE; }

    /** Read up to len bytes into buf. Returns bytes read (> 0), 0 on EOF, or -1 on error. */
    FSH_FORCE_INLINE int64_t read(void * buf, size_t len) noexcept {
      DWORD to_read = len > 0x7FFFFFFFu ? 0x7FFFFFFFu : static_cast<DWORD>(len);
      DWORD bytes_read = 0;
      if (FSH_UNLIKELY(!ReadFile(this->h_, buf, to_read, &bytes_read, nullptr))) {
        return -1;
      }
      return static_cast<int64_t>(bytes_read);
    }
  };

#endif

}  // namespace fast_fs_hash

#endif
