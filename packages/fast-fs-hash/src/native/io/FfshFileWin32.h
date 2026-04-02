#ifndef _FAST_FS_HASH_FFSH_FILE_WIN32_H
#define _FAST_FS_HASH_FFSH_FILE_WIN32_H

#ifdef _WIN32

#  include "../includes.h"
#  include "../file-hash-cache/file-hash-cache-format.h"

#  include <fcntl.h>
#  include <io.h>

namespace fast_fs_hash {

  /** Opaque file handle token — the CRT fd itself. -1 = invalid. */
  using FfshFileHandle = int32_t;
  static constexpr FfshFileHandle FFSH_FILE_HANDLE_INVALID = -1;

  /**
   * WPath — Windows-only RAII UTF-8 → UTF-16 path converter.
   *
   * Converts once, then the resulting wchar_t pointer can be passed to
   * both FfshFile and stat functions without repeating the conversion.
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
      if (wlen <= 0) [[unlikely]] {
        return;
      }
      if (scratch && scratch_cap >= wlen) {
        MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, scratch, wlen);
        this->data = scratch;
      } else {
        this->heap_ = static_cast<wchar_t *>(malloc(static_cast<size_t>(wlen) * sizeof(wchar_t)));
        if (!this->heap_) [[unlikely]] {
          return;
        }
        MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, this->heap_, wlen);
        this->data = this->heap_;
      }
    }

    ~WPath() noexcept { free(this->heap_); }

    explicit operator bool() const noexcept { return this->data != nullptr; }

   private:
    wchar_t * heap_ = nullptr;
  };

  /**
   * RAII file handle — Windows implementation.
   *
   * Uses Win32 handles internally, wrapped in CRT fds for uniform int fd API.
   *
   * Read-only constructors (hashing hot path):
   *   CreateFileW + FILE_FLAG_SEQUENTIAL_SCAN, wrapped to CRT fd.
   *   Accepts pre-converted UTF-16 paths (via WPath) or raw UTF-8.
   *
   * Read/write factories (cache files):
   *   open_locked().
   *
   * Locking:
   *   open_locked() opens/creates the file and acquires an exclusive
   *   LockFileEx byte-range lock. The lock is released when close() is called
   *   or the handle is closed. Supports blocking, non-blocking, and timeout.
   *
   * On destruction: closes fd.
   */
  class FfshFile : NonCopyable {
   public:
    int fd = -1;

    /** Open by absolute path (UTF-8) for sequential reading. */
    explicit FfshFile(const char * path) noexcept { this->fd = open_rd(path); }

    /** Open from a pre-converted UTF-16 path (zero-allocation fast path). */
    explicit FfshFile(const wchar_t * wpath) noexcept { this->fd = open_rd_w(wpath); }

    /** Open relative to a directory fd — Windows stub.
     *  DirFd::fd is always -1 on Windows so this is never called at runtime,
     *  but must exist so callers compile without #ifdef. */
    FfshFile(int, const char *) noexcept {}

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

    /** Close the fd (releases any LockFileEx lock). Safe to call multiple times. */
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
     * Lock cancellation token — cross-platform interface.
     * On Win32, fire() sets a flag checked by the polling loop (CancelIoEx handles
     * the actual interruption). On POSIX, fire() closes the fd to interrupt fcntl.
     */
    struct LockCancelList;

    struct LockCancel : NonCopyable {
      std::atomic<bool> fired_{false};
      const volatile uint8_t * cancelByte_ = nullptr;
      LockCancel * prev_ = nullptr;
      LockCancel * next_ = nullptr;
      LockCancelList * list_ = nullptr;

      void set(int) noexcept {}
      void clear() noexcept {}
      bool is_fired() const noexcept {
        return this->fired_.load(std::memory_order_acquire) || (this->cancelByte_ && *this->cancelByte_ != 0);
      }

      void fire() noexcept { this->fired_.store(true, std::memory_order_release); }
    };

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
     * Open-or-create a cache file and acquire an exclusive LockFileEx lock.
     *
     * @param path      Cache file path (UTF-8).
     * @param timeoutMs -1 = block forever, 0 = non-blocking try, >0 = timeout in ms.
     * @param outError  Set to an error string on failure.
     * @param cancel    Optional LockCancel — fire() signals cancellation.
     * @return FfshFile with the locked handle, or invalid on failure.
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

      HANDLE hFile = open_rw_handle_mkdir(path);
      if (hFile == INVALID_HANDLE_VALUE) [[unlikely]] {
        outError = "CacheLock: failed to open cache file for locking";
        return f;
      }

      DWORD flags = LOCKFILE_EXCLUSIVE_LOCK;

      if (timeoutMs == 0) {
        // Non-blocking try
        OVERLAPPED ov{};
        if (!LockFileEx(hFile, flags | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) [[unlikely]] {
          CloseHandle(hFile);
          outError = "CacheLock: lock not available";
          return f;
        }
      } else {
        // Overlapped LockFileEx + WaitForSingleObject — kernel-level blocking
        HANDLE hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!hEvent) [[unlikely]] {
          CloseHandle(hFile);
          outError = "CacheLock: CreateEvent failed";
          return f;
        }
        OVERLAPPED ov{};
        ov.hEvent = hEvent;
        bool locked = false;
        if (LockFileEx(hFile, flags, 0, 1, 0, &ov)) {
          locked = true;
        } else if (GetLastError() == ERROR_IO_PENDING) {
          if (timeoutMs > 0 && !cancel) {
            // Finite timeout, no cancel — single wait
            const DWORD rc = WaitForSingleObject(hEvent, static_cast<DWORD>(timeoutMs));
            if (rc == WAIT_OBJECT_0) {
              DWORD transferred = 0;
              locked = GetOverlappedResult(hFile, &ov, &transferred, FALSE) != FALSE;
            } else {
              CancelIoEx(hFile, &ov);
            }
          } else {
            // Infinite wait or cancellable — poll with short waits so we can check cancel
            const ULONGLONG start = (timeoutMs > 0) ? GetTickCount64() : 0;
            for (;;) {
              const DWORD rc = WaitForSingleObject(hEvent, 100);
              if (rc == WAIT_OBJECT_0) {
                DWORD transferred = 0;
                locked = GetOverlappedResult(hFile, &ov, &transferred, FALSE) != FALSE;
                break;
              }
              if (cancel && cancel->is_fired()) [[unlikely]] {
                CancelIoEx(hFile, &ov);
                break;
              }
              if (timeoutMs > 0) {
                if (GetTickCount64() - start >= static_cast<ULONGLONG>(timeoutMs)) [[unlikely]] {
                  CancelIoEx(hFile, &ov);
                  break;
                }
              }
            }
          }
        }
        CloseHandle(hEvent);
        if (!locked) [[unlikely]] {
          CloseHandle(hFile);
          if (cancel && cancel->is_fired()) {
            outError = "CacheLock: lock acquisition cancelled";
          } else {
            outError = (timeoutMs > 0) ? "CacheLock: timed out waiting for exclusive lock"
                                       : "CacheLock: failed to acquire exclusive lock";
          }
          return f;
        }
      }

      // Wrap the locked HANDLE as a CRT fd for uniform API
      const int crt_fd = _open_osfhandle(reinterpret_cast<intptr_t>(hFile), _O_RDWR | _O_BINARY);
      if (crt_fd < 0) [[unlikely]] {
        OVERLAPPED ov{};
        UnlockFileEx(hFile, 0, 1, 0, &ov);
        CloseHandle(hFile);
        outError = "CacheLock: _open_osfhandle failed";
        return f;
      }

      f.fd = crt_fd;
      return f;
    }

    /** Convert this FfshFile to a FfshFileHandle (the raw CRT fd). Releases ownership. */
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
      const int wlen = MultiByteToWideChar(CP_UTF8, 0, cachePath, -1, nullptr, 0);
      if (wlen <= 0 || wlen > static_cast<int>(FSH_MAX_PATH)) [[unlikely]] {
        return false;
      }
      wchar_t wpath[FSH_MAX_PATH];
      MultiByteToWideChar(CP_UTF8, 0, cachePath, -1, wpath, wlen);

      HANDLE hFile = CreateFileW(
        wpath,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
      if (hFile == INVALID_HANDLE_VALUE) [[unlikely]] {
        return false;
      }
      OVERLAPPED ov{};
      const bool gotLock = LockFileEx(hFile, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov) != FALSE;
      if (gotLock) {
        OVERLAPPED ov2{};
        UnlockFileEx(hFile, 0, 1, 0, &ov2);
      }
      CloseHandle(hFile);
      return !gotLock;
    }

    /**
     * Wait until the file is no longer exclusively locked, or timeout/cancellation.
     *
     * Uses overlapped LockFileEx (shared lock) + WaitForSingleObject.
     * Cancellable via LockCancel::fire() — checked between short waits.
     *
     * @param cachePath  File path (UTF-8).
     * @param timeoutMs  -1 = block forever, 0 = non-blocking, >0 = timeout in ms.
     * @param cancel     Optional LockCancel — fire() signals cancellation.
     * @return true if the file is (now) unlocked, false on timeout/cancel/error.
     */
    static FSH_NO_INLINE bool wait_unlocked(
      const char * cachePath, int timeoutMs, LockCancel * cancel = nullptr) noexcept {
      if (!cachePath || cachePath[0] == '\0') [[unlikely]] {
        return true;
      }
      const int wlen = MultiByteToWideChar(CP_UTF8, 0, cachePath, -1, nullptr, 0);
      if (wlen <= 0 || wlen > static_cast<int>(FSH_MAX_PATH)) [[unlikely]] {
        return true;
      }
      wchar_t wpath[FSH_MAX_PATH];
      MultiByteToWideChar(CP_UTF8, 0, cachePath, -1, wpath, wlen);

      HANDLE hFile = CreateFileW(
        wpath,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
      if (hFile == INVALID_HANDLE_VALUE) [[unlikely]] {
        return true;  // Can't open → not locked (or doesn't exist)
      }

      bool acquired = false;

      if (timeoutMs == 0) {
        OVERLAPPED ov{};
        acquired = LockFileEx(hFile, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov) != FALSE;
      } else {
        // Use overlapped I/O so we can wait with a timeout and check cancel
        HANDLE hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (hEvent) {
          OVERLAPPED ov{};
          ov.hEvent = hEvent;
          // Shared lock (no LOCKFILE_EXCLUSIVE_LOCK) — blocks until exclusive holder releases
          if (LockFileEx(hFile, 0, 0, 1, 0, &ov)) {
            acquired = true;
          } else if (GetLastError() == ERROR_IO_PENDING) {
            // Wait in a loop with short timeouts so we can check cancel
            const DWORD waitMs = (timeoutMs < 0) ? 100 : (timeoutMs < 100 ? static_cast<DWORD>(timeoutMs) : 100);
            const ULONGLONG start = (timeoutMs > 0) ? GetTickCount64() : 0;
            for (;;) {
              const DWORD rc = WaitForSingleObject(hEvent, waitMs);
              if (rc == WAIT_OBJECT_0) {
                DWORD transferred = 0;
                acquired = GetOverlappedResult(hFile, &ov, &transferred, FALSE) != FALSE;
                break;
              }
              if (cancel && cancel->is_fired()) [[unlikely]] {
                CancelIoEx(hFile, &ov);
                break;
              }
              if (timeoutMs > 0) {
                if (GetTickCount64() - start >= static_cast<ULONGLONG>(timeoutMs)) [[unlikely]] {
                  CancelIoEx(hFile, &ov);
                  break;
                }
              }
            }
          }
          CloseHandle(hEvent);
        }
      }

      if (acquired) {
        OVERLAPPED ov{};
        UnlockFileEx(hFile, 0, 1, 0, &ov);
      }
      CloseHandle(hFile);
      return acquired;
    }

    /**
     * Read up to len bytes into buf. Returns bytes read (> 0), 0 on EOF, or -1 on error.
     */
    FSH_FORCE_INLINE int64_t read(void * buf, size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return -1;
      }
      DWORD to_read = len > 0x7FFFFFFFu ? 0x7FFFFFFFu : static_cast<DWORD>(len);
      DWORD bytes_read = 0;
      if (!ReadFile(h, buf, to_read, &bytes_read, nullptr)) [[unlikely]] {
        return -1;
      }
      return static_cast<int64_t>(bytes_read);
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
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return -1;
      }
      LARGE_INTEGER sz;
      if (!GetFileSizeEx(h, &sz)) {
        return -1;
      }
      return sz.QuadPart;
    }

    /** Write all bytes. Returns true on success. */
    inline bool write_all(const uint8_t * data, size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return false;
      }
      size_t total = 0;
      while (total < len) {
        const DWORD chunk = static_cast<DWORD>((len - total > 0x7FFFFFFFu) ? 0x7FFFFFFFu : len - total);
        DWORD written = 0;
        if (!WriteFile(h, data + total, chunk, &written, nullptr)) [[unlikely]] {
          return false;
        }
        if (written == 0) [[unlikely]] {
          return false;
        }
        total += written;
      }
      return true;
    }

    /** Truncate the file to the given length. Returns true on success. */
    inline bool truncate(size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return false;
      }
      LARGE_INTEGER li;
      li.QuadPart = static_cast<LONGLONG>(len);
      if (!SetFilePointerEx(h, li, nullptr, FILE_BEGIN)) [[unlikely]] {
        return false;
      }
      return SetEndOfFile(h) != FALSE;
    }

    /** Pre-allocate space. Best-effort, failure is ignored. */
    inline void preallocate(size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return;
      }
      FILE_ALLOCATION_INFO alloc;
      alloc.AllocationSize.QuadPart = static_cast<LONGLONG>(len);
      ::SetFileInformationByHandle(h, FileAllocationInfo, &alloc, sizeof(alloc));
    }

    /** Seek to a position from the beginning of the file. Returns true on success. */
    inline bool seek(size_t offset) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return false;
      }
      LARGE_INTEGER li;
      li.QuadPart = static_cast<LONGLONG>(offset);
      return SetFilePointerEx(h, li, nullptr, FILE_BEGIN) != FALSE;
    }

    /** Close a raw fd. */
    static inline void close_fd(int f) noexcept { ::_close(f); }

    /** stat using a pre-converted UTF-16 path, writing raw fields into CacheEntry. */
    static FSH_FORCE_INLINE bool stat_into(const wchar_t * wpath, CacheEntry & entry) noexcept {
      if (!wpath) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      BY_HANDLE_FILE_INFORMATION info;
      FILE_BASIC_INFO basicInfo;
      if (!stat_query_(wpath, info, basicInfo)) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      return stat_write_(info, basicInfo, entry);
    }

    /** stat from UTF-8 path, writing raw fields into CacheEntry. */
    static FSH_FORCE_INLINE bool stat_into(const char * path, CacheEntry & entry) noexcept {
      wchar_t wbuf[512];
      wchar_t * heap = nullptr;
      const int wlen = utf8_to_wide(path, wbuf, 512, &heap);
      if (wlen <= 0) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      const bool ok = stat_into(heap ? heap : wbuf, entry);
      free(heap);
      return ok;
    }

    /** fstat: stat an already-open file descriptor, writing raw fields into CacheEntry. */
    static FSH_FORCE_INLINE bool fstat_into(int fd, CacheEntry & entry) noexcept {
      if (fd < 0) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      HANDLE h = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      BY_HANDLE_FILE_INFORMATION info;
      FILE_BASIC_INFO basicInfo;
      if (
        !GetFileInformationByHandle(h, &info) ||
        !GetFileInformationByHandleEx(h, FileBasicInfo, &basicInfo, sizeof(basicInfo))) [[unlikely]] {
        entry.clearStat();
        return false;
      }
      return stat_write_(info, basicInfo, entry);
    }

   private:
    /** Get the Win32 HANDLE from the CRT fd via _get_osfhandle. */
    FSH_FORCE_INLINE HANDLE get_handle() const noexcept {
      if (this->fd < 0) [[unlikely]] {
        return INVALID_HANDLE_VALUE;
      }
      return reinterpret_cast<HANDLE>(_get_osfhandle(this->fd));
    }

    static inline int utf8_to_wide(const char * utf8, wchar_t * buf, int cap, wchar_t ** heap_out) noexcept {
      *heap_out = nullptr;
      int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, buf, cap);
      if (wlen > 0) {
        return wlen;
      }
      wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
      if (wlen <= 0) {
        return 0;
      }
      auto * h = static_cast<wchar_t *>(malloc(static_cast<size_t>(wlen) * sizeof(wchar_t)));
      if (!h) {
        return 0;
      }
      MultiByteToWideChar(CP_UTF8, 0, utf8, -1, h, wlen);
      *heap_out = h;
      return wlen;
    }

    static inline int open_rd(const char * path) noexcept {
      wchar_t wbuf[512];
      wchar_t * heap = nullptr;
      const int wlen = utf8_to_wide(path, wbuf, 512, &heap);
      if (wlen <= 0) {
        return -1;
      }
      const int f = open_rd_w(heap ? heap : wbuf);
      free(heap);
      return f;
    }

    static inline int open_rd_w(const wchar_t * wpath) noexcept {
      if (!wpath) [[unlikely]] {
        return -1;
      }
      HANDLE h = CreateFileW(
        wpath,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr);
      if (h == INVALID_HANDLE_VALUE) {
        return -1;
      }
      const int f = _open_osfhandle(reinterpret_cast<intptr_t>(h), _O_RDONLY | _O_BINARY);
      if (f < 0) {
        CloseHandle(h);
        return -1;
      }
      return f;
    }

    /** Open/create a file with GENERIC_READ|GENERIC_WRITE for locking — returns raw HANDLE. */
    static FSH_NO_INLINE HANDLE open_rw_handle_(const wchar_t * wpath) noexcept {
      return CreateFileW(
        wpath,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    }

    static FSH_NO_INLINE bool mkdirW_(const wchar_t * wpath, int wlen) noexcept {
      wchar_t buf[FSH_MAX_PATH];
      if (wlen >= static_cast<int>(FSH_MAX_PATH)) [[unlikely]] {
        return false;
      }
      wmemcpy(buf, wpath, static_cast<size_t>(wlen));
      buf[wlen] = L'\0';
      for (int i = 1; i < wlen; ++i) {
        if (buf[i] == L'\\' || buf[i] == L'/') {
          buf[i] = L'\0';
          CreateDirectoryW(buf, nullptr);
          buf[i] = L'\\';
        }
      }
      return CreateDirectoryW(buf, nullptr) || GetLastError() == ERROR_ALREADY_EXISTS;
    }

    static inline HANDLE open_rw_handle_mkdir(const char * path) noexcept {
      const int wlen = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
      if (wlen <= 0 || wlen > static_cast<int>(FSH_MAX_PATH)) [[unlikely]] {
        return INVALID_HANDLE_VALUE;
      }
      wchar_t wpath[FSH_MAX_PATH];
      MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, wlen);

      HANDLE h = open_rw_handle_(wpath);
      if (h != INVALID_HANDLE_VALUE) [[likely]] {
        return h;
      }
      if (GetLastError() != ERROR_PATH_NOT_FOUND) [[unlikely]] {
        return INVALID_HANDLE_VALUE;
      }
      int sep = wlen - 1;
      while (sep > 0 && wpath[sep] != L'\\' && wpath[sep] != L'/') {
        --sep;
      }
      if (sep > 0) {
        mkdirW_(wpath, sep);
      }
      return open_rw_handle_(wpath);
    }

    static FSH_FORCE_INLINE bool stat_query_(
      const wchar_t * wpath, BY_HANDLE_FILE_INFORMATION & info, FILE_BASIC_INFO & basicInfo) noexcept {
      HANDLE h = CreateFileW(
        wpath,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);

      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return false;
      }

      if (!GetFileInformationByHandle(h, &info)) [[unlikely]] {
        CloseHandle(h);
        return false;
      }

      if (!GetFileInformationByHandleEx(h, FileBasicInfo, &basicInfo, sizeof(basicInfo))) [[unlikely]] {
        CloseHandle(h);
        return false;
      }
      CloseHandle(h);
      return true;
    }

    static FSH_FORCE_INLINE bool stat_write_(
      const BY_HANDLE_FILE_INFORMATION & info, const FILE_BASIC_INFO & basicInfo, CacheEntry & entry) noexcept {
      const uint64_t sz64 = (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;

      static constexpr uint64_t EPOCH_DIFF = 116444736000000000ULL;
      auto li_to_ns = [](LARGE_INTEGER li) -> uint64_t {
        const uint64_t v = static_cast<uint64_t>(li.QuadPart);
        return v >= EPOCH_DIFF ? (v - EPOCH_DIFF) * 100ULL : 0ULL;
      };

      const uint64_t p_ino = ((static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow) & INO_VALUE_MASK;
      entry.writeStat(p_ino, li_to_ns(basicInfo.LastWriteTime), li_to_ns(basicInfo.ChangeTime), sz64);
      return true;
    }
  };

  /** Windows no-op: dir_fd is not used — all paths are absolute UTF-16. */
  struct DirFd : NonCopyable {
    static constexpr int fd = -1;
    explicit DirFd(const char *, size_t) noexcept {}
  };

#  include "hash-file-helpers.h"

  /**
   * Per-thread path resolver for cache stat/hash workers (Windows).
   *
   * Concatenates a root prefix with relative packed paths into a fixed
   * path_buf: [rootPath\\][relativePath\0], converting '/' to '\\'.
   * A pre-allocated wpath_scratch avoids per-file heap allocation when
   * converting UTF-8 → UTF-16 via WPath.
   *
   * Lifecycle: init() once with root path, then resolve()+stat/hash per file.
   */
  struct PathResolver : NonCopyable {
    char path_buf[FSH_MAX_PATH];
    wchar_t wpath_scratch[FSH_MAX_PATH];
    size_t prefix_len;

    FSH_FORCE_INLINE void init(const DirFd & /*dir_fd*/, const char * root_path, size_t root_path_len) noexcept {
      size_t len = root_path_len;
      if (len > 0 && (root_path[len - 1] == '/' || root_path[len - 1] == '\\')) [[likely]] {
        --len;
      }
      if (len >= FSH_MAX_PATH - 1) [[unlikely]] {
        len = FSH_MAX_PATH - 2;
      }
      memcpy(this->path_buf, root_path, len);
      this->path_buf[len] = '\\';
      this->prefix_len = len + 1;
    }

    FSH_FORCE_INLINE void resolve(const uint8_t * packed_path, size_t path_len) noexcept {
      char * dst = this->path_buf + this->prefix_len;
      const auto * src = reinterpret_cast<const char *>(packed_path);
      for (size_t i = 0; i < path_len; ++i) {
        dst[i] = (src[i] == '/') ? '\\' : src[i];
      }
      dst[path_len] = '\0';
    }

    FSH_FORCE_INLINE bool stat_into(CacheEntry & entry) const noexcept {
      WPath wp(this->path_buf, const_cast<wchar_t *>(this->wpath_scratch), FSH_MAX_PATH);
      return FfshFile::stat_into(wp.data, entry);
    }

    FSH_FORCE_INLINE FfshFile open_file() const noexcept {
      WPath wp(this->path_buf, const_cast<wchar_t *>(this->wpath_scratch), FSH_MAX_PATH);
      return FfshFile(wp.data);
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
      hash_open_file(rf, dest, rbuf, rbs);
      return true;
    }
  };

}  // namespace fast_fs_hash

#endif  // _WIN32

#endif
