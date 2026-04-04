/**
 * FileHashCache — long-lived file hash cache with exclusive locking.
 *
 * {@link FileHashCache} is the configuration holder: it stores the cache path,
 * root path, version, fingerprint, file list, and lock timeout. These can be
 * changed between opens via setters.
 *
 * {@link FileHashCacheSession} is the lock holder returned by {@link FileHashCache.open}.
 * It provides access to the cache state and a {@link FileHashCacheSession.write}
 * method to persist changes. The lock is released by {@link FileHashCacheSession.write}
 * (after writing), by {@link FileHashCacheSession.close}, or by the `using` / `await using`
 * disposable pattern.
 *
 * @module
 */

import {
  ENTRY_STRIDE,
  H_CACHE_STAT0,
  H_CACHE_STAT1,
  H_FILE_COUNT,
  H_FILE_HANDLE,
  H_FINGERPRINT_BYTE,
  H_PATHS_LEN,
  H_STATUS_BYTE,
  H_UD_ITEM_COUNT,
  H_UD_PAYLOADS_LEN,
  H_USER_VALUE0_BYTE,
  H_USER_VALUE1_BYTE,
  H_USER_VALUE2_BYTE,
  H_USER_VALUE3_BYTE,
  HEADER_SIZE,
} from "./file-hash-cache-format";
import { resolveDir, resolveRoot } from "./file-hash-cache-utils";
import { binding } from "./init-native";
import { encodeNormalizedPaths, normalizeFilePaths, pathResolve, toRelativePath } from "./utils";

/**
 * Cache status.
 *
 * - `'upToDate'`    — nothing changed.
 * - `'statsDirty'`  — stat metadata updated but content unchanged (cache needs rewrite).
 * - `'changed'`     — content changed (size or hash mismatch in at least one file).
 * - `'stale'`       — version/fingerprint mismatch (entries not trusted).
 * - `'missing'`     — no cache file or unreadable/corrupt.
 * - `'lockFailed'`  — could not acquire the lock (timeout, non-blocking, or cancelled).
 */
export type CacheStatus = "upToDate" | "statsDirty" | "changed" | "stale" | "missing" | "lockFailed";

/** Options for the {@link FileHashCache} constructor. */
export interface FileHashCacheOptions {
  /** Path to the cache file. */
  cachePath: string;
  /** File paths to track. Pass `null`/`undefined` to reuse the file list from
   *  the existing cache on disk (requires `rootPath`). */
  files?: Iterable<string> | null;
  /** Root directory for file path resolution. When provided, file paths are stored
   *  relative to this directory. When `null`/`undefined`, auto-detected as the
   *  common parent of all `files`. Required when `files` is `null` (reuse mode). */
  rootPath?: string | null;
  /** User-defined cache version (u32, 0-4294967295). Default: `0`. */
  version?: number;
  /** 16-byte fingerprint for fast cache rejection. `null` or omit for none. */
  fingerprint?: Uint8Array | null;
  /** Lock acquisition timeout in ms. `-1` (default) = block forever,
   *  `0` = non-blocking try, `>0` = timeout. */
  lockTimeoutMs?: number;
}

/**
 * Options for {@link FileHashCacheSession.write} and {@link FileHashCache.overwrite}.
 *
 * All fields are optional. When passed to `write()` or `overwrite()`, the values
 * are applied to the parent {@link FileHashCache} first (updating version, fingerprint,
 * rootPath, files) and then written to disk. Omitted fields keep the current value.
 */
export interface FileHashCacheWriteOptions {
  /** Override cache version (u32). Applied to the cache before writing. */
  version?: number;
  /** Override fingerprint (16 bytes). Applied to the cache before writing. */
  fingerprint?: Uint8Array | null;
  /** Override root path. Pass `true` to auto-detect from files. Applied to the cache before writing. */
  rootPath?: string | true;
  /** Override file list. Applied to the cache before writing. */
  files?: Iterable<string> | null;
  /** User f64 value (slot 0). Default: preserves old value (or `0` for overwrite). */
  userValue0?: number;
  /** User f64 value (slot 1). Default: preserves old value (or `0` for overwrite). */
  userValue1?: number;
  /** User f64 value (slot 2). Default: preserves old value (or `0` for overwrite). */
  userValue2?: number;
  /** User f64 value (slot 3). Default: preserves old value (or `0` for overwrite). */
  userValue3?: number;
  /** Opaque binary payloads stored alongside the cache. Default: preserves old value (or `null` for overwrite). */
  userData?: readonly Uint8Array[] | null;
  /** Optional AbortSignal to cancel the hash phase. */
  signal?: AbortSignal | null;
  /** Lock acquisition timeout in ms (used by overwrite). `-1` = block forever, `0` = non-blocking. */
  lockTimeoutMs?: number;
}

/** @deprecated Use {@link FileHashCacheWriteOptions} instead. */
export type FileHashCachePayloads = FileHashCacheWriteOptions;

const STATUS_MAP: readonly CacheStatus[] = ["upToDate", "changed", "stale", "missing", "statsDirty", "lockFailed"];

const { cacheOpen, cacheWrite, cacheWriteNew, cacheIsLocked, cacheWaitUnlocked, cacheClose, cacheStatHash } = binding;

const _emptyBuf = Buffer.alloc(0);
const _cancelledBuf = new Uint8Array([1]);
const _statHashBuf = new Float64Array(2);

// ── Cancel-signal helpers ────────────────────────────────────────────

interface CancelState {
  buf: Uint8Array;
  sig: AbortSignal;
  cb: () => void;
}

let _cancelStates: CancelState[] | undefined;

function cancelBufFromSignal(signal: AbortSignal): Uint8Array {
  if (signal.aborted) {
    return _cancelledBuf;
  }
  const buf = new Uint8Array(1);
  const cb = () => {
    binding.cacheFireCancel(buf);
  };
  signal.addEventListener("abort", cb, { once: true });
  (_cancelStates ??= []).push({ buf, sig: signal, cb });
  return buf;
}

function cleanupCancelBuf(buf: Uint8Array | null | undefined): void {
  if (!buf || !_cancelStates) {
    return;
  }
  const states = _cancelStates;
  for (let i = states.length - 1; i >= 0; --i) {
    if (states[i].buf === buf) {
      const { sig, cb } = states[i];
      states.splice(i, 1);
      if (states.length === 0) {
        _cancelStates = undefined;
      }
      sig.removeEventListener("abort", cb as EventListener);
      return;
    }
  }
}

// ── dataBuf layout helpers ───────────────────────────────────────────

/** Parsed body-section offsets for a dataBuf. */
interface DataBufLayout {
  fc: number;
  pathsLen: number;
  udItemCount: number;
  udDirStart: number;
  pathEndsStart: number;
  pathsStart: number;
  udPayloadsStart: number;
}

/** Parse body layout offsets from a dataBuf header. */
function dataBufLayout(buf: Buffer): DataBufLayout {
  const fc = buf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
  const udPayloadsLen = buf.readUInt32LE(H_UD_PAYLOADS_LEN);
  let udItemCount = buf.readUInt32LE(H_UD_ITEM_COUNT);
  const udDirStart = HEADER_SIZE + fc * ENTRY_STRIDE;
  const pathEndsStart = udDirStart + udItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
  const udPayloadsStart = pathsStart + pathsLen;
  if (udPayloadsStart + udPayloadsLen > buf.length) {
    udItemCount = 0;
  }
  return { fc, pathsLen, udItemCount, udDirStart, pathEndsStart, pathsStart, udPayloadsStart };
}

/** Decode file paths from a dataBuf into a string array (relative paths). */
function decodeFilePaths(buf: Buffer, layout: DataBufLayout): string[] {
  const { fc, pathsLen, pathEndsStart, pathsStart } = layout;
  if (fc <= 0 || pathsLen <= 0) {
    return [];
  }
  const result: string[] = new Array(fc);
  let prevEnd = 0;
  for (let i = 0; i < fc; i++) {
    const end = buf.readUInt32LE(pathEndsStart + i * 4);
    const clampedEnd = end > pathsLen ? pathsLen : end;
    result[i] = buf.toString("utf8", pathsStart + prevEnd, pathsStart + clampedEnd);
    prevEnd = clampedEnd;
  }
  return result;
}

/** Convert an array of relative paths to absolute by prepending rootPath. */
function toAbsolutePaths(rootPath: string, relativePaths: readonly string[]): string[] {
  const n = relativePaths.length;
  const result = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    result[i] = rootPath + relativePaths[i];
  }
  return result;
}

/**
 * Extract NUL-separated encoded paths directly from a dataBuf (raw byte copy).
 * Produces the same format as encodeNormalizedPaths(): "path0\0path1\0...pathN\0".
 * No string allocation or encoding — pure memcpy + NUL insertion.
 */
function extractEncodedPaths(buf: Buffer, layout: DataBufLayout): Buffer {
  const { fc, pathsLen, pathEndsStart, pathsStart } = layout;
  if (fc <= 0 || pathsLen <= 0) {
    return _emptyBuf;
  }
  // Encoded = pathsLen bytes of path data + fc NUL terminators
  const encoded = Buffer.allocUnsafe(pathsLen + fc);
  let prevEnd = 0;
  let w = 0;
  for (let i = 0; i < fc; i++) {
    const end = buf.readUInt32LE(pathEndsStart + i * 4);
    const clampedEnd = end > pathsLen ? pathsLen : end;
    const segLen = clampedEnd - prevEnd;
    if (segLen > 0) {
      buf.copy(encoded, w, pathsStart + prevEnd, pathsStart + clampedEnd);
      w += segLen;
    }
    encoded[w++] = 0;
    prevEnd = clampedEnd;
  }
  return w === encoded.length ? encoded : encoded.subarray(0, w);
}

/** Decode file path strings from NUL-separated encoded paths buffer. */
function decodeEncodedPaths(encoded: Buffer, fc: number): string[] {
  if (fc <= 0 || encoded.length === 0) {
    return [];
  }
  const result: string[] = new Array(fc);
  let start = 0;
  for (let i = 0; i < fc; i++) {
    let end = start;
    while (end < encoded.length && encoded[end] !== 0) {
      end++;
    }
    result[i] = encoded.toString("utf8", start, end);
    start = end + 1; // skip NUL
  }
  return result;
}

/** Read user-data payload buffers from a dataBuf. */
function readPayloadData(dataBuf: Buffer, layout: DataBufLayout): readonly Buffer[] {
  const { udItemCount, udDirStart, udPayloadsStart } = layout;
  if (udItemCount <= 0) {
    return [];
  }
  const result: Buffer[] = new Array(udItemCount);
  let prevEnd = 0;
  for (let i = 0; i < udItemCount; i++) {
    const end = dataBuf.readUInt32LE(udDirStart + i * 4);
    const start = prevEnd;
    const size = end - start;
    prevEnd = end;
    if (size <= 0) {
      result[i] = _emptyBuf;
    } else {
      result[i] = Buffer.from(dataBuf.subarray(udPayloadsStart + start, udPayloadsStart + start + size));
    }
  }
  return result;
}

// ── Misc helpers ─────────────────────────────────────────────────────

function statusFromInt(n: number): CacheStatus {
  return STATUS_MAP[n] ?? "missing";
}

async function doWriteNew(
  cachePath: string,
  rootPath: string,
  encodedPaths: Buffer,
  fileCount: number,
  version: number,
  fingerprint: Uint8Array | null,
  lockTimeoutMs: number,
  uv0: number,
  uv1: number,
  uv2: number,
  uv3: number,
  userData: readonly Uint8Array[] | null,
  signal?: AbortSignal | null
): Promise<boolean> {
  const cancelBuf = signal ? cancelBufFromSignal(signal) : null;
  try {
    return (
      (await cacheWriteNew(
        encodedPaths,
        fileCount,
        cachePath,
        rootPath,
        version,
        fingerprint,
        uv0,
        uv1,
        uv2,
        uv3,
        userData,
        lockTimeoutMs,
        cancelBuf
      )) === 0
    );
  } finally {
    cleanupCancelBuf(cancelBuf);
  }
}

// ── FileHashCache ────────────────────────────────────────────────────

/**
 * A long-lived file hash cache configuration holder.
 *
 * Stores the cache file path, root path, version, fingerprint, file list,
 * and lock timeout. These can be mutated between opens via setters.
 *
 * Call {@link open} to acquire an exclusive OS-level lock and get a
 * {@link FileHashCacheSession}. Only one session can be active at a time.
 *
 * @example
 * ```ts
 * const cache = new FileHashCache({
 *   cachePath: "cache.fsh",
 *   files,
 *   rootPath: "/project",
 *   version: 1,
 * });
 *
 * // Batch: open, check, write
 * await using session = await cache.open();
 * if (session.status !== "upToDate") {
 *   await session.write();
 * }
 *
 * // Watch mode: update files, re-open
 * cache.files = newFileList;
 * cache.invalidate(["src/foo.ts"]);
 * await using session2 = await cache.open();
 * ```
 */
export class FileHashCache {
  #cachePath: string;
  #rootPath: string;
  #version: number;
  #fingerprint: Uint8Array | null;
  #lockTimeoutMs: number;

  /** NUL-separated encoded paths (relative) for C++. Source of truth for file identity. */
  #encodedPaths: Buffer;
  #fileCount: number;
  /** Absolute paths — lazily populated from #encodedPaths + #rootPath. */
  #absoluteFiles: readonly string[] | null;

  #activeSession: FileHashCacheSession | null = null;
  #dirtyAll: boolean = true;
  #dirtyPaths: Set<string> | null = null;

  /** Whether open() has ever been called successfully. */
  #opened: boolean = false;
  /** Version that was last successfully written/opened as upToDate. */
  #lastWrittenVersion: number = -1;
  /** Fingerprint that was last successfully written/opened as upToDate (null = none). */
  #lastWrittenFingerprint: Uint8Array | null = null;
  /** xxHash128 of cache file stat, stamped by C++ after open/write (for checkCacheFile). */
  #lastCacheStat0: number = 0;
  #lastCacheStat1: number = 0;

  /** Simple mutex — only one async operation at a time. */
  #mutex: Promise<void> | null = null;
  #mutexResolve: (() => void) | null = null;

  /**
   * Create a new FileHashCache configuration.
   *
   * Normalizes and encodes file paths immediately (no I/O).
   */
  public constructor(options: FileHashCacheOptions) {
    const { cachePath, files, rootPath: rootPathOpt, version, fingerprint, lockTimeoutMs } = options;
    const rootPath = rootPathOpt ?? null;
    this.#version = (version ?? 0) >>> 0;
    this.#fingerprint = fingerprint ?? null;
    this.#lockTimeoutMs = lockTimeoutMs ?? -1;

    if (files) {
      const root = resolveRoot(null, files, rootPath);
      this.#rootPath = root;
      this.#cachePath = pathResolve(root, cachePath);
      const normalized = normalizeFilePaths(root, files);
      this.#absoluteFiles = toAbsolutePaths(root, normalized);
      this.#encodedPaths = encodeNormalizedPaths(normalized);
      this.#fileCount = normalized.length;
    } else {
      if (!rootPath) {
        this.#rootPath = "";
        this.#cachePath = pathResolve(cachePath);
      } else {
        const root = resolveDir(rootPath);
        this.#rootPath = root;
        this.#cachePath = pathResolve(root, cachePath);
      }
      this.#absoluteFiles = null;
      this.#encodedPaths = _emptyBuf;
      this.#fileCount = 0;
    }
  }

  /**
   * Whether an async operation (open, write, overwrite) is currently running.
   * When `true`, new calls to these methods will wait for the current operation to complete.
   */
  public get busy(): boolean {
    return this.#mutex !== null;
  }

  /** Number of tracked files. */
  public get fileCount(): number {
    return this.#fileCount;
  }

  /** Resolved cache file path (immutable after construction). */
  public get cachePath(): string {
    return this.#cachePath;
  }

  /** Root path used for file path resolution. */
  public get rootPath(): string {
    return this.#rootPath;
  }
  public set rootPath(value: string) {
    const root = resolveDir(value);
    if (root === this.#rootPath) {
      return;
    }
    this.#rootPath = root;
    this.#absoluteFiles = null; // rootPath changed — absolute paths are stale
    this.#dirtyAll = true;
    this.#dirtyPaths = null;
  }

  /** User-defined cache version (u32). */
  public get version(): number {
    return this.#version;
  }
  public set version(value: number) {
    this.#version = (value ?? 0) >>> 0;
  }

  /** 16-byte fingerprint for fast cache rejection. */
  public get fingerprint(): Uint8Array | null {
    return this.#fingerprint;
  }
  public set fingerprint(value: Uint8Array | null) {
    this.#fingerprint = value ?? null;
  }

  /** Lock acquisition timeout in ms. `-1` = block forever, `0` = non-blocking, `>0` = timeout. */
  public get lockTimeoutMs(): number {
    return this.#lockTimeoutMs;
  }
  public set lockTimeoutMs(value: number) {
    this.#lockTimeoutMs = value ?? -1;
  }

  /**
   * Current file list as absolute resolved paths (sorted).
   * `null` before the first open when constructed without `files` (reuse-from-disk mode).
   * Lazily decoded from encoded paths — no allocation until first access.
   */
  public get files(): readonly string[] | null {
    let f = this.#absoluteFiles;
    if (!f && this.#fileCount > 0) {
      f = toAbsolutePaths(this.#rootPath, decodeEncodedPaths(this.#encodedPaths, this.#fileCount));
      this.#absoluteFiles = f;
    }
    return f;
  }

  /**
   * Set the file list. Accepts absolute or relative paths — they are resolved
   * against rootPath, normalized, sorted, and deduplicated. Paths outside
   * rootPath are silently dropped. Marks all entries as dirty.
   */
  public set files(value: Iterable<string> | null) {
    if (value) {
      const root = this.#rootPath;
      if (!root) {
        throw new Error("FileHashCache: rootPath must be set before setting files, or pass files to the constructor");
      }
      const normalized = normalizeFilePaths(root, value);
      this.#absoluteFiles = toAbsolutePaths(root, normalized);
      this.#encodedPaths = encodeNormalizedPaths(normalized);
      this.#fileCount = normalized.length;
    } else {
      this.#absoluteFiles = null;
      this.#encodedPaths = _emptyBuf;
      this.#fileCount = 0;
    }
    this.#dirtyAll = true;
    this.#dirtyPaths = null;
  }

  /**
   * Mark specific files as dirty. On the next {@link open}, the C++ stat-match
   * will only stat these files (plus any previously invalidated files), skipping
   * stat for all other entries.
   *
   * Accepts absolute or relative paths — they are resolved against rootPath.
   *
   * Has no effect if the cache is already fully invalidated (e.g. after
   * setting {@link files} or calling {@link invalidateAll}).
   */
  public invalidate(paths: Iterable<string>): void {
    if (this.#dirtyAll) {
      return;
    }
    const root = this.#rootPath;
    const dirty = (this.#dirtyPaths ??= new Set<string>());
    for (const p of paths) {
      const rel = root ? toRelativePath(root, p) : p;
      if (rel) {
        dirty.add(rel);
      }
    }
  }

  /**
   * Mark all files as dirty. Next {@link open} will stat-match every entry
   * (the default behavior).
   */
  public invalidateAll(): void {
    this.#dirtyAll = true;
    this.#dirtyPaths = null;
  }

  /**
   * Whether the cache should be opened (or re-opened).
   *
   * Returns `true` when:
   * - The cache has never been opened.
   * - Files, version, or fingerprint changed since the last successful open/write.
   * - {@link invalidateAll} or {@link invalidate} was called.
   *
   * Returns `false` only when the last open returned `'upToDate'` (or the last
   * write succeeded) and nothing has been mutated since.
   */
  public get needsOpen(): boolean {
    if (!this.#opened) {
      return true;
    }
    if (this.#dirtyAll || (this.#dirtyPaths !== null && this.#dirtyPaths.size > 0)) {
      return true;
    }
    if (this.#version !== this.#lastWrittenVersion) {
      return true;
    }
    const fp = this.#fingerprint;
    const lfp = this.#lastWrittenFingerprint;
    if (fp !== lfp) {
      if (
        !fp ||
        !lfp ||
        fp.length !== lfp.length ||
        !Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength).equals(
          Buffer.from(lfp.buffer, lfp.byteOffset, lfp.byteLength)
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check whether the cache file on disk may have changed since the last open.
   *
   * Stats the cache file and compares mtime and size with the values recorded
   * at the last successful open. Returns `true` if the file appears different,
   * does not exist, or if the cache has never been opened.
   *
   * This is a lightweight non-locking check useful in watch mode to decide
   * whether to re-open. It does **not** acquire a lock or read the file.
   */
  public checkCacheFile(): boolean {
    if (!this.#opened) {
      return true;
    }
    return cacheStatHash(this.#cachePath, this.#lastCacheStat0, this.#lastCacheStat1);
  }

  /** Acquire the mutex, waiting for any in-flight operation to finish first. */
  async #acquire(): Promise<void> {
    while (this.#mutex) {
      await this.#mutex;
    }
    this.#mutex = new Promise<void>((r) => {
      this.#mutexResolve = r;
    });
  }

  /** Release the mutex. */
  #release(): void {
    const resolve = this.#mutexResolve;
    this.#mutex = null;
    this.#mutexResolve = null;
    resolve?.();
  }

  /**
   * Open the cache with an exclusive OS-level lock.
   *
   * Acquires an exclusive lock on the cache file, reads from disk, validates
   * version/fingerprint/file list, and stat-matches entries to detect changes.
   *
   * If another operation is in progress, waits for it to complete first.
   * If a previous session is still active, it is automatically closed.
   *
   * @param signal Optional AbortSignal to cancel the lock wait and/or stat phase.
   * @returns A session holding the lock.
   */
  public async open(signal?: AbortSignal | null): Promise<FileHashCacheSession> {
    await this.#acquire();
    try {
      return await this.#doOpen(signal);
    } catch (e) {
      this.#release();
      throw e;
    }
  }

  async #doOpen(signal?: AbortSignal | null): Promise<FileHashCacheSession> {
    // Auto-close any lingering session from a previous operation.
    this.#activeSession?.close();

    const root = this.#rootPath;
    const cachePath = this.#cachePath;
    const ver = this.#version;
    const fp = this.#fingerprint;
    const encoded = this.#encodedPaths;
    const fileCount = this.#fileCount;
    const timeout = this.#lockTimeoutMs;

    // Build dirty paths buffer for C++ optimization.
    let dirtyBuf: Buffer | null = null;
    let dirtyCount = 0;
    if (!this.#dirtyAll && this.#dirtyPaths && this.#dirtyPaths.size > 0) {
      const dirtyArray = Array.from(this.#dirtyPaths);
      dirtyBuf = encodeNormalizedPaths(dirtyArray);
      dirtyCount = dirtyArray.length;
    } else if (!this.#dirtyAll && !this.#dirtyPaths) {
      // No dirty paths and not dirtyAll — tell C++ to skip all stat-matching.
      dirtyBuf = _emptyBuf;
      dirtyCount = 0;
    }
    // When dirtyAll is true, dirtyBuf stays null — C++ does full stat-match.

    const cancelBuf = signal ? cancelBufFromSignal(signal) : null;
    let dataBuf: Buffer;
    try {
      dataBuf = await cacheOpen(encoded, fileCount, cachePath, root, ver, fp, timeout, cancelBuf, dirtyBuf, dirtyCount);
    } catch (e) {
      cleanupCancelBuf(cancelBuf);
      throw e;
    }

    // Reset dirty state after successful open.
    this.#dirtyAll = false;
    this.#dirtyPaths = null;
    this.#opened = true;

    // In reuse-from-disk mode, adopt file identity from the cache file.
    // Extract encoded paths as raw bytes — no string decode/re-encode.
    if (fileCount === 0) {
      const layout = dataBufLayout(dataBuf);
      if (layout.fc > 0) {
        this.#encodedPaths = extractEncodedPaths(dataBuf, layout);
        this.#fileCount = layout.fc;
        this.#absoluteFiles = null; // decoded lazily by files getter
      }
    }

    const session = new FileHashCacheSessionImpl(this, dataBuf, root, timeout, cancelBuf);
    this.#activeSession = session;

    // If upToDate, record as "clean" so needsOpen returns false until something changes.
    if (session.status === "upToDate") {
      this.#lastWrittenVersion = ver;
      this.#lastWrittenFingerprint = fp;
    }

    this.#lastCacheStat0 = dataBuf.readDoubleLE(H_CACHE_STAT0);
    this.#lastCacheStat1 = dataBuf.readDoubleLE(H_CACHE_STAT1);

    return session;
  }

  /**
   * Convenience: open, and if not up-to-date, write the cache.
   *
   * If another operation is in progress, waits for it to complete first.
   *
   * @param options Optional write options.
   * @returns The session (already written and disposed if changes were detected).
   */
  public async write(options?: FileHashCacheWriteOptions | null): Promise<FileHashCacheSession> {
    await this.#acquire();
    try {
      const session = await this.#doOpen(options?.signal);
      try {
        if (session.needsWrite) {
          await session.write(options);
        }
      } finally {
        session.close();
      }
      return session;
    } catch (e) {
      this.#release();
      throw e;
    }
  }

  /**
   * Write a brand-new cache file without reading the old one.
   *
   * Uses this instance's cachePath, rootPath, version, fingerprint, and lockTimeoutMs.
   * Pass optional options to set version, fingerprint, rootPath, files, and payload values.
   * These are applied to this cache instance before writing.
   *
   * @param options Optional write options (version, fingerprint, files, payloads, signal, etc.).
   */
  public async overwrite(options?: FileHashCacheWriteOptions | null): Promise<boolean> {
    await this.#acquire();
    try {
      // Auto-close any lingering session.
      this.#activeSession?.close();
      if (options) {
        this._applyOptions(options);
      }
      if (this.#absoluteFiles === null && this.#fileCount === 0) {
        throw new Error("FileHashCache: files must be set before calling overwrite");
      }
      const ok = await doWriteNew(
        this.#cachePath,
        this.#rootPath,
        this.#encodedPaths,
        this.#fileCount,
        this.#version,
        this.#fingerprint,
        options?.lockTimeoutMs ?? this.#lockTimeoutMs,
        options?.userValue0 ?? 0,
        options?.userValue1 ?? 0,
        options?.userValue2 ?? 0,
        options?.userValue3 ?? 0,
        options?.userData ?? null,
        options?.signal
      );
      if (ok) {
        this._recordWriteSuccessFromPath();
      }
      return ok;
    } finally {
      this.#release();
    }
  }

  /**
   * Check whether the cache file is exclusively locked (by this instance or another process).
   * Non-blocking — does not acquire the lock.
   */
  public isLocked(): boolean {
    return this.#mutex !== null || cacheIsLocked(this.#cachePath);
  }

  /**
   * Wait until the cache file is no longer exclusively locked.
   *
   * If this instance holds the lock (active session), waits for the session to
   * close first, then checks the OS-level lock.
   *
   * @param lockTimeoutMs Maximum time to wait in ms. Defaults to this instance's lockTimeoutMs.
   * @param signal Optional AbortSignal to cancel the wait.
   * @returns `true` if unlocked, `false` on timeout or cancellation.
   */
  public async waitUnlocked(lockTimeoutMs?: number, signal?: AbortSignal | null): Promise<boolean> {
    // Fast path: wait for our own mutex first (avoids syscall while we hold the lock).
    if (this.#mutex) {
      await this.#mutex;
    }
    const timeout = lockTimeoutMs ?? this.#lockTimeoutMs;
    if (!signal) {
      return cacheWaitUnlocked(this.#cachePath, timeout, null);
    }
    const cancelBuf = cancelBufFromSignal(signal);
    try {
      return await cacheWaitUnlocked(this.#cachePath, timeout, cancelBuf);
    } finally {
      cleanupCancelBuf(cancelBuf);
    }
  }

  /**
   * Apply options from a FileHashCachePayloads to this cache instance.
   * Called by session.write() and cache.overwrite() before writing.
   * @internal
   */
  public _applyOptions(opts: FileHashCacheWriteOptions): void {
    const rp = opts.rootPath;
    if (rp !== undefined) {
      if (rp === true) {
        // Auto-detect root from files
        const files = opts.files;
        if (files) {
          this.#rootPath = resolveRoot(null, files, true);
        }
      } else {
        this.rootPath = rp;
      }
    }
    if (opts.version !== undefined) {
      this.version = opts.version;
    }
    if (opts.fingerprint !== undefined) {
      this.fingerprint = opts.fingerprint;
    }
    if (opts.files !== undefined) {
      this.files = opts.files;
    }
  }

  /** @internal */
  public get _encodedPaths(): Buffer {
    return this.#encodedPaths;
  }

  /** @internal Called by session after a successful write to record clean state. */
  public _recordWriteSuccess(stat0: number, stat1: number): void {
    this.#opened = true;
    this.#dirtyAll = false;
    this.#dirtyPaths = null;
    this.#lastWrittenVersion = this.#version;
    this.#lastWrittenFingerprint = this.#fingerprint;
    this.#lastCacheStat0 = stat0;
    this.#lastCacheStat1 = stat1;
  }

  /** @internal Record write success, deriving stat hash from the cache file path (cold path: overwrite/lockFailed). */
  public _recordWriteSuccessFromPath(): void {
    const out = _statHashBuf;
    binding.cacheFileStatGet(this.#cachePath, out);
    this._recordWriteSuccess(out[0], out[1]);
  }

  /** @internal Called by session on close/write to clear the active session and release the mutex. */
  public _clearSession(session: FileHashCacheSession): void {
    if (this.#activeSession === session) {
      this.#activeSession = null;
      this.#release();
    }
  }

  // ── Static helpers ──────────────────────────────────────────────────

  /**
   * Check whether another process currently holds an exclusive lock on `cachePath`.
   * Non-blocking — does not acquire the lock.
   */
  public static isLocked(cachePath: string): boolean {
    return cacheIsLocked(pathResolve(cachePath));
  }

  /**
   * Wait until the cache file is no longer exclusively locked by another process.
   *
   * @param cachePath Path to the cache file to wait on.
   * @param lockTimeoutMs Maximum time to wait in ms. `-1` = block until unlocked, `0` = check, `>0` = timeout.
   * @param signal Optional AbortSignal to cancel the wait.
   * @returns `true` if unlocked, `false` on timeout or cancellation.
   */
  public static async waitUnlocked(
    cachePath: string,
    lockTimeoutMs?: number,
    signal?: AbortSignal | null
  ): Promise<boolean> {
    if (!signal) {
      return cacheWaitUnlocked(pathResolve(cachePath), lockTimeoutMs, null);
    }
    const cancelBuf = cancelBufFromSignal(signal);
    try {
      return await cacheWaitUnlocked(pathResolve(cachePath), lockTimeoutMs, cancelBuf);
    } finally {
      cleanupCancelBuf(cancelBuf);
    }
  }
}

// ── FileHashCacheSession ─────────────────────────────────────────────

/**
 * A file hash cache session holding an exclusive OS-level lock.
 *
 * Created by {@link FileHashCache.open}. Exposes what was read from disk
 * as read-only `old*` properties. Pass payload values to {@link write}
 * to override them; omitted fields preserve the old values.
 *
 * The lock is released by {@link write} (after writing), by {@link close},
 * or by the `using` / `await using` disposable pattern.
 *
 * @example
 * ```ts
 * await using session = await cache.open();
 * if (session.needsWrite) {
 *   await session.write({ payload0: 42, payloadData: [manifest] });
 * }
 * ```
 */
export interface FileHashCacheSession {
  /** Cache status after open. */
  readonly status: CacheStatus;

  /** True if the cache holds a lock and the status indicates a write is needed. */
  readonly needsWrite: boolean;

  /** True once {@link close} has been called. */
  readonly disposed: boolean;

  /** The parent {@link FileHashCache} that created this session. */
  readonly cache: FileHashCache;

  // ── Values read from disk ─────────────────────────────────────────

  /** Number of files in the cache (from disk, or from constructor when status is 'missing'). */
  readonly fileCount: number;

  /**
   * File list (absolute paths, using the rootPath that was active when this session was opened).
   * When status is 'missing', reflects the files passed to the constructor. Lazily decoded.
   */
  readonly files: readonly string[];

  /** Cache version (u32) as it was when this session was opened. */
  readonly version: number;

  /** Root path as it was when this session was opened. */
  readonly rootPath: string;

  /** User f64 value (slot 0) from disk (0 when status is 'missing'). */
  readonly userValue0: number;
  /** User f64 value (slot 1) from disk. */
  readonly userValue1: number;
  /** User f64 value (slot 2) from disk. */
  readonly userValue2: number;
  /** User f64 value (slot 3) from disk. */
  readonly userValue3: number;

  /** Opaque binary payloads from disk. Empty array if none. */
  readonly userData: readonly Buffer[];

  // ── Actions ────────────────────────────────────────────────────────

  /**
   * Write the cache file and release the lock.
   *
   * Pass optional options to override version, fingerprint, rootPath, files, and
   * user values. Config overrides (version, fingerprint, rootPath, files) are
   * applied to the parent {@link FileHashCache} before writing. User value fields
   * that are omitted preserve the old values from disk.
   *
   * @param options Optional write options (version, fingerprint, files, user values, signal, etc.).
   * @returns `true` if the write succeeded, `false` on failure.
   */
  write(options?: FileHashCacheWriteOptions | null): Promise<boolean>;

  /**
   * Release the exclusive lock and mark this session as disposed.
   * Safe to call multiple times.
   */
  close(): void;

  /** Disposable — `using session = ...` (synchronous close). */
  [Symbol.dispose](): void;

  /** AsyncDisposable — `await using session = ...`. */
  [Symbol.asyncDispose](): Promise<void>;
}

class FileHashCacheSessionImpl implements FileHashCacheSession {
  public readonly status: CacheStatus;
  public readonly version: number;
  public readonly rootPath: string;
  public readonly userValue0: number;
  public readonly userValue1: number;
  public readonly userValue2: number;
  public readonly userValue3: number;

  readonly #cache: FileHashCache;
  #closed: boolean;
  #written: boolean;
  readonly #dataBuf: Buffer;
  readonly #layout: DataBufLayout;
  readonly #openRootPath: string;
  readonly #lockTimeoutMs: number;
  readonly #cancelBuf: Uint8Array | null;
  #files: readonly string[] | null;
  #userData: readonly Buffer[] | null;

  /** @internal */
  public constructor(
    cache: FileHashCache,
    dataBuf: Buffer,
    openRootPath: string,
    lockTimeoutMs: number,
    cancelBuf: Uint8Array | null
  ) {
    this.#cache = cache;
    this.#closed = false;
    this.#written = false;
    this.#dataBuf = dataBuf;
    this.#openRootPath = openRootPath;
    this.#lockTimeoutMs = lockTimeoutMs;
    this.#cancelBuf = cancelBuf;
    this.#files = null;
    this.#userData = null;

    const layout = dataBufLayout(dataBuf);
    this.#layout = layout;

    this.status = statusFromInt(dataBuf.readUInt32LE(H_STATUS_BYTE));
    this.version = cache.version;
    this.rootPath = openRootPath;
    this.userValue0 = dataBuf.readDoubleLE(H_USER_VALUE0_BYTE);
    this.userValue1 = dataBuf.readDoubleLE(H_USER_VALUE1_BYTE);
    this.userValue2 = dataBuf.readDoubleLE(H_USER_VALUE2_BYTE);
    this.userValue3 = dataBuf.readDoubleLE(H_USER_VALUE3_BYTE);
  }

  public get cache(): FileHashCache {
    return this.#cache;
  }

  public get disposed(): boolean {
    return this.#closed;
  }

  public get needsWrite(): boolean {
    const s = this.status;
    return !this.#closed && s !== "upToDate" && s !== "lockFailed";
  }

  public get fileCount(): number {
    return this.#cache.fileCount;
  }

  public get userData(): readonly Buffer[] {
    let d = this.#userData;
    if (!d) {
      d = readPayloadData(this.#dataBuf, this.#layout);
      this.#userData = d;
    }
    return d;
  }

  public get files(): readonly string[] {
    let f = this.#files;
    if (!f) {
      // Prefer the cache's file list (includes constructor files for missing status)
      f = this.#cache.files ?? [];
      if (f.length === 0 && this.#layout.fc > 0) {
        const rel = decodeFilePaths(this.#dataBuf, this.#layout);
        f = this.#openRootPath ? toAbsolutePaths(this.#openRootPath, rel) : rel;
      }
      this.#files = f;
    }
    return f;
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // If the session needed a write but wasn't written, re-invalidate
    // the cache so the next open() does a full stat-match.
    const s = this.status;
    if (!this.#written && s !== "upToDate" && s !== "lockFailed") {
      this.#cache.invalidateAll();
    }
    this.#cache._clearSession(this);
    cleanupCancelBuf(this.#cancelBuf);
    const buf = this.#dataBuf;
    const h = buf.readInt32LE(H_FILE_HANDLE);
    buf.writeInt32LE(-1, H_FILE_HANDLE);
    if (h !== -1) {
      cacheClose(h);
    }
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  public [Symbol.asyncDispose](): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  public async write(options?: FileHashCacheWriteOptions | null): Promise<boolean> {
    if (this.#closed) {
      throw new Error("FileHashCacheSession: already closed");
    }

    const cache = this.#cache;
    const signal = options?.signal;

    // Apply config overrides to the cache instance first.
    if (options) {
      cache._applyOptions(options);
    }

    const p0 = options?.userValue0 ?? this.userValue0;
    const p1 = options?.userValue1 ?? this.userValue1;
    const p2 = options?.userValue2 ?? this.userValue2;
    const p3 = options?.userValue3 ?? this.userValue3;
    const ud =
      options?.userData !== undefined ? (options.userData ?? null) : this.userData.length > 0 ? this.userData : null;

    if (this.status === "lockFailed") {
      this.close();
      const ok = await doWriteNew(
        cache.cachePath,
        cache.rootPath,
        cache._encodedPaths,
        cache.fileCount,
        cache.version,
        cache.fingerprint,
        options?.lockTimeoutMs ?? this.#lockTimeoutMs,
        p0,
        p1,
        p2,
        p3,
        ud,
        signal
      );
      if (ok) {
        cache._recordWriteSuccessFromPath();
      }
      return ok;
    }

    const dataBuf = this.#dataBuf;

    dataBuf.writeDoubleLE(p0, H_USER_VALUE0_BYTE);
    dataBuf.writeDoubleLE(p1, H_USER_VALUE1_BYTE);
    dataBuf.writeDoubleLE(p2, H_USER_VALUE2_BYTE);
    dataBuf.writeDoubleLE(p3, H_USER_VALUE3_BYTE);

    const fp = cache.fingerprint;
    if (fp) {
      if (!(fp instanceof Uint8Array) || fp.length !== 16) {
        throw new TypeError("FileHashCacheSession: fingerprint must be a Uint8Array of exactly 16 bytes");
      }
      dataBuf.set(fp, H_FINGERPRINT_BYTE);
    } else {
      dataBuf.fill(0, H_FINGERPRINT_BYTE, H_FINGERPRINT_BYTE + 16);
    }

    const writeCancelBuf = signal ? cancelBufFromSignal(signal) : null;
    const cancelBuf = writeCancelBuf ?? this.#cancelBuf;

    const encoded = cache._encodedPaths;
    const fc = cache.fileCount;
    const root = cache.rootPath;
    let result: number;
    try {
      result = await cacheWrite(dataBuf, encoded, fc, cache.cachePath, root, ud, cancelBuf);
      if (result === 0) {
        this.#written = true;
        cache._recordWriteSuccess(dataBuf.readDoubleLE(H_CACHE_STAT0), dataBuf.readDoubleLE(H_CACHE_STAT1));
      }
    } finally {
      cleanupCancelBuf(writeCancelBuf);
      this.close();
    }
    return result === 0;
  }
}
