/**
 * Public types for the FileHashCache subsystem.
 *
 * @module
 */

/**
 * A value that can be stored in a data section.
 *
 * - `Uint8Array` — raw binary (type tag 0).  When read back from the raw
 *   (uncompressed) section the returned Buffer is a zero-copy view.
 * - `string` — UTF-8 (type tag 1).
 * - `null` — stored natively (type tag 3, zero payload bytes).
 * - `undefined` — stored natively (type tag 4, zero payload bytes).
 * - Any other value — JSON via `JSON.stringify` (type tag 2).
 */
export type FileHashCacheDataValue =
  | Uint8Array
  | string
  | number
  | boolean
  | null
  | undefined
  | FileHashCacheDataValue[]
  | { [key: string]: FileHashCacheDataValue };

/** Options for the {@link FileHashCacheManager} constructor. */
export interface FileHashCacheManagerOptions {
  /**
   * 24-bit user-defined cache version (0–16 777 215).  Default: 0.
   *
   * A version mismatch between manager and cache file rejects the cache
   * immediately (fast reject — no entries are parsed).
   */
  version?: number;

  /** Lower 32 bits of the 64-bit seed for the aggregate digest.  Default: 0. */
  seedLow?: number;

  /** Upper 32 bits of the 64-bit seed for the aggregate digest.  Default: 0. */
  seedHigh?: number;
}

/** Result of {@link FileHashCacheReader.validate}. */
export interface FileHashCacheValidateResult {
  /** `true` if the digest differs from the cached one. */
  changed: boolean;

  /** 16-byte aggregate digest of all per-file hashes (in input order). */
  digest: Buffer;

  /** Number of files that required re-hashing (slow path). */
  rehashed: number;
}

/** Options for {@link FileHashCacheReader.write}. */
export interface FileHashCacheWriteOptions {
  /**
   * Path to write to.  Defaults to the path passed to the reader constructor.
   * The parent directory is created automatically.
   */
  filePath?: string;

  /** Uncompressed data items.  Stored raw — zero-copy reads possible. */
  raw?: readonly FileHashCacheDataValue[];

  /** Compressed data items.  Gzipped together as a single blob. */
  gzip?: readonly FileHashCacheDataValue[];

  /** Gzip compression level (1–9).  Default: 1.  Only used when `gzip` items are present. */
  gzipLevel?: number;
}

/** Header information returned by {@link FileHashCacheReader.header}. */
export interface FileHashCacheHeaderInfo {
  /** 24-bit user version from the cache file. */
  version: number;
  /** Number of file entries. */
  entryCount: number;
  /** 16-byte aggregate digest. */
  digest: Buffer;
  /** 16-byte fingerprint. */
  fingerprint: Buffer;
  /** Paths section byte length. */
  pathsLen: number;
  /** Raw data section byte length. */
  rawDataLen: number;
  /** Raw data item count. */
  rawItemCount: number;
  /** Gzip data section byte length (compressed). */
  gzipDataLen: number;
  /** Gzip data item count. */
  gzipItemCount: number;
  /** Gzip data uncompressed byte length. */
  gzipUncompressedLen: number;
}
