/**
 * Binary format constants for the file-hash-cache subsystem.
 *
 * ### Binary layout (v0)
 *
 * Header (64 bytes, cache-line aligned, all u32 LE):
 *
 * ```
 *   Slot  Offset  Field
 *   ────  ──────  ──────────────────────────────────────────────────
 *    0     0      Magic: 0x00485346 — bytes 'F','S','H', 0x00
 *    1     4      User version (u32)
 *    2     8      userValue0  ┐
 *    3    12      userValue1  │ 4 × u32, user-defined, not validated
 *    4    16      userValue2  │
 *    5    20      userValue3  ┘
 *    6    24      File count ← (count << 1) | wasmBit
 *    7    28      Fingerprint word 0  ┐
 *    8    32      Fingerprint word 1  │ 16-byte xxHash3-128
 *    9    36      Fingerprint word 2  │
 *   10    40      Fingerprint word 3  ┘
 *   11    44      Paths section byte length
 *   12-15 48-63   Reserved (zero)
 * ```
 *
 * Section offsets (all computable from header fields — O(1)):
 *
 * ```
 *   Entries: 64
 *   Paths:   64 + fileCount × 48
 *   User data: 64 + fileCount × 48 + pathsLen
 * ```
 *
 * Entries section (fixed stride, fileCount × 48 bytes):
 *   Per entry (48 bytes):
 *     [0..7]   stat.ino (u64 LE)
 *     [8..15]  stat.mtimeNs (u64 LE) — nanosecond precision
 *     [16..23] stat.ctimeNs (u64 LE) — nanosecond precision
 *     [24..31] stat.size (u64 LE)
 *     [32..47] Content hash (16 bytes xxHash3-128)
 *
 * Paths section (null-separated UTF-8):
 *   Sorted paths, each terminated by a `\0` byte.
 *   Decoded by PathIndex (C++) / decodeFilePaths (JS).
 *
 * User data section (after paths):
 *   Raw bytes written by the user via write(). Read back via read().
 *
 * Shared across the base class, impl backends, and tests.
 * All values are compile-time constants — no runtime dependencies.
 *
 * @module
 * @internal
 */

/**
 * Header - Binary format magic: bytes 'F','S','H',0x00.
 */
export const MAGIC = 0x00485346;

/** Header - Fixed header size in bytes (one cache line). */
export const HEADER_SIZE = 64;

/** Fixed byte size of each file entry (4×u64 + 16-byte hash = 48). */
export const ENTRY_STRIDE = 48;

/** Header - Slot 0: Magic number. */
export const H_MAGIC = 0;

/** Header - Slot 1: User version. */
export const H_VERSION = 1;

/** Header - Slot 2: First user value. Slots 2-5 hold 4 u32 user values. */
export const H_USER = 2;

/** Header - Slot 6: File count with wasm bit — `(count << 1) | wasmBit`. */
export const H_FILE_COUNT = 6;

/** Header - Byte offset of the 16-byte fingerprint within the header (slot 7 × 4 = 28). */
export const H_FINGERPRINT_BYTE = 28;

/** Header - Slot 11: Paths section byte length. */
export const H_PATHS_LEN = 11;

// Per-file state flags

/** Per-file state flag - File not yet processed (validate exited early or no old data). */
export const F_NOT_CHECKED = 0;

/** Per-file state flag - Entry fully resolved: stat written + hash in entriesBuf. */
export const F_DONE = 1;

/** Per-file state flag - Stat written but hash still zero (need content hash in serialize). */
export const F_NEED_HASH = 2;

/** Per-file state flag - Old entry pre-populated in entriesBuf; needs stat re-validation in completeEntries. */
export const F_HAS_OLD = 3;

// Various constants

/** Default stat() concurrency limit. */
export const STAT_CONCURRENCY = 32;

/** Cached stat options — avoids re-allocating the options object per call. */
export const STAT_BIGINT = { bigint: true } as const;
