#ifndef _FAST_FS_HASH_FFSH_FILE_IO_H
#define _FAST_FS_HASH_FFSH_FILE_IO_H

/**
 * Platform dispatcher for FfshFile — includes the correct platform-specific
 * implementation (POSIX or Win32).
 *
 * Both platform headers define:
 *   - FfshFile: RAII file handle with read/write/lock/truncate/seek
 *   - CacheLockHandle: opaque lock token (uint64_t)
 *   - Static helpers: stat_into, is_locked, release_lock_handle
 *   - DirFd, PathResolver: per-thread path resolution context
 */

#ifdef _WIN32
#  include "FfshFileWin32.h"
#else
#  include "FfshFilePosix.h"
#endif

#endif
