#ifndef _FAST_FS_HASH_FFSH_FILE_WIN32_H
#define _FAST_FS_HASH_FFSH_FILE_WIN32_H

#ifdef _WIN32

#  include "../includes.h"
#  include "../file-hash-cache/file-hash-cache-format.h"

#  include <fcntl.h>
#  include <io.h>

namespace fast_fs_hash {

  /** Opaque lock token — raw HANDLE cast to uint64_t. 0 = invalid. */
  using CacheLockHandle = uint64_t;
  static constexpr CacheLockHandle CACHE_LOCK_INVALID = 0;

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
   *   open_read(), open_write(), open_locked().
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
     * Open-or-create a cache file and acquire an exclusive LockFileEx lock.
     *
     * @param path      Cache file path (UTF-8).
     * @param timeoutMs -1 = block forever, 0 = non-blocking try, >0 = timeout in ms.
     * @param outError  Set to an error string on failure.
     * @return FfshFile with the locked handle, or invalid on failure.
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

      HANDLE hFile = open_rw_handle_mkdir(path);
      if (hFile == INVALID_HANDLE_VALUE) [[unlikely]] {
        outError = "CacheLock: failed to open cache file for locking";
        return f;
      }

      DWORD flags = LOCKFILE_EXCLUSIVE_LOCK;

      if (timeoutMs == 0) {
        OVERLAPPED ov{};
        if (!LockFileEx(hFile, flags | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) [[unlikely]] {
          CloseHandle(hFile);
          outError = "CacheLock: lock not available";
          return f;
        }
      } else if (timeoutMs < 0) {
        HANDLE hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!hEvent) [[unlikely]] {
          CloseHandle(hFile);
          outError = "CacheLock: CreateEvent failed";
          return f;
        }
        OVERLAPPED ov{};
        ov.hEvent = hEvent;
        if (!LockFileEx(hFile, flags, 0, 1, 0, &ov)) {
          if (GetLastError() == ERROR_IO_PENDING) {
            WaitForSingleObject(hEvent, INFINITE);
            DWORD transferred = 0;
            if (!GetOverlappedResult(hFile, &ov, &transferred, FALSE)) [[unlikely]] {
              CloseHandle(hEvent);
              CloseHandle(hFile);
              outError = "CacheLock: LockFileEx failed";
              return f;
            }
          } else {
            CloseHandle(hEvent);
            CloseHandle(hFile);
            outError = "CacheLock: LockFileEx failed";
            return f;
          }
        }
        CloseHandle(hEvent);
      } else {
        const ULONGLONG start = GetTickCount64();
        int sleepMs = 1;
        for (;;) {
          OVERLAPPED ov{};
          if (LockFileEx(hFile, flags | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) [[likely]] {
            break;
          }
          if (GetTickCount64() - start >= static_cast<ULONGLONG>(timeoutMs)) [[unlikely]] {
            CloseHandle(hFile);
            outError = "CacheLock: timeout waiting for cache lock";
            return f;
          }
          Sleep(sleepMs);
          if (sleepMs < 50) {
            sleepMs += sleepMs / 2;
          }
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

    /** Convert this FfshFile to a CacheLockHandle. Releases ownership. */
    FSH_FORCE_INLINE CacheLockHandle to_lock_handle() noexcept {
      if (this->fd < 0) [[unlikely]] {
        return CACHE_LOCK_INVALID;
      }
      HANDLE h = reinterpret_cast<HANDLE>(_get_osfhandle(this->fd));
      if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
        return CACHE_LOCK_INVALID;
      }
      // Detach the CRT fd without closing the underlying HANDLE
      // We need to keep the HANDLE alive, so don't close the fd normally
      const CacheLockHandle lh = static_cast<CacheLockHandle>(reinterpret_cast<uintptr_t>(h));
      // Mark fd as released — but on Windows we can't just set fd=-1 because
      // _get_osfhandle already gave us the HANDLE. We close the CRT fd wrapper
      // but the HANDLE stays owned by the lock handle.
      // Actually, on Windows we should NOT close the CRT fd because that would
      // close the underlying HANDLE. Instead, just transfer the fd value out.
      this->fd = -1;
      return lh;
    }

    /** Create an FfshFile from a CacheLockHandle. Takes ownership. */
    static FSH_FORCE_INLINE FfshFile from_lock_handle(CacheLockHandle handle) noexcept {
      FfshFile f;
      if (handle != CACHE_LOCK_INVALID) [[likely]] {
        HANDLE h = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle));
        f.fd = _open_osfhandle(reinterpret_cast<intptr_t>(h), _O_RDWR | _O_BINARY);
        // If _open_osfhandle fails, the HANDLE leaks — shouldn't happen in practice
      }
      return f;
    }

    /** Release a CacheLockHandle (unlock + close). */
    static inline void release_lock_handle(CacheLockHandle handle) noexcept {
      if (handle == CACHE_LOCK_INVALID) [[unlikely]] {
        return;
      }
      HANDLE hFile = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle));
      OVERLAPPED ov{};
      UnlockFileEx(hFile, 0, 1, 0, &ov);
      CloseHandle(hFile);
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
      const bool gotLock =
        LockFileEx(hFile, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov) != FALSE;
      if (gotLock) {
        OVERLAPPED ov2{};
        UnlockFileEx(hFile, 0, 1, 0, &ov2);
      }
      CloseHandle(hFile);
      return !gotLock;
    }

    // ── Read/Write ─────────────────────────────────────────────────────

    /** No-op on Windows — FILE_FLAG_SEQUENTIAL_SCAN is set at open time. */
    FSH_FORCE_INLINE void hint_sequential() noexcept {}

    /**
     * Read up to len bytes into buf. Returns bytes read (> 0), 0 on EOF, or -1 on error.
     */
    FSH_FORCE_INLINE int64_t read(void * buf, size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return -1;
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
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return -1;
      LARGE_INTEGER sz;
      if (!GetFileSizeEx(h, &sz)) return -1;
      return sz.QuadPart;
    }

    /** Read len bytes from file_offset into dest (positional read). Returns bytes read or -1. */
    inline int64_t pread_at(uint8_t * dest, size_t file_offset, size_t len) const noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return -1;
      size_t total = 0;
      while (total < len) {
        const uint64_t off = file_offset + total;
        OVERLAPPED ov{};
        ov.Offset = static_cast<DWORD>(off);
        ov.OffsetHigh = static_cast<DWORD>(off >> 32);
        const DWORD chunk = static_cast<DWORD>((len - total > 0x7FFFFFFFu) ? 0x7FFFFFFFu : len - total);
        DWORD bytes_read = 0;
        if (!ReadFile(h, dest + total, chunk, &bytes_read, &ov)) [[unlikely]]
          return total > 0 ? static_cast<int64_t>(total) : -1;
        if (bytes_read == 0) break;
        total += bytes_read;
      }
      return static_cast<int64_t>(total);
    }

    /** Write all bytes. Returns true on success. */
    inline bool write_all(const uint8_t * data, size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return false;
      size_t total = 0;
      while (total < len) {
        const DWORD chunk = static_cast<DWORD>((len - total > 0x7FFFFFFFu) ? 0x7FFFFFFFu : len - total);
        DWORD written = 0;
        if (!WriteFile(h, data + total, chunk, &written, nullptr)) [[unlikely]]
          return false;
        if (written == 0) [[unlikely]]
          return false;
        total += written;
      }
      return true;
    }

    /** Truncate the file to the given length. Returns true on success. */
    inline bool truncate(size_t len) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return false;
      LARGE_INTEGER li;
      li.QuadPart = static_cast<LONGLONG>(len);
      if (!SetFilePointerEx(h, li, nullptr, FILE_BEGIN)) [[unlikely]]
        return false;
      return SetEndOfFile(h) != FALSE;
    }

    /** Seek to a position from the beginning of the file. Returns true on success. */
    inline bool seek(size_t offset) noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return false;
      LARGE_INTEGER li;
      li.QuadPart = static_cast<LONGLONG>(offset);
      return SetFilePointerEx(h, li, nullptr, FILE_BEGIN) != FALSE;
    }

    /** Flush file data to disk. Returns true on success. */
    inline bool fsync_data() noexcept {
      HANDLE h = this->get_handle();
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return false;
      return FlushFileBuffers(h) != FALSE;
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

    /** pread on an unowned fd (no close on destruct). */
    static inline int64_t pread_fd(int raw_fd, uint8_t * dest, size_t file_offset, size_t len) noexcept {
      if (raw_fd < 0) [[unlikely]]
        return -1;
      HANDLE h = reinterpret_cast<HANDLE>(_get_osfhandle(raw_fd));
      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return -1;
      size_t total = 0;
      while (total < len) {
        const uint64_t off = file_offset + total;
        OVERLAPPED ov{};
        ov.Offset = static_cast<DWORD>(off);
        ov.OffsetHigh = static_cast<DWORD>(off >> 32);
        const DWORD chunk = static_cast<DWORD>((len - total > 0x7FFFFFFFu) ? 0x7FFFFFFFu : len - total);
        DWORD bytes_read = 0;
        if (!ReadFile(h, dest + total, chunk, &bytes_read, &ov)) [[unlikely]]
          return total > 0 ? static_cast<int64_t>(total) : -1;
        if (bytes_read == 0) break;
        total += bytes_read;
      }
      return static_cast<int64_t>(total);
    }

    /** Close a raw fd. */
    static inline void close_fd(int f) noexcept { ::_close(f); }

    // ── Stat helpers ──────────────────────────────────────────────────────

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
      if (this->fd < 0) [[unlikely]]
        return INVALID_HANDLE_VALUE;
      return reinterpret_cast<HANDLE>(_get_osfhandle(this->fd));
    }

    static inline int utf8_to_wide(const char * utf8, wchar_t * buf, int cap, wchar_t ** heap_out) noexcept {
      *heap_out = nullptr;
      int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, buf, cap);
      if (wlen > 0) return wlen;
      wlen = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
      if (wlen <= 0) return 0;
      auto * h = static_cast<wchar_t *>(malloc(static_cast<size_t>(wlen) * sizeof(wchar_t)));
      if (!h) return 0;
      MultiByteToWideChar(CP_UTF8, 0, utf8, -1, h, wlen);
      *heap_out = h;
      return wlen;
    }

    static inline int open_rd(const char * path) noexcept {
      wchar_t wbuf[512];
      wchar_t * heap = nullptr;
      const int wlen = utf8_to_wide(path, wbuf, 512, &heap);
      if (wlen <= 0) return -1;
      const int f = open_rd_w(heap ? heap : wbuf);
      free(heap);
      return f;
    }

    static inline int open_rd_w(const wchar_t * wpath) noexcept {
      if (!wpath) [[unlikely]]
        return -1;
      HANDLE h = CreateFileW(
        wpath,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr);
      if (h == INVALID_HANDLE_VALUE) return -1;
      const int f = _open_osfhandle(reinterpret_cast<intptr_t>(h), _O_RDONLY | _O_BINARY);
      if (f < 0) {
        CloseHandle(h);
        return -1;
      }
      return f;
    }

    static inline int open_wr(const char * path) noexcept {
      wchar_t wbuf[512];
      wchar_t * heap = nullptr;
      const int wlen = utf8_to_wide(path, wbuf, 512, &heap);
      if (wlen <= 0) return -1;
      HANDLE h = CreateFileW(
        heap ? heap : wbuf,
        GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
      free(heap);
      if (h == INVALID_HANDLE_VALUE) return -1;
      const int f = _open_osfhandle(reinterpret_cast<intptr_t>(h), _O_WRONLY | _O_BINARY);
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

    static inline int mkdir_p(const char * path, size_t len) noexcept {
      char dir_buf[FSH_MAX_PATH];
      if (len >= sizeof(dir_buf)) return -1;
      memcpy(dir_buf, path, len);
      dir_buf[len] = '\0';
      wchar_t wbuf[512];
      wchar_t * heap = nullptr;
      const int wlen = utf8_to_wide(dir_buf, wbuf, 512, &heap);
      if (wlen <= 0) return -1;
      wchar_t * wp = heap ? heap : wbuf;
      for (int i = 1; i < wlen - 1; ++i) {
        if (wp[i] == L'\\' || wp[i] == L'/') {
          const wchar_t saved = wp[i];
          wp[i] = L'\0';
          CreateDirectoryW(wp, nullptr);
          wp[i] = saved;
        }
      }
      const BOOL ok = CreateDirectoryW(wp, nullptr);
      free(heap);
      return (ok || GetLastError() == ERROR_ALREADY_EXISTS) ? 0 : -1;
    }

    static inline int open_wr_mkdir(const char * path) noexcept {
      int f = open_wr(path);
      if (f >= 0 || GetLastError() != ERROR_PATH_NOT_FOUND) [[likely]]
        return f;
      const size_t len = strlen(path);
      size_t sep = len;
      while (sep > 0 && path[sep - 1] != '/' && path[sep - 1] != '\\')
        --sep;
      if (sep > 1 && mkdir_p(path, sep - 1) == 0) {
        f = open_wr(path);
      }
      return f;
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

      if (h == INVALID_HANDLE_VALUE) [[unlikely]]
        return false;

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

  struct PathResolver : NonCopyable {
    char path_buf[FSH_MAX_PATH];
    wchar_t wpath_scratch[FSH_MAX_PATH];
    size_t prefix_len;

    FSH_FORCE_INLINE void init(const DirFd & /*dir_fd*/, const char * root_path, size_t root_path_len) noexcept {
      size_t len = root_path_len;
      if (len > 0 && (root_path[len - 1] == '/' || root_path[len - 1] == '\\')) [[likely]] {
        --len;
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

#endif  // _WIN32

#endif
