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
 * (after writing), by {@link FileHashCacheSession.close}, or by the `using`
 * disposable pattern.
 *
 * @module
 */

import {
  ENTRY_STRIDE,
  H_FILE_COUNT,
  H_FINGERPRINT_BYTE,
  H_PATHS_LEN,
  H_UD_ITEM_COUNT,
  H_UD_PAYLOADS_LEN,
  H_USER_VALUE0_BYTE,
  H_USER_VALUE1_BYTE,
  H_USER_VALUE2_BYTE,
  H_USER_VALUE3_BYTE,
  HEADER_SIZE,
  S_CACHE_PATH,
  S_CACHE_PATH_LEN,
  S_CANCEL_FLAG,
  S_FILE_COUNT,
  S_FILE_HANDLE,
  S_FINGERPRINT,
  S_LOCK_TIMEOUT,
  S_STATUS,
  S_USER_VALUE0,
  S_USER_VALUE1,
  S_USER_VALUE2,
  S_USER_VALUE3,
  S_VERSION,
  STATE_HEADER_SIZE,
} from "./file-hash-cache-format";
import { resolveDir, resolveRoot } from "./file-hash-cache-utils";
import { bufferAlloc } from "./functions";
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

const {
  cacheOpen,
  cacheWrite,
  cacheWriteNew,
  cacheIsLocked,
  cacheWaitUnlocked,
  cacheClose,
  cacheStatHash,
  cacheFireCancel,
} = binding;

let _emptyBuf: Buffer;
let _onceTrue: AddEventListenerOptions;

// ── dataBuf helpers ─────────────────────────────────────────────────

/** Decode relative file paths from a dataBuf. */
function decodeFilePathsFromBuf(buf: Buffer): string[] {
  const fc = buf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
  if (fc <= 0 || pathsLen <= 0) {
    return [];
  }
  const udItemCount = buf.readUInt32LE(H_UD_ITEM_COUNT);
  const pathEndsStart = HEADER_SIZE + fc * ENTRY_STRIDE + udItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
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
 */
function extractEncodedPaths(buf: Buffer, fc: number): Buffer {
  const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
  if (fc <= 0 || pathsLen <= 0) {
    return (_emptyBuf ??= bufferAlloc(0));
  }
  const udItemCount = buf.readUInt32LE(H_UD_ITEM_COUNT);
  const pathEndsStart = HEADER_SIZE + fc * ENTRY_STRIDE + udItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
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
    start = end + 1;
  }
  return result;
}

/** Read user-data payload buffers from a dataBuf. Returns zero-copy slices. */
function readPayloadData(dataBuf: Buffer): readonly Buffer[] {
  const fc = dataBuf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = dataBuf.readUInt32LE(H_PATHS_LEN);
  const udPayloadsLen = dataBuf.readUInt32LE(H_UD_PAYLOADS_LEN);
  const udItemCount = dataBuf.readUInt32LE(H_UD_ITEM_COUNT);
  if (udItemCount <= 0) {
    return [];
  }
  const udDirStart = HEADER_SIZE + fc * ENTRY_STRIDE;
  const pathEndsStart = udDirStart + udItemCount * 4;
  const udPayloadsStart = pathEndsStart + fc * 4 + pathsLen;
  if (udPayloadsStart + udPayloadsLen > dataBuf.length) {
    return [];
  }
  const result: Buffer[] = new Array(udItemCount);
  let prevEnd = 0;
  for (let i = 0; i < udItemCount; i++) {
    const end = dataBuf.readUInt32LE(udDirStart + i * 4);
    const size = end - prevEnd;
    if (size <= 0) {
      result[i] = _emptyBuf ??= bufferAlloc(0);
    } else {
      result[i] = dataBuf.subarray(udPayloadsStart + prevEnd, udPayloadsStart + end);
    }
    prevEnd = end;
  }
  return result;
}

// ── Cancel helpers ──────────────────────────────────────────────────

/** Write cancel flag + attach abort listener. Returns the listener for cleanup (or null). */
function setupCancel(stateBuf: Buffer, signal: AbortSignal | null | undefined): (() => void) | null {
  stateBuf.writeUInt32LE(0, S_CANCEL_FLAG);
  if (!signal) {
    return null;
  }
  if (signal.aborted) {
    stateBuf.writeUInt32LE(1, S_CANCEL_FLAG);
    return null;
  }
  const cb = () => {
    stateBuf.writeUInt32LE(1, S_CANCEL_FLAG);
    cacheFireCancel(stateBuf);
  };
  signal.addEventListener("abort", cb, (_onceTrue ??= { once: true }));
  return cb;
}

/** Remove abort listener after an async op completes. */
function teardownCancel(signal: AbortSignal | null | undefined, cb: (() => void) | null): void {
  if (cb && signal) {
    signal.removeEventListener("abort", cb);
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
 * using session = await cache.open();
 * if (session.status !== "upToDate") {
 *   await session.write();
 * }
 *
 * // Watch mode: update files, re-open
 * cache.files = newFileList;
 * cache.invalidate(["src/foo.ts"]);
 * using session2 = await cache.open();
 * ```
 */
export class FileHashCache {
  #rootPath: string;
  #version: number;
  #fingerprint: Uint8Array | null;
  #lockTimeoutMs: number;

  /** NUL-separated encoded paths (relative) for C++. Source of truth for file identity. */
  #encodedPaths: Buffer;
  #fileCount: number;
  /** Absolute paths — lazily populated from #encodedPaths + #rootPath. */
  #absoluteFiles: readonly string[] | null;

  /** Shared JS ↔ C++ communication buffer. Contains config, results, cachePath. */
  readonly #stateBuf: Buffer;
  /** Resolved cache file path (immutable, cached from stateBuf). */
  readonly #cachePath: string;

  #activeSession: FileHashCacheSession | null = null;
  #dirtyAll: boolean = true;
  #dirtyPaths: Set<string> | null = null;

  /** Whether open() has ever been called successfully. */
  #opened: boolean = false;
  /** Version that was last successfully written/opened as upToDate. */
  #lastWrittenVersion: number = -1;
  /** Fingerprint that was last successfully written/opened as upToDate (null = none). */
  #lastWrittenFingerprint: Uint8Array | null = null;

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

    let resolvedCachePath: string;
    if (files) {
      const root = resolveRoot(null, files, rootPath);
      this.#rootPath = root;
      resolvedCachePath = pathResolve(root, cachePath);
      const normalized = normalizeFilePaths(root, files);
      this.#absoluteFiles = toAbsolutePaths(root, normalized);
      this.#encodedPaths = encodeNormalizedPaths(normalized);
      this.#fileCount = normalized.length;
    } else {
      if (!rootPath) {
        this.#rootPath = "";
        resolvedCachePath = pathResolve(cachePath);
      } else {
        const root = resolveDir(rootPath);
        this.#rootPath = root;
        resolvedCachePath = pathResolve(root, cachePath);
      }
      this.#absoluteFiles = null;
      this.#encodedPaths = _emptyBuf ??= bufferAlloc(0);
      this.#fileCount = 0;
    }

    // Allocate stateBuf: 96-byte header + null-terminated cachePath
    const pathBytes = Buffer.byteLength(resolvedCachePath, "utf8");
    const sb = bufferAlloc(STATE_HEADER_SIZE + pathBytes + 1);
    sb.writeInt32LE(-1, S_FILE_HANDLE);
    sb.writeUInt32LE(pathBytes, S_CACHE_PATH_LEN);
    sb.write(resolvedCachePath, S_CACHE_PATH, pathBytes, "utf8");
    this.#stateBuf = sb;
    this.#cachePath = resolvedCachePath;
  }

  /**
   * `true` while a session is active (from `open()` until `session.close()`).
   * New calls to `open()` or `overwrite()` will wait for the current session to close.
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
    this.#absoluteFiles = null;
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
      this.#encodedPaths = _emptyBuf ??= bufferAlloc(0);
      this.#fileCount = 0;
    }
    this.#dirtyAll = true;
    this.#dirtyPaths = null;
  }

  /**
   * Mark specific files as dirty. On the next {@link open}, the C++ stat-match
   * will only stat these files (plus any previously invalidated files), skipping
   * stat for all other entries.
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

  /** Mark all files as dirty. Next {@link open} will stat-match every entry. */
  public invalidateAll(): void {
    this.#dirtyAll = true;
    this.#dirtyPaths = null;
  }

  /**
   * Whether the cache should be opened (or re-opened).
   *
   * Returns `true` when the cache has never been opened, files/version/fingerprint
   * changed, or invalidateAll/invalidate was called.
   */
  public get needsOpen(): boolean {
    if (!this.#opened) {
      return true;
    }
    const dp = this.#dirtyPaths;
    if (this.#dirtyAll || (dp !== null && dp.size > 0)) {
      return true;
    }
    if (this.#version !== this.#lastWrittenVersion) {
      return true;
    }
    const fp = this.#fingerprint;
    const lfp = this.#lastWrittenFingerprint;
    if (fp !== lfp) {
      if (!fp || !lfp || fp.length !== lfp.length) {
        return true;
      }
      for (let i = 0; i < fp.length; i++) {
        if (fp[i] !== lfp[i]) {
          return true;
        }
      }
    }
    return false;
  }

  /** Check whether the cache file on disk may have changed since the last open. */
  public checkCacheFile(): boolean {
    if (!this.#opened) {
      return true;
    }
    return cacheStatHash(this.#stateBuf);
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

  /** Write config fields into the stateBuf before a C++ call. */
  #syncStateBuf(): void {
    const sb = this.#stateBuf;
    const ver = this.#version;
    const timeout = this.#lockTimeoutMs;
    const fp = this.#fingerprint;
    const fc = this.#fileCount;

    sb.writeUInt32LE(ver, S_VERSION);
    sb.writeInt32LE(timeout, S_LOCK_TIMEOUT);
    sb.writeUInt32LE(fc, S_FILE_COUNT);

    if (fp) {
      if (!(fp instanceof Uint8Array) || fp.length !== 16) {
        throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
      }
      sb.set(fp, S_FINGERPRINT);
    } else {
      sb.fill(0, S_FINGERPRINT, S_FINGERPRINT + 16);
    }
  }

  /** Write user values into stateBuf (for writeNew/overwrite). */
  #syncUserValues(uv0: number, uv1: number, uv2: number, uv3: number): void {
    const sb = this.#stateBuf;
    sb.writeDoubleLE(uv0, S_USER_VALUE0);
    sb.writeDoubleLE(uv1, S_USER_VALUE1);
    sb.writeDoubleLE(uv2, S_USER_VALUE2);
    sb.writeDoubleLE(uv3, S_USER_VALUE3);
  }

  /**
   * Open the cache with an exclusive OS-level lock.
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
    this.#activeSession?.close();
    this.#syncStateBuf();

    // Build dirty paths buffer for C++ watch-mode optimization.
    let dirtyBuf: Buffer | null = null;
    let dirtyCount = 0;
    if (!this.#dirtyAll) {
      const dp = this.#dirtyPaths;
      if (dp && dp.size > 0) {
        const dirtyArray = Array.from(dp);
        dirtyBuf = encodeNormalizedPaths(dirtyArray);
        dirtyCount = dirtyArray.length;
      } else if (!dp) {
        dirtyBuf = _emptyBuf ??= bufferAlloc(0);
      }
    }

    const sb = this.#stateBuf;
    const cancelCb = setupCancel(sb, signal);
    let dataBuf: Buffer;
    try {
      dataBuf = await cacheOpen(sb, this.#encodedPaths, this.#rootPath, dirtyBuf, dirtyCount);
    } finally {
      teardownCancel(signal, cancelCb);
    }

    this.#dirtyAll = false;
    this.#dirtyPaths = null;
    this.#opened = true;

    // In reuse-from-disk mode, adopt file identity from the cache file.
    const fileCount = this.#fileCount;
    if (fileCount === 0) {
      const diskFc = dataBuf.readUInt32LE(H_FILE_COUNT);
      if (diskFc > 0) {
        this.#encodedPaths = extractEncodedPaths(dataBuf, diskFc);
        this.#fileCount = diskFc;
        this.#absoluteFiles = null;
      }
    }

    const ver = this.#version;
    const fp = this.#fingerprint;
    const session = new FileHashCacheSession(this, dataBuf, sb, this.#rootPath, this.#lockTimeoutMs);
    this.#activeSession = session;

    if (session.status === "upToDate") {
      this.#lastWrittenVersion = ver;
      this.#lastWrittenFingerprint = fp;
    }

    return session;
  }

  /**
   * Write a brand-new cache file without reading the old one.
   *
   * @param options Optional write options (version, fingerprint, files, payloads, signal, etc.).
   */
  public async overwrite(options?: FileHashCacheWriteOptions | null): Promise<boolean> {
    await this.#acquire();
    try {
      this.#activeSession?.close();
      if (options) {
        this._applyOptions(options);
      }
      const fc = this.#fileCount;
      if (this.#absoluteFiles === null && fc === 0) {
        throw new Error("FileHashCache: files must be set before calling overwrite");
      }
      this.#syncStateBuf();
      this.#syncUserValues(
        options?.userValue0 ?? 0,
        options?.userValue1 ?? 0,
        options?.userValue2 ?? 0,
        options?.userValue3 ?? 0
      );
      const sb = this.#stateBuf;
      if (options?.lockTimeoutMs !== undefined) {
        sb.writeInt32LE(options.lockTimeoutMs, S_LOCK_TIMEOUT);
      }
      const sig = options?.signal;
      const ud = options?.userData ?? null;
      const cancelCb = setupCancel(sb, sig);
      let result: number;
      try {
        result = await cacheWriteNew(sb, this.#encodedPaths, this.#rootPath, ud);
      } finally {
        teardownCancel(sig, cancelCb);
      }
      if (result === 0) {
        this._recordWriteSuccess();
      }
      return result === 0;
    } finally {
      this.#release();
    }
  }

  /** Check whether the cache file is exclusively locked (by this instance or another process). */
  public isLocked(): boolean {
    return this.#mutex !== null || cacheIsLocked(this.#cachePath);
  }

  /**
   * Wait until the cache file is no longer exclusively locked.
   *
   * @param lockTimeoutMs Maximum time to wait in ms. Defaults to this instance's lockTimeoutMs.
   * @param signal Optional AbortSignal to cancel the wait.
   * @returns `true` if unlocked, `false` on timeout or cancellation.
   */
  public async waitUnlocked(lockTimeoutMs?: number, signal?: AbortSignal | null): Promise<boolean> {
    if (this.#mutex) {
      await this.#mutex;
    }
    const timeout = lockTimeoutMs ?? this.#lockTimeoutMs;
    const sb = this.#stateBuf;
    const cancelCb = setupCancel(sb, signal);
    try {
      return await cacheWaitUnlocked(sb, timeout);
    } finally {
      teardownCancel(signal, cancelCb);
    }
  }

  /** @internal Apply options to this cache instance. */
  public _applyOptions(opts: FileHashCacheWriteOptions): void {
    const rp = opts.rootPath;
    if (rp !== undefined) {
      if (rp === true) {
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

  /** @internal */
  public get _stateBuf(): Buffer {
    return this.#stateBuf;
  }

  /** @internal Called by session after a successful write to record clean state. */
  public _recordWriteSuccess(): void {
    this.#opened = true;
    this.#dirtyAll = false;
    this.#dirtyPaths = null;
    this.#lastWrittenVersion = this.#version;
    this.#lastWrittenFingerprint = this.#fingerprint;
  }

  /** @internal Called by session on close to clear the active session and release the mutex. */
  public _clearSession(session: FileHashCacheSession): void {
    if (this.#activeSession === session) {
      this.#activeSession = null;
      this.#release();
    }
  }

  /** Check whether another process currently holds an exclusive lock on `cachePath`. */
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
    // Static version needs a temporary stateBuf for cachePath + cancel flag
    const resolved = pathResolve(cachePath);
    const pathBytes = Buffer.byteLength(resolved, "utf8");
    const sb = bufferAlloc(STATE_HEADER_SIZE + pathBytes + 1);
    sb.writeInt32LE(-1, S_FILE_HANDLE);
    sb.writeUInt32LE(pathBytes, S_CACHE_PATH_LEN);
    sb.write(resolved, S_CACHE_PATH, pathBytes, "utf8");
    const cancelCb = setupCancel(sb, signal);
    try {
      return await cacheWaitUnlocked(sb, lockTimeoutMs);
    } finally {
      teardownCancel(signal, cancelCb);
    }
  }
}

// ── FileHashCacheSession ─────────────────────────────────────────────

/**
 * A file hash cache session holding an exclusive OS-level lock.
 *
 * Created by {@link FileHashCache.open}. Exposes what was read from disk
 * as read-only properties. Pass payload values to {@link write}
 * to override them; omitted fields preserve the old values.
 *
 * The lock is released by {@link write} (after writing), by {@link close},
 * or by the `using` disposable pattern.
 */
export class FileHashCacheSession {
  /** Cache status determined at open time. */
  public readonly status: CacheStatus;

  /** Cache version (u32) that was active when this session was opened. */
  public readonly version: number;

  /** Root path that was active when this session was opened. */
  public readonly rootPath: string;

  /** User f64 value (slot 0) read from disk. `0` when status is `'missing'`. */
  public readonly userValue0: number;

  /** User f64 value (slot 1) read from disk. `0` when status is `'missing'`. */
  public readonly userValue1: number;

  /** User f64 value (slot 2) read from disk. `0` when status is `'missing'`. */
  public readonly userValue2: number;

  /** User f64 value (slot 3) read from disk. `0` when status is `'missing'`. */
  public readonly userValue3: number;

  readonly #cache: FileHashCache;
  /** 0 = open, 1 = writing, 2 = closed */
  #state: number;
  readonly #dataBuf: Buffer;
  readonly #stateBuf: Buffer;
  readonly #lockTimeoutMs: number;
  #files: readonly string[] | null;
  #userData: readonly Buffer[] | null;

  /** @internal */
  public constructor(
    cache: FileHashCache,
    dataBuf: Buffer,
    stateBuf: Buffer,
    openRootPath: string,
    lockTimeoutMs: number
  ) {
    this.#cache = cache;
    this.#state = 0;
    this.#dataBuf = dataBuf;
    this.#stateBuf = stateBuf;
    this.#lockTimeoutMs = lockTimeoutMs;
    this.#files = null;
    this.#userData = null;

    this.status = STATUS_MAP[stateBuf.readUInt32LE(S_STATUS)] ?? "missing";
    this.version = cache.version;
    this.rootPath = openRootPath;
    this.userValue0 = dataBuf.readDoubleLE(H_USER_VALUE0_BYTE);
    this.userValue1 = dataBuf.readDoubleLE(H_USER_VALUE1_BYTE);
    this.userValue2 = dataBuf.readDoubleLE(H_USER_VALUE2_BYTE);
    this.userValue3 = dataBuf.readDoubleLE(H_USER_VALUE3_BYTE);
  }

  /** The parent {@link FileHashCache} that created this session. */
  public get cache(): FileHashCache {
    return this.#cache;
  }

  /** `true` once {@link close} or {@link write} has released the lock. */
  public get disposed(): boolean {
    return this.#state >= 2;
  }

  /** `true` while {@link write} is in progress (async write running on the thread pool). */
  public get busy(): boolean {
    return this.#state === 1;
  }

  /** `true` if the session holds the lock and the status indicates a write is needed. */
  public get needsWrite(): boolean {
    return this.#state === 0 && this.status !== "upToDate" && this.status !== "lockFailed";
  }

  /** Number of tracked files (from disk, or from the constructor when status is `'missing'`). */
  public get fileCount(): number {
    return this.#cache.fileCount;
  }

  /** Opaque binary payloads read from disk. Empty array if none. Lazily decoded, zero-copy. */
  public get userData(): readonly Buffer[] {
    let d = this.#userData;
    if (!d) {
      d = readPayloadData(this.#dataBuf);
      this.#userData = d;
    }
    return d;
  }

  /**
   * File list as absolute paths. When status is `'missing'`, reflects the files
   * passed to the constructor. Lazily decoded from the on-disk representation.
   */
  public get files(): readonly string[] {
    let f = this.#files;
    if (!f) {
      f = this.#cache.files ?? [];
      if (f.length === 0) {
        const rel = decodeFilePathsFromBuf(this.#dataBuf);
        if (rel.length > 0) {
          const rp = this.rootPath;
          f = rp ? toAbsolutePaths(rp, rel) : rel;
        }
      }
      this.#files = f;
    }
    return f;
  }

  /** Release the exclusive lock and mark this session as disposed. Safe to call multiple times. */
  public close(): void {
    if (this.#state >= 2) {
      return;
    }
    // Re-invalidate if session was closed without a successful write.
    // State 0 = never written. State 1 = write was attempted (success already called _recordWriteSuccess).
    const needsInvalidate = this.#state === 0;
    this.#state = 2;
    const cache = this.#cache;
    if (needsInvalidate) {
      const s = this.status;
      if (s !== "upToDate" && s !== "lockFailed") {
        cache.invalidateAll();
      }
    }
    cache._clearSession(this);
    cacheClose(this.#stateBuf);
  }

  /** Disposable — `using session = await cache.open()` calls {@link close}. */
  public [Symbol.dispose](): void {
    this.close();
  }

  /**
   * Write the cache file and release the lock.
   *
   * Can only be called once per session. After write completes (success or failure),
   * the session is disposed and the lock is released.
   *
   * Omitted user-value fields preserve the values read from disk.
   * Config overrides (version, fingerprint, rootPath, files) are applied
   * to the parent {@link FileHashCache} before writing.
   *
   * @param options Optional write options.
   * @returns `true` if the write succeeded, `false` on lock failure.
   */
  public async write(options?: FileHashCacheWriteOptions | null): Promise<boolean> {
    if (this.#state !== 0) {
      throw new Error("FileHashCacheSession: " + (this.#state >= 2 ? "already closed" : "write already in progress"));
    }
    this.#state = 1;

    const cache = this.#cache;
    const signal = options?.signal;

    if (options) {
      cache._applyOptions(options);
    }

    const p0 = options?.userValue0 ?? this.userValue0;
    const p1 = options?.userValue1 ?? this.userValue1;
    const p2 = options?.userValue2 ?? this.userValue2;
    const p3 = options?.userValue3 ?? this.userValue3;
    const ud =
      options?.userData !== undefined ? (options.userData ?? null) : this.userData.length > 0 ? this.userData : null;
    const encoded = cache._encodedPaths;
    const fc = cache.fileCount;
    const root = cache.rootPath;
    const sb = this.#stateBuf;
    const fp = cache.fingerprint;

    if (this.status === "lockFailed") {
      this.close();
      sb.writeUInt32LE(cache.version, S_VERSION);
      sb.writeInt32LE(options?.lockTimeoutMs ?? this.#lockTimeoutMs, S_LOCK_TIMEOUT);
      sb.writeUInt32LE(fc, S_FILE_COUNT);
      if (fp) {
        if (!(fp instanceof Uint8Array) || fp.length !== 16) {
          throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
        }
        sb.set(fp, S_FINGERPRINT);
      } else {
        sb.fill(0, S_FINGERPRINT, S_FINGERPRINT + 16);
      }
      sb.writeDoubleLE(p0, S_USER_VALUE0);
      sb.writeDoubleLE(p1, S_USER_VALUE1);
      sb.writeDoubleLE(p2, S_USER_VALUE2);
      sb.writeDoubleLE(p3, S_USER_VALUE3);

      const cancelCb = setupCancel(sb, signal);
      let result: number;
      try {
        result = await cacheWriteNew(sb, encoded, root, ud);
      } finally {
        teardownCancel(signal, cancelCb);
      }
      if (result === 0) {
        cache._recordWriteSuccess();
      }
      return result === 0;
    }

    const dataBuf = this.#dataBuf;

    dataBuf.writeDoubleLE(p0, H_USER_VALUE0_BYTE);
    dataBuf.writeDoubleLE(p1, H_USER_VALUE1_BYTE);
    dataBuf.writeDoubleLE(p2, H_USER_VALUE2_BYTE);
    dataBuf.writeDoubleLE(p3, H_USER_VALUE3_BYTE);

    if (fp) {
      if (!(fp instanceof Uint8Array) || fp.length !== 16) {
        throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
      }
      dataBuf.set(fp, H_FINGERPRINT_BYTE);
    } else {
      dataBuf.fill(0, H_FINGERPRINT_BYTE, H_FINGERPRINT_BYTE + 16);
    }

    sb.writeUInt32LE(fc, S_FILE_COUNT);
    const cancelCb = setupCancel(sb, signal);
    try {
      const result = await cacheWrite(sb, dataBuf, encoded, root, ud);
      if (result === 0) {
        cache._recordWriteSuccess();
      }
      return result === 0;
    } finally {
      teardownCancel(signal, cancelCb);
      this.close();
    }
  }
}
