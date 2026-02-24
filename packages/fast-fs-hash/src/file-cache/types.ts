/**
 * Public types for the FileHashCache subsystem.
 *
 * @module
 */

/** Options for the {@link FileHashCacheBase} constructor. */
export interface FileHashCacheOptions {
  /**
   * User-defined cache version (full u32, 0-4 294 967 295).  Default: 0.
   *
   * A version mismatch between the constructor and the cache file rejects
   * the cache immediately (fast reject — no entries are parsed).
   */
  version?: number;

  /**
   * 16-byte fingerprint for fast cache rejection.
   *
   * Must be a `Uint8Array` (or `Buffer`) of exactly 16 bytes.
   * A mismatch rejects the cache immediately (no entries parsed).
   * If omitted, defaults to 16 zero bytes.
   *
   * @throws {TypeError} If not a Uint8Array or not exactly 16 bytes.
   */
  fingerprint?: Uint8Array;
}

/**
 * Result of {@link FileHashCacheBase.open}.
 *
 * - `"valid"`     — cache file exists and the header is valid (magic, version,
 *                    fingerprint all match). Entries and paths have been read.
 * - `"not-found"` — cache file does not exist or could not be opened.
 * - `"stale"`     — cache file exists but magic, version, or fingerprint
 *                    do not match the current configuration.
 * - `"corrupt"`   — header is present but the body (entries + paths) is
 *                    truncated or unreadable.
 * - `"empty"`     — header is valid but the file count is zero.
 */
export type FileHashCacheOpenResult = "valid" | "not-found" | "stale" | "corrupt" | "empty";

/**
 * Result of {@link FileHashCacheBase.serialize}.
 *
 * - `"written"` — cache file was successfully written to disk.
 * - `"deleted"` — no files to cache; the old cache file (if any) was removed.
 * - `"error"`  — an I/O error occurred during the write (temp file cleaned up).
 */
export type FileHashCacheSerializeResult = "written" | "deleted" | "error";
