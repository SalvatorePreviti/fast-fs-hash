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

import { FileHashCacheSession } from "./FileHashCacheSession";
import {
  H_FILE_COUNT,
  S_CACHE_PATH,
  S_CACHE_PATH_LEN,
  S_FILE_COUNT,
  S_FILE_HANDLE,
  S_FINGERPRINT,
  S_LOCK_TIMEOUT,
  S_USER_VALUE0,
  S_USER_VALUE1,
  S_USER_VALUE2,
  S_USER_VALUE3,
  S_VERSION,
  STATE_HEADER_SIZE,
} from "./file-hash-cache-format";
import {
  _emptyBuf,
  cacheIsLocked,
  cacheOpen,
  cacheStatHash,
  cacheWaitUnlocked,
  cacheWriteNew,
  decodeEncodedPaths,
  extractEncodedPaths,
  setupCancel,
  teardownCancel,
  toAbsolutePaths,
} from "./file-hash-cache-internal";
import { resolveDir, resolveRoot } from "./file-hash-cache-utils";
import { bufferAlloc } from "./functions";
import { encodeNormalizedPaths, normalizeFilePaths, pathResolve, toRelativePath } from "./utils";

export type { FileHashCacheEntries, FileHashCacheEntry } from "./FileHashCacheEntries";
export { FileHashCacheSession } from "./FileHashCacheSession";

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
      this.#encodedPaths = _emptyBuf ?? bufferAlloc(0);
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
      this.#encodedPaths = _emptyBuf ?? bufferAlloc(0);
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
        dirtyBuf = _emptyBuf ?? bufferAlloc(0);
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
