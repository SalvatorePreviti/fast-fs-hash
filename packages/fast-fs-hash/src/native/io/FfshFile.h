#ifndef _FAST_FS_HASH_FFSH_FILE_IO_H
#define _FAST_FS_HASH_FFSH_FILE_IO_H

/**
 * Platform dispatcher for FfshFile — includes the correct platform-specific
 * implementation (POSIX or Win32).
 *
 * Both platform headers define the same FfshFile class interface:
 *   - RAII file handle with read/write/atomic-commit
 *   - Static stat_into methods (write raw stat fields into CacheEntry)
 *   - Static helpers: close_fd, pread_fd, atomic_rename
 */

#ifdef _WIN32
#  include "FfshFileWin32.h"
#else
#  include "FfshFilePosix.h"
#endif

#endif
