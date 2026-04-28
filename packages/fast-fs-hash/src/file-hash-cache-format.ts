/**
 * Binary format constants for the file-hash-cache on-disk and in-memory layout.
 *
 * ### On-disk layout
 *
 * ```
 * [header: 80 bytes, uncompressed]
 * [uncompressed payloads section, uncompressed]
 * [LZ4 compressed body]
 * ```
 *
 * The header is 80 bytes (pure on-disk format, no in-memory-only fields).
 * The header is always readable without decompression. The uncompressed
 * payloads section sits directly after the header and is stored raw:
 * ```
 * [uncompressedPayloadDir: uncompressedPayloadItemCount × 4][uncompressed payload bytes]
 * ```
 * The LZ4 body contains:
 * ```
 * [entries: fileCount × 48 bytes]
 * [compressedPayloadDir: compressedPayloadItemCount × 4 bytes]
 * [pathEnds: fileCount × 4 bytes]
 * [paths: pathsLen bytes]
 * [compressed payload bytes]
 * ```
 *
 * In-memory dataBuf layout mirrors disk exactly.
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

/** Header byte 12: Number of compressed payload items (u32). */
export const H_COMPRESSED_PAYLOAD_ITEM_COUNT = 12;

/** Header byte 16: Fingerprint (16 bytes xxHash3-128, or all-zero). */
export const H_FINGERPRINT_BYTE = 16;

/** Header byte 32: payloadValue0 (f64 LE). */
export const H_PAYLOAD0_BYTE = 32;

/** Header byte 40: payloadValue1 (f64 LE). */
export const H_PAYLOAD1_BYTE = 40;

/** Header byte 48: payloadValue2 (f64 LE). */
export const H_PAYLOAD2_BYTE = 48;

/** Header byte 56: payloadValue3 (f64 LE). */
export const H_PAYLOAD3_BYTE = 56;

/** Header byte 64: Byte length of the packed paths section (u32). */
export const H_PATHS_LEN = 64;

/** Header byte 68: Total byte length of compressed payloads (u32). */
export const H_COMPRESSED_PAYLOADS_LEN = 68;

/** Header byte 72: Number of uncompressed payload items (u32). */
export const H_UNCOMPRESSED_PAYLOAD_ITEM_COUNT = 72;

/** Header byte 76: Total byte length of uncompressed payloads (u32). */
export const H_UNCOMPRESSED_PAYLOADS_LEN = 76;

/** Fixed byte size of each file entry (48 bytes, 16-byte aligned). */
export const ENTRY_STRIDE = 48;

/** Maximum total compressed payload size (128 MiB, matches C++ CACHE_MAX_COMPRESSED_PAYLOADS). */
export const CACHE_MAX_COMPRESSED_PAYLOADS_SIZE = 128 * 1024 * 1024;

/** Maximum total uncompressed payload size (128 MiB, matches C++ CACHE_MAX_UNCOMPRESSED_PAYLOADS). */
export const CACHE_MAX_UNCOMPRESSED_PAYLOADS_SIZE = 128 * 1024 * 1024;

// - CacheStateBuf offsets

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

/** State byte 48: payloadValue0 (f64, JS→C++). */
export const S_PAYLOAD0 = 48;

/** State byte 56: payloadValue1 (f64, JS→C++). */
export const S_PAYLOAD1 = 56;

/** State byte 64: payloadValue2 (f64, JS→C++). */
export const S_PAYLOAD2 = 64;

/** State byte 72: payloadValue3 (f64, JS→C++). */
export const S_PAYLOAD3 = 72;

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
