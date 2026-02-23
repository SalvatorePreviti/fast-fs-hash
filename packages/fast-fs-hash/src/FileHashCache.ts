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
  S_PAYLOAD0,
  S_PAYLOAD1,
  S_PAYLOAD2,
  S_PAYLOAD3,
  S_VERSION,
  STATE_HEADER_SIZE,
} from "./file-hash-cache-format";
import {
  cacheIsLocked,
  cacheOpen,
  cacheStatHash,
  cacheWaitUnlocked,
  cacheWriteNew,
  decodeEncodedPaths,
  emptyBuf,
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
 * Options for {@link FileHashCache.configure} — sets cache configuration.
 * All fields are optional. Omitted fields keep the current value.
 */
export interface FileHashCacheConfigOptions {
  /** Override cache version (u32). */
  version?: number;
  /** Override fingerprint (16 bytes, or `null` to clear). */
  fingerprint?: Uint8Array | null;
  /** Override root path. Pass `true` to auto-detect from files. Pass `null` to clear. */
  rootPath?: string | true | null;
  /** Override file list. Pass `null` to clear. */
  files?: Iterable<string> | null;
  /** Override lock acquisition timeout in ms. */
  lockTimeoutMs?: number;
}

/**
 * Options for {@link FileHashCacheSession.write} and {@link FileHashCache.overwrite}.
 *
 * Contains only per-write data (user values, payloadData, signal).
 * To change files, version, fingerprint, or rootPath, use {@link FileHashCache.configure}
 * or the corresponding setters before calling write.
 */
export interface FileHashCacheWriteOptions {
  /** Payload f64 value (slot 0). Default: preserves old value (or `0` for overwrite). */
  payloadValue0?: number;
  /** Payload f64 value (slot 1). Default: preserves old value (or `0` for overwrite). */
  payloadValue1?: number;
  /** Payload f64 value (slot 2). Default: preserves old value (or `0` for overwrite). */
  payloadValue2?: number;
  /** Payload f64 value (slot 3). Default: preserves old value (or `0` for overwrite). */
  payloadValue3?: number;
  /** Opaque binary payloads stored alongside the cache. Default: preserves old value (or `null` for overwrite). */
  payloadData?: readonly Uint8Array[] | null;
  /** Optional AbortSignal to cancel the hash phase. */
  signal?: AbortSignal | null;
  /** Lock acquisition timeout in ms (overwrite/lockFailed only). `-1` = block forever, `0` = non-blocking. */
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
  #fingerprint: Uint8Array | null = null;
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
    this.#lockTimeoutMs = lockTimeoutMs ?? -1;
    // Use setter for validation
    this.fingerprint = fingerprint ?? null;

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
      this.#encodedPaths = emptyBuf();
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

  /**
   * Root path used for file path resolution.
   * Set to `null` or `""` to auto-detect from files on next open.
   */
  public get rootPath(): string {
    return this.#rootPath;
  }
  public set rootPath(value: string | null) {
    const root = value ? resolveDir(value) : "";
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
    this.#version = value >>> 0;
  }

  /** 16-byte fingerprint for fast cache rejection. Must be exactly 16 bytes or `null`. */
  public get fingerprint(): Uint8Array | null {
    return this.#fingerprint;
  }
  public set fingerprint(value: Uint8Array | null) {
    if (value != null) {
      if (!(value instanceof Uint8Array) || value.length !== 16) {
        throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
      }
    }
    this.#fingerprint = value ?? null;
  }

  /** Lock acquisition timeout in ms. `-1` = block forever, `0` = non-blocking, `>0` = timeout. */
  public get lockTimeoutMs(): number {
    return this.#lockTimeoutMs;
  }
  public set lockTimeoutMs(value: number) {
    this.#lockTimeoutMs = value;
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
      this.#encodedPaths = emptyBuf();
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
      sb.set(fp, S_FINGERPRINT);
    } else {
      sb.fill(0, S_FINGERPRINT, S_FINGERPRINT + 16);
    }
  }

  /** Write payload values into stateBuf (for writeNew/overwrite). */
  #syncPayloads(uv0: number, uv1: number, uv2: number, uv3: number): void {
    const sb = this.#stateBuf;
    sb.writeDoubleLE(uv0, S_PAYLOAD0);
    sb.writeDoubleLE(uv1, S_PAYLOAD1);
    sb.writeDoubleLE(uv2, S_PAYLOAD2);
    sb.writeDoubleLE(uv3, S_PAYLOAD3);
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
        dirtyBuf = emptyBuf();
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
   * Uses the current cache configuration (files, version, fingerprint, rootPath).
   * Call {@link configure} or set properties before calling this method.
   *
   * @param options Optional write options (payload values, payload data, signal, lockTimeoutMs).
   */
  public async overwrite(options?: FileHashCacheWriteOptions | null): Promise<boolean> {
    await this.#acquire();
    try {
      this.#activeSession?.close();
      const fc = this.#fileCount;
      if (this.#absoluteFiles === null && fc === 0) {
        throw new Error("FileHashCache: files must be set before calling overwrite");
      }
      this.#syncStateBuf();
      this.#syncPayloads(
        options?.payloadValue0 ?? 0,
        options?.payloadValue1 ?? 0,
        options?.payloadValue2 ?? 0,
        options?.payloadValue3 ?? 0
      );
      const sb = this.#stateBuf;
      if (options?.lockTimeoutMs !== undefined) {
        sb.writeInt32LE(options.lockTimeoutMs, S_LOCK_TIMEOUT);
      }
      const sig = options?.signal;
      const ud = options?.payloadData ?? null;
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

  /**
   * Set multiple configuration options at once.
   *
   * Equivalent to setting individual properties (version, fingerprint, files, rootPath, lockTimeoutMs).
   * Can be called between `open()` and `write()` to change what gets written.
   *
   * @param opts Configuration options. Omitted fields keep the current value.
   */
  public configure(opts: FileHashCacheConfigOptions): void {
    const rp = opts.rootPath;
    if (rp !== undefined) {
      if (rp === true) {
        const files = opts.files;
        if (files) {
          this.rootPath = resolveRoot(null, files, true);
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
    if (opts.lockTimeoutMs !== undefined) {
      this.lockTimeoutMs = opts.lockTimeoutMs;
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
