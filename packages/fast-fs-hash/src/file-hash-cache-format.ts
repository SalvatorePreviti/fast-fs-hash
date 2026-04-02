/**
 * Binary format constants for the file-hash-cache on-disk and in-memory layout.
 *
 * ### On-disk layout
 *
 * ```
 * [header: 80 bytes, uncompressed][LZ4 compressed body]
 *
 * The header is 80 bytes. Bytes 72–79 contain in-memory-only fields (status,
 * fileHandle) that are reset before writing to disk.
 * ```
 *
 * The header is always readable without decompression. The LZ4 body contains:
 * ```
 * [entries: fileCount × 48 bytes]
 * [udDir: udItemCount × 4 bytes]
 * [pathEnds: fileCount × 4 bytes]
 * [paths: pathsLen bytes]
 * [user data payloads]
 * ```
 *
 * In-memory dataBuf layout is identical: [header:80][body].
 * Per-file state is encoded in the high 2 bits of each entry's inode field.
 *
 * @module
 * @internal
 */

/** Binary format magic: bytes 'F','S','H',0x00. */
export const MAGIC = 0x00485346;

/** Fixed header size in bytes. */
export const HEADER_SIZE = 80;

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

/** Header byte 72: status (u32, in-memory only, 0 on disk). */
export const H_STATUS_BYTE = 72;

/** Header byte 76: fileHandle (int32 LE fd, in-memory only, -1 on disk). */
export const H_FILE_HANDLE = 76;

/** Fixed byte size of each file entry (48 bytes, 16-byte aligned). */
export const ENTRY_STRIDE = 48;

/** Maximum total user data payload size (128 MiB, matches C++ CACHE_MAX_UD_PAYLOADS). */
export const CACHE_MAX_USER_DATA_SIZE = 128 * 1024 * 1024;
