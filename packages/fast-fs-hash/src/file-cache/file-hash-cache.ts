/**
 * FileHashCache — stateful reader/validator/writer for cache files.
 *
 * Lifecycle: `open()` → `validate()` → read / `write()` → `close()`.
 *
 * The cache keeps the file handle open between calls so data sections
 * can be read lazily (only when requested).  After {@link validate},
 * the cache holds the new entries (reusing cached hashes for unchanged
 * files) so {@link write} can persist them without recomputation.
 *
 * @module
 */

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { writeFile as fsWriteFile, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { bufferAlloc, bufferAllocUnsafe, bufferFrom } from "../helpers";
import { XXHash128 } from "../xxhash128";
import type { CacheEntry, ParsedHeader } from "./format";
import {
  buildEntryMap,
  EMPTY,
  ENTRY_STRIDE,
  gzipDataOffset,
  HEADER_SIZE,
  parseEntriesArray,
  parseItems,
  parsePaths,
  pathsOffset,
  rawDataOffset,
  readFhHeader,
  serializeCache,
  serializeItems,
  statAll,
} from "./format";
import type { FileHashCacheManager } from "./manager";
import type {
  FileHashCacheDataValue,
  FileHashCacheHeaderInfo,
  FileHashCacheValidateResult,
  FileHashCacheWriteOptions,
} from "./types";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Read-only open flag. */
const O_RD = constants.O_RDONLY;

/** 16-byte zero buffer used when no fingerprint is provided. */
const ZERO_FP = bufferAlloc(16);

/**
 * Normalize an optional fingerprint to a 16-byte `Buffer`.
 *
 * - `undefined` / `null` → 16 zero bytes.
 * - `Uint8Array` of exactly 16 bytes → stored as-is (wrapped in Buffer).
 * - Anything else → hashed with xxHash3-128 to produce 16 bytes.
 */
function normalizeFingerprint(fp: string | Uint8Array | undefined): Buffer {
  if (fp === undefined || fp === null) {
    return ZERO_FP;
  }
  if (fp instanceof Uint8Array && fp.length === 16) {
    return bufferFrom(fp);
  }
  const h = new XXHash128();
  h.update(typeof fp === "string" ? fp : bufferFrom(fp));
  return h.digest();
}

/**
 * Stateful cache reader, validator, and writer.
 *
 * @example
 * ```ts
 * const manager = new FileHashCacheManager({ version: 1 });
 *
 * await using cache = new FileHashCache(manager, ".cache/fsh", "my-config");
 * await cache.open();
 *
 * const { changed, digest, rehashed } = await cache.validate(files);
 *
 * if (changed) {
 *   const code = await compile(files);
 *   await cache.write({
 *     raw: [{ exports: ["foo"] }],
 *     gzip: [code],
 *     gzipLevel: 3,
 *   });
 * } else {
 *   const [meta] = await cache.readRawData();
 *   const [code] = await cache.readGzipData();
 * }
 * ```
 */
export class FileHashCache {
  /** The manager providing version / seed. */
  public readonly manager: FileHashCacheManager;

  /** The file path this cache was opened on. */
  public readonly filePath: string;

  /**
   * Normalized 16-byte fingerprint for fast cache rejection.
   *
   * Derived from the optional `fingerprint` constructor parameter.
   */
  public readonly fingerprint: Buffer;

  // ── Internal state ─────────────────────────────────────────────────

  private _fh: FileHandle | null = null;
  private _hdr: ParsedHeader | null = null;
  private _headerValid = false; // version + fingerprint matched

  // Cached entries from the on-disk file (set after open when header is valid).
  private _oldPaths: string[] | null = null;
  private _oldEntries: CacheEntry[] | null = null;
  private _oldDigest: Buffer | null = null;

  // Validated state (set after validate).
  private _validPaths: string[] | null = null;
  private _validEntries: CacheEntry[] | null = null;
  private _validDigest: Buffer | null = null;

  /**
   * @param manager   Shared configuration (version, seed).
   * @param filePath  Path to the cache file on disk.
   * @param fingerprint  Optional per-file fingerprint for fast cache rejection.
   *   A `Uint8Array` of exactly 16 bytes is stored as-is; a `string` or other
   *   `Uint8Array` is hashed with xxHash3-128.  `undefined` → 16 zero bytes.
   */
  public constructor(manager: FileHashCacheManager, filePath: string, fingerprint?: string | Uint8Array) {
    this.manager = manager;
    this.filePath = filePath;
    this.fingerprint = normalizeFingerprint(fingerprint);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Open the cache file and read the header.
   *
   * If the file does not exist, cannot be read, or has bad magic /
   * version / fingerprint mismatch, the cache records the state
   * internally so that {@link validate} treats it as "no previous
   * cache" (all files will be re-hashed).
   *
   * Call this before {@link validate}.
   */
  public async open(): Promise<void> {
    await this.close();

    try {
      this._fh = await open(this.filePath, O_RD);
      this._hdr = await readFhHeader(this._fh);

      if (this._hdr && this._hdr.version === this.manager.version && this.fingerprint.equals(this._hdr.fingerprint)) {
        this._headerValid = true;
        await this._loadOldEntries();
      }
    } catch {
      // File not found or unreadable — proceed without old cache.
    }
  }

  /**
   * Close the file handle and reset internal state.
   *
   * Safe to call multiple times or on an unopened cache.
   */
  public async close(): Promise<void> {
    const fh = this._fh;
    this._fh = null;
    this._hdr = null;
    this._headerValid = false;
    this._oldPaths = null;
    this._oldEntries = null;
    this._oldDigest = null;
    this._validPaths = null;
    this._validEntries = null;
    this._validDigest = null;
    if (fh) {
      await fh.close();
    }
  }

  /** Async dispose — closes the file handle. */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ── Header info ────────────────────────────────────────────────────

  /**
   * Header info from the opened cache file, or `null` if the file is
   * missing, unreadable, or has a bad magic number.
   *
   * Available after {@link open}.
   */
  public get header(): FileHashCacheHeaderInfo | null {
    const h = this._hdr;
    if (!h) {
      return null;
    }
    return {
      version: h.version,
      entryCount: h.entryCount,
      digest: Buffer.from(h.digest),
      fingerprint: Buffer.from(h.fingerprint),
      pathsLen: h.pathsLen,
      rawDataLen: h.rawDataLen,
      rawItemCount: h.rawItemCount,
      gzipDataLen: h.gzipDataLen,
      gzipItemCount: h.gzipItemCount,
      gzipUncompressedLen: h.gzipUncompLen,
    };
  }

  /**
   * Whether the on-disk header matched the manager's version and fingerprint.
   * Available after {@link open}.
   */
  public get headerValid(): boolean {
    return this._headerValid;
  }

  // ── Validation ─────────────────────────────────────────────────────

  /**
   * Validate files against the cached entries.
   *
   * 1. `stat()` every file in parallel (bounded concurrency).
   * 2. Compare `(ino, mtimeNs, ctimeNs, size)` with old entries — match → reuse hash.
   * 3. Re-hash only changed files via `hashFilesBulk`.
   * 4. Compute aggregate digest with the manager's seed.
   * 5. Store new entries internally for {@link write}.
   *
   * @param files  File paths to validate.  Order affects the digest.
   *               If omitted, re-validates the files from the cache file.
   * @returns Validation result with `changed`, `digest`, and `rehashed`.
   */
  public async validate(files?: Iterable<string>): Promise<FileHashCacheValidateResult> {
    const { seedLow, seedHigh } = this.manager;

    // Resolve file paths.
    const filePaths = this._resolveFiles(files);
    const n = filePaths.length;

    // Build old-entry lookup.
    const oldMap = this._oldPaths && this._oldEntries ? buildEntryMap(this._oldPaths, this._oldEntries) : null;

    if (n === 0) {
      const agg = new XXHash128(seedLow, seedHigh);
      const digest = agg.digest();
      const changed = !this._oldDigest || !this._oldDigest.equals(digest);
      this._validPaths = [];
      this._validEntries = [];
      this._validDigest = digest;
      return { changed, digest, rehashed: 0 };
    }

    // 1. stat() all files in parallel.
    const stats = await statAll(filePaths);

    // 2. Reuse cached hashes or queue for re-hashing.
    const hashes = bufferAlloc(n * 16);
    const toHash: string[] = [];
    const toHashIdx: number[] = [];

    for (let i = 0; i < n; i++) {
      const s = stats[i];
      if (!s) {
        continue; // stat failed → zero hash (buffer already zeroed)
      }
      const cached = oldMap?.get(filePaths[i]);
      if (
        cached &&
        cached.ino === s.ino &&
        cached.mtimeNs === s.mtimeNs &&
        cached.ctimeNs === s.ctimeNs &&
        cached.size === s.size
      ) {
        hashes.set(cached.hash, i * 16);
      } else {
        toHash.push(filePaths[i]);
        toHashIdx.push(i);
      }
    }

    // 3. Hash changed files.
    if (toHash.length > 0) {
      const bulk = await XXHash128.hashFilesBulk({ files: toHash, outputMode: "files" });
      for (let j = 0; j < toHash.length; j++) {
        hashes.set(bulk.subarray(j * 16, (j + 1) * 16), toHashIdx[j] * 16);
      }
    }

    // 4. Aggregate digest.
    const agg = new XXHash128(seedLow, seedHigh);
    agg.update(hashes);
    const digest = agg.digest();

    // 5. Store validated state.
    const entries: CacheEntry[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = stats[i];
      entries[i] = {
        ino: s?.ino ?? 0n,
        mtimeNs: s?.mtimeNs ?? 0n,
        ctimeNs: s?.ctimeNs ?? 0n,
        size: s?.size ?? 0n,
        hash: hashes.subarray(i * 16, (i + 1) * 16),
      };
    }

    this._validPaths = filePaths;
    this._validEntries = entries;
    this._validDigest = digest;

    return {
      changed: !this._oldDigest || !this._oldDigest.equals(digest),
      digest,
      rehashed: toHash.length,
    };
  }

  // ── Lazy data readers ──────────────────────────────────────────────

  /**
   * Read raw (uncompressed) data items from the cache file.
   *
   * Seeks directly to the raw data section using header offsets — O(1).
   * Binary items are `Buffer` instances.
   *
   * Returns an empty array if no raw items or no valid cache file.
   */
  public async readRawData(): Promise<FileHashCacheDataValue[]> {
    const { _fh: fh, _hdr: hdr } = this;
    if (!fh || !hdr || hdr.rawItemCount === 0 || hdr.rawDataLen === 0) {
      return [];
    }
    try {
      const off = rawDataOffset(hdr.entryCount, hdr.pathsLen);
      const buf = bufferAllocUnsafe(hdr.rawDataLen);
      await fh.read(buf, 0, hdr.rawDataLen, off);
      return parseItems(buf, 0, hdr.rawItemCount);
    } catch {
      return [];
    }
  }

  /**
   * Read gzip-compressed data items from the cache file.
   *
   * Seeks directly to the gzip section using header offsets — O(1).
   * Decompresses and parses on demand.
   *
   * Returns an empty array if no gzip items or no valid cache file.
   */
  public async readGzipData(): Promise<FileHashCacheDataValue[]> {
    const { _fh: fh, _hdr: hdr } = this;
    if (!fh || !hdr || hdr.gzipItemCount === 0 || hdr.gzipDataLen === 0) {
      return [];
    }
    try {
      const off = gzipDataOffset(hdr.entryCount, hdr.pathsLen, hdr.rawDataLen);
      const buf = bufferAllocUnsafe(hdr.gzipDataLen);
      await fh.read(buf, 0, hdr.gzipDataLen, off);
      const payload: Buffer = await gunzipAsync(buf, { maxOutputLength: hdr.gzipUncompLen });
      return parseItems(payload, 0, hdr.gzipItemCount);
    } catch {
      return [];
    }
  }

  /**
   * Read file paths from the cache.
   *
   * After {@link validate}, returns the validated file list.
   * Before validate but after {@link open} with a valid header,
   * reads paths from the cache file.
   * Otherwise returns an empty array.
   */
  public readFiles(): string[] {
    if (this._validPaths) {
      return this._validPaths;
    }
    if (this._oldPaths) {
      return this._oldPaths;
    }
    return [];
  }

  // ── Write ──────────────────────────────────────────────────────────

  /**
   * Write a new cache file using the validated entries.
   *
   * Requires {@link validate} to have been called first.
   * Performs an atomic write (temp + rename).  Creates parent directories.
   *
   * @param options Data sections and optional output path.
   */
  public async write(options?: FileHashCacheWriteOptions): Promise<void> {
    if (!this._validPaths || !this._validEntries || !this._validDigest) {
      throw new Error("FileHashCache: call validate() before write()");
    }

    const { version } = this.manager;
    const rawItems = options?.raw ?? [];
    const gzipItems = options?.gzip ?? [];
    const gzipLevel = options?.gzipLevel ?? 1;

    if (gzipItems.length > 0 && (gzipLevel < 1 || gzipLevel > 9)) {
      throw new RangeError("FileHashCache: gzipLevel must be 1–9");
    }

    // Serialize data sections.
    const rawBlob = rawItems.length > 0 ? serializeItems(rawItems) : EMPTY;
    let gzipBlob: Uint8Array = EMPTY;
    let gzipUncompLen = 0;
    if (gzipItems.length > 0) {
      const raw = serializeItems(gzipItems);
      gzipUncompLen = raw.length;
      gzipBlob = await gzipAsync(raw, { level: gzipLevel });
    }

    const buf = serializeCache(
      this._validPaths,
      this._validEntries,
      version,
      this.fingerprint,
      this._validDigest,
      rawBlob,
      gzipBlob,
      gzipUncompLen,
      rawItems.length,
      gzipItems.length
    );

    const outPath = options?.filePath ?? this.filePath;
    await mkdir(path.dirname(outPath), { recursive: true });
    const tmp = `${outPath}.tmp-${process.pid}`;
    await fsWriteFile(tmp, buf);
    await rename(tmp, outPath);
  }

  // ── Private helpers ────────────────────────────────────────────────

  /** Load old entries + paths from the open file. */
  private async _loadOldEntries(): Promise<void> {
    const { _fh: fh, _hdr: hdr } = this;
    if (!fh || !hdr) {
      return;
    }

    this._oldDigest = Buffer.from(hdr.digest);

    if (hdr.entryCount === 0) {
      this._oldPaths = [];
      this._oldEntries = [];
      return;
    }

    // Read entries section.
    const entriesLen = hdr.entryCount * ENTRY_STRIDE;
    const eBuf = bufferAllocUnsafe(entriesLen);
    await fh.read(eBuf, 0, entriesLen, HEADER_SIZE);
    this._oldEntries = parseEntriesArray(eBuf, 0, hdr.entryCount);

    // Read paths section.
    if (hdr.pathsLen > 0) {
      const pBuf = bufferAllocUnsafe(hdr.pathsLen);
      await fh.read(pBuf, 0, hdr.pathsLen, pathsOffset(hdr.entryCount));
      this._oldPaths = parsePaths(pBuf, 0, hdr.pathsLen);
    } else {
      this._oldPaths = new Array(hdr.entryCount).fill("");
    }
  }

  /** Resolve file paths from user input or old cache. */
  private _resolveFiles(files: Iterable<string> | undefined): string[] {
    if (files !== undefined) {
      return Array.isArray(files) ? (files as string[]) : Array.from(files);
    }
    if (this._oldPaths) {
      return [...this._oldPaths];
    }
    return [];
  }
}
