/**
 * Binary format constants for the file-hash-cache on-disk and in-memory layout.
 *
 * ### On-disk layout
 *
 * ```
 * [header: 80 bytes, uncompressed][LZ4 compressed body]
 * ```
 *
 * The header is 80 bytes (pure on-disk format, no in-memory-only fields).
 * The header is always readable without decompression. The LZ4 body contains:
 * ```
 * [entries: fileCount × 48 bytes]
 * [udDir: udItemCount × 4 bytes]
 * [pathEnds: fileCount × 4 bytes]
 * [paths: pathsLen bytes]
 * [user data payloads]
 * ```
 *
 * ### CacheStateBuf
 *
 * Shared JS ↔ C++ per-instance communication buffer. Fixed 96-byte header
 * followed by the null-terminated UTF-8 cache path.
 *
 * @module
 * @internal
 */

/** Binary format magic: bytes 'F','S','H',0x00. */
export const MAGIC = 0x00485346;

/** Fixed on-disk header size in bytes. */
export const HEADER_SIZE = 80;

/** Header byte 4: User cache version (u32). */
export const H_VERSION = 4;

/** Header byte 8: Number of file entries (u32). */
export const H_FILE_COUNT = 8;

/** Header byte 12: Number of user data items (u32). */
export const H_UD_ITEM_COUNT = 12;

/** Header byte 16: Fingerprint (16 bytes xxHash3-128, or all-zero). */
export const H_FINGERPRINT_BYTE = 16;

/** Header byte 32: userValue0 (f64 LE). */
export const H_USER_VALUE0_BYTE = 32;

/** Header byte 40: userValue1 (f64 LE). */
export const H_USER_VALUE1_BYTE = 40;

/** Header byte 48: userValue2 (f64 LE). */
export const H_USER_VALUE2_BYTE = 48;

/** Header byte 56: userValue3 (f64 LE). */
export const H_USER_VALUE3_BYTE = 56;

/** Header byte 64: Byte length of the packed paths section (u32). */
export const H_PATHS_LEN = 64;

/** Header byte 68: Total byte length of user data payloads (u32). */
export const H_UD_PAYLOADS_LEN = 68;

/** Fixed byte size of each file entry (48 bytes, 16-byte aligned). */
export const ENTRY_STRIDE = 48;

/** Maximum total user data payload size (128 MiB, matches C++ CACHE_MAX_UD_PAYLOADS). */
export const CACHE_MAX_USER_DATA_SIZE = 128 * 1024 * 1024;

// ── CacheStateBuf offsets ───────────────────────────────────────────

/** Fixed header size of the state buffer (excluding variable-length cachePath). */
export const STATE_HEADER_SIZE = 96;

/** State byte 0: fingerprint (16 bytes, JS→C++). */
export const S_FINGERPRINT = 0;

/** State byte 16: version (u32, JS→C++). */
export const S_VERSION = 16;

/** State byte 20: lockTimeoutMs (i32, JS→C++). */
export const S_LOCK_TIMEOUT = 20;

/** State byte 24: status (u32, C++→JS). */
export const S_STATUS = 24;

/** State byte 28: fileHandle (i32, C++↔JS, -1 = invalid). */
export const S_FILE_HANDLE = 28;

/** State byte 32: cacheFileStat0 (f64, C++→JS). */
export const S_CACHE_STAT0 = 32;

/** State byte 40: cacheFileStat1 (f64, C++→JS). */
export const S_CACHE_STAT1 = 40;

/** State byte 48: userValue0 (f64, JS→C++). */
export const S_USER_VALUE0 = 48;

/** State byte 56: userValue1 (f64, JS→C++). */
export const S_USER_VALUE1 = 56;

/** State byte 64: userValue2 (f64, JS→C++). */
export const S_USER_VALUE2 = 64;

/** State byte 72: userValue3 (f64, JS→C++). */
export const S_USER_VALUE3 = 72;

/** State byte 80: cancelFlag (u32, JS↔C++). */
export const S_CANCEL_FLAG = 80;

/** State byte 84: fileCount (u32, JS→C++). */
export const S_FILE_COUNT = 84;

/** State byte 88: cachePathLen (u32, JS→C++). */
export const S_CACHE_PATH_LEN = 88;

/** State byte 92: flags (u32, JS→C++). Bit 0 = resolveOnly. */
export const S_FLAGS = 92;

/** State byte 96+: null-terminated UTF-8 cachePath (immutable after construction). */
export const S_CACHE_PATH = 96;
