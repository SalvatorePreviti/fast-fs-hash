/**
 * Platform-abstracted stat for cache validation.
 *
 * Writes a 32-byte stat record (ino, mtimeNs, ctimeNs, size as u64 LE)
 * matching the exact values produced by Node.js fs.stat({ bigint: true }).
 */

#ifndef _FAST_FS_HASH_FILE_STAT_H
#define _FAST_FS_HASH_FILE_STAT_H

#include "includes.h"

namespace fast_fs_hash {

#ifndef _WIN32

  /**
   * stat() a file and write 32 bytes to dest:
   *   [0..7]   ino     (u64 LE)
   *   [8..15]  mtimeNs (u64 LE)
   *   [16..23] ctimeNs (u64 LE)
   *   [24..31] size    (u64 LE)
   *
   * Returns true on success, false on error (dest zeroed).
   * Values match Node.js fs.stat({ bigint: true }) exactly.
   */
  FSH_FORCE_INLINE bool file_stat_to(const char * path, uint8_t * dest) noexcept {
    struct stat st;
    if (::stat(path, &st) != 0) [[unlikely]] {
      memset(dest, 0, 32);
      return false;
    }

    uint64_t ino = static_cast<uint64_t>(st.st_ino);
    uint64_t sz = static_cast<uint64_t>(st.st_size);

    // Nanosecond timestamps — platform-specific field names.
    // Arithmetic matches Node.js: BigInt(tv_sec) * 1000000000n + BigInt(tv_nsec).
#  if defined(__APPLE__)
    uint64_t mtimeNs =
      static_cast<uint64_t>(st.st_mtimespec.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_mtimespec.tv_nsec);
    uint64_t ctimeNs =
      static_cast<uint64_t>(st.st_ctimespec.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_ctimespec.tv_nsec);
#  else  // Linux, FreeBSD — POSIX st_mtim / st_ctim
    uint64_t mtimeNs = static_cast<uint64_t>(st.st_mtim.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_mtim.tv_nsec);
    uint64_t ctimeNs = static_cast<uint64_t>(st.st_ctim.tv_sec) * 1000000000ULL + static_cast<uint64_t>(st.st_ctim.tv_nsec);
#  endif

    // Write as u64 LE.  All target platforms (x86_64, ARM64) are little-endian,
    // so memcpy from native uint64_t produces the correct LE byte order.
    memcpy(dest, &ino, 8);
    memcpy(dest + 8, &mtimeNs, 8);
    memcpy(dest + 16, &ctimeNs, 8);
    memcpy(dest + 24, &sz, 8);
    return true;
  }

#else  // _WIN32

  FSH_FORCE_INLINE bool file_stat_to(const char * path, uint8_t * dest) noexcept {
    // Convert UTF-8 path to UTF-16.
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
    if (wlen <= 0) [[unlikely]] {
      memset(dest, 0, 32);
      return false;
    }

    static constexpr int STACK_BUF = 512;
    wchar_t stack_buf[STACK_BUF];
    wchar_t * wpath = stack_buf;
    wchar_t * heap_buf = nullptr;

    if (wlen > STACK_BUF) [[unlikely]] {
      heap_buf = static_cast<wchar_t *>(malloc(static_cast<size_t>(wlen) * sizeof(wchar_t)));
      if (!heap_buf) {
        memset(dest, 0, 32);
        return false;
      }
      wpath = heap_buf;
    }
    MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, wlen);

    // Open with minimum permissions — only need attributes, not content.
    HANDLE h = CreateFileW(
      wpath,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
    if (heap_buf) free(heap_buf);

    if (h == INVALID_HANDLE_VALUE) [[unlikely]] {
      memset(dest, 0, 32);
      return false;
    }

    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(h, &info)) [[unlikely]] {
      CloseHandle(h);
      memset(dest, 0, 32);
      return false;
    }
    CloseHandle(h);

    uint64_t ino = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
    uint64_t sz = (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;

    // Convert FILETIME (100-ns intervals since 1601-01-01) to Unix nanoseconds.
    // Matches libuv: mtimeNs = (filetime - EPOCH_DIFF) * 100.
    static constexpr uint64_t EPOCH_DIFF = 116444736000000000ULL;

    auto ft_to_ns = [](FILETIME ft) -> uint64_t {
      uint64_t v = (static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
      return v >= EPOCH_DIFF ? (v - EPOCH_DIFF) * 100ULL : 0ULL;
    };

    // Note: libuv maps ctime to ftCreationTime on Windows.
    uint64_t mtimeNs = ft_to_ns(info.ftLastWriteTime);
    uint64_t ctimeNs = ft_to_ns(info.ftCreationTime);

    memcpy(dest, &ino, 8);
    memcpy(dest + 8, &mtimeNs, 8);
    memcpy(dest + 16, &ctimeNs, 8);
    memcpy(dest + 24, &sz, 8);
    return true;
  }

#endif

}  // namespace fast_fs_hash

#endif
