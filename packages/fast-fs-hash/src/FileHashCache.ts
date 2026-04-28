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
  HEADER_SIZE,
  S_CACHE_PATH,
  S_CACHE_PATH_LEN,
  S_CACHE_STAT0,
  S_CACHE_STAT1,
  S_CANCEL_FLAG,
  S_FILE_COUNT,
  S_FILE_HANDLE,
  S_FINGERPRINT,
  S_LOCK_TIMEOUT,
  S_PAYLOAD0,
  S_PAYLOAD1,
  S_PAYLOAD2,
  S_PAYLOAD3,
  S_STATUS,
  S_VERSION,
  STATE_HEADER_SIZE,
} from "./file-hash-cache-format";
import {
  cacheClose,
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
 * Contains only per-write data (user values, payloads, signal).
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
  /**
   * Opaque binary payloads stored LZ4-compressed inside the cache body.
   * Default: preserves old value (or `null` for overwrite).
   */
  compressedPayloads?: readonly Uint8Array[] | null;
  /**
   * Opaque binary payloads stored raw (uncompressed) in a dedicated section
   * directly after the header — readable without decompressing the body.
   * Default: preserves old value (or `null` for overwrite).
   */
  uncompressedPayloads?: readonly Uint8Array[] | null;
  /** Optional AbortSignal to cancel the hash phase. */
  signal?: AbortSignal | null;
  /** Lock acquisition timeout in ms (overwrite/lockFailed only). `-1` = block forever, `0` = non-blocking. */
  lockTimeoutMs?: number;
}

/**
 * Per-cachePath wait slot, allocated **only on contention**.
 *
 * The map entry is `null` while a holder owns the slot but no waiter has
 * shown up yet — that's the common uncontended case and it skips the slot
 * allocation entirely. The first waiter promotes the entry from `null` to a
 * real `PathMutexSlot` (also constructing the promise + resolver), and any
 * subsequent waiters reuse the same promise.
 *
 * On release, the holder checks the map: if the value is still `null` it
 * just deletes the key; otherwise it deletes + resolves the promise to wake
 * the waiters.
 */
interface PathMutexSlot {
  /** Promise resolved on release. */
  p: Promise<void>;
  /** Resolver for `p`. */
  r: () => void;
}

/**
 * Module-level path mutex map: cachePath → slot of the current holder.
 * Shared across all FileHashCache instances within one V8 isolate so that two
 * instances pointing at the same cache file serialize correctly. Cross-isolate
 * and cross-process serialization is provided by the OS file lock in C++.
 *
 * The value is `null` for the uncontended-holder case (no allocation), and a
 * `PathMutexSlot` once a waiter has promoted it.
 *
 * Lazily created — only allocated once a cache is actually opened.
 */
let _pathMutexMap: Map<string, PathMutexSlot | null> | undefined;

/**
 * Get (or lazily allocate) the wait slot for an entry that may currently be
 * `null` (i.e. uncontended holder, no waiters yet).
 *
 * Promotes the map entry from `null` to a real slot the first time a waiter
 * arrives. The slot's resolver is invoked by the holder's `#release` when
 * the entry is found to be a non-null slot.
 */
function lazySlotPromise(
  map: Map<string, PathMutexSlot | null>,
  key: string,
  current: PathMutexSlot | null
): Promise<void> {
  if (current !== null) {
    return current.p;
  }
  let r!: () => void;
  const p = new Promise<void>((resolve) => {
    r = resolve;
  });
  map.set(key, { p, r });
  return p;
}

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
  /** Resolved cache file path (immutable, cached from stateBuf). */
  readonly #cachePath: string;
  /** Shared JS ↔ C++ communication buffer. Contains config, results, cachePath. */
  readonly #stateBuf: Buffer;

  #rootPath: string;
  #version: number;
  #fingerprint: Uint8Array | null = null;
  #lockTimeoutMs: number;

  /** NUL-separated encoded paths (relative) for C++. Source of truth for file identity. */
  #encodedPaths: Buffer;
  #fileCount: number;
  /** Absolute paths — lazily populated from #encodedPaths + #rootPath. */
  #absoluteFiles: readonly string[] | null;

  /**
   * Dirty-tracking state, merged into a single field:
   *  - `"all"`  — everything dirty (initial state, after `files` reset, etc.)
   *  - `null`   — nothing dirty (clean; written or opened-upToDate)
   *  - `Set`    — specific relative paths dirty; always non-empty by invariant
   *               (we normalize empty sets back to `null`).
   */
  #dirty: Set<string> | "all" | null = "all";

  /** Whether open() has ever been called successfully. */
  #opened: boolean = false;
  /** Version that was last successfully written/opened as upToDate. */
  #lastWrittenVersion: number = -1;
  /** Fingerprint that was last successfully written/opened as upToDate (null = none). */
  #lastWrittenFingerprint: Uint8Array | null = null;

  #activeSession: FileHashCacheSession | null = null;
  /** `true` while THIS instance owns the entry in `_pathMutexMap` for `#cachePath`. */
  #holdsSlot: boolean = false;
  /**
   * `true` while the stateBuf's version/fileCount/lockTimeout/fingerprint slots
   * already match the current config and the last lockTimeoutMs we passed to C++.
   * Setters that mutate these fields flip it to `false`. The next call to
   * `#syncStateBuf` only needs to write when this is `false`.
   */
  #sbInSync: boolean = false;
  /** lockTimeoutMs value last written to stateBuf — separate from #lockTimeoutMs
   *  because callers may pass a deducted timeout that differs from the configured one. */
  #sbLastLockTimeoutMs: number = 0;

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

  /** Resolved cache file path (immutable after construction). */
  public get cachePath(): string {
    return this.#cachePath;
  }

  /** Number of tracked files. */
  public get fileCount(): number {
    return this.#fileCount;
  }

  /**
   * `true` while THIS instance holds the path mutex — i.e. while a session
   * is active (from `open()` until `session.close()`), or while `overwrite()`
   * is in progress. Does NOT reflect other instances holding the same path;
   * use {@link isLocked} for that.
   */
  public get busy(): boolean {
    return this.#holdsSlot;
  }

  /**
   * The session currently returned by the most recent {@link open} (or
   * synthesized on lock failure), or `null` when no session is live.
   *
   * Cleared when the session is closed or when a new `open()`/`overwrite()`
   * supersedes it. A `lockFailed` session stays referenced here until closed
   * — useful for inspecting `status` without re-calling `open()`.
   */
  public get activeSession(): FileHashCacheSession | null {
    return this.#activeSession;
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
    this.#dirty = "all";
  }

  /** User-defined cache version (u32). */
  public get version(): number {
    return this.#version;
  }
  public set version(value: number) {
    const v = value >>> 0;
    if (v !== this.#version) {
      this.#version = v;
      this.#sbInSync = false;
    }
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
    this.#sbInSync = false;
  }

  /** Lock acquisition timeout in ms. `-1` = block forever, `0` = non-blocking, `>0` = timeout. */
  public get lockTimeoutMs(): number {
    return this.#lockTimeoutMs;
  }
  public set lockTimeoutMs(value: number) {
    this.#lockTimeoutMs = value;
    // sbInSync intentionally NOT cleared: lockTimeoutMs is written each call
    // anyway because the value passed to C++ may be deducted by JS-mutex wait time.
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
    this.#dirty = "all";
    this.#sbInSync = false;
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

  // - Dirty marking

  /**
   * Mark specific files as dirty. On the next {@link open}, the C++ stat-match
   * will only stat these files (plus any previously invalidated files), skipping
   * stat for all other entries.
   */
  public invalidate(paths: Iterable<string>): void {
    let dirty = this.#dirty;
    if (dirty === "all") {
      return;
    }
    if (dirty === null) {
      dirty = new Set<string>();
      this.#dirty = dirty;
    }
    const root = this.#rootPath;
    for (const p of paths) {
      const rel = root ? toRelativePath(root, p) : p;
      if (rel) {
        dirty.add(rel);
      }
    }
    if (dirty.size === 0) {
      this.#dirty = null;
    }
  }

  /** Mark all files as dirty. Next {@link open} will stat-match every entry. */
  public invalidateAll(): void {
    this.#dirty = "all";
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
    if (this.#dirty !== null) {
      return true;
    }
    if (this.#version !== this.#lastWrittenVersion) {
      return true;
    }
    const fp = this.#fingerprint;
    const lfp = this.#lastWrittenFingerprint;
    if (fp !== lfp) {
      if (!fp || !lfp) {
        return true;
      }
      // fingerprint is always exactly 16 bytes — fully unrolled, zero allocations
      if (
        fp[0] !== lfp[0] ||
        fp[1] !== lfp[1] ||
        fp[2] !== lfp[2] ||
        fp[3] !== lfp[3] ||
        fp[4] !== lfp[4] ||
        fp[5] !== lfp[5] ||
        fp[6] !== lfp[6] ||
        fp[7] !== lfp[7] ||
        fp[8] !== lfp[8] ||
        fp[9] !== lfp[9] ||
        fp[10] !== lfp[10] ||
        fp[11] !== lfp[11] ||
        fp[12] !== lfp[12] ||
        fp[13] !== lfp[13] ||
        fp[14] !== lfp[14] ||
        fp[15] !== lfp[15]
      ) {
        return true;
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

  /** Check whether the cache file is exclusively locked (by this instance or another process). */
  public isLocked(): boolean {
    return _pathMutexMap?.has(this.#cachePath) === true || cacheIsLocked(this.#cachePath);
  }

  // - Lock / session operations

  /**
   * Open the cache with an exclusive OS-level lock.
   *
   * The JS-side path mutex is acquired first (so worker threads are not tied up
   * waiting on an in-isolate contender). The wait honors `signal` and the
   * configured `lockTimeoutMs`. If the JS wait is cancelled or times out, a
   * `lockFailed` session is returned without ever calling C++. Any time spent
   * waiting on the JS mutex is deducted from the timeout passed to C++.
   *
   * @param signal Optional AbortSignal to cancel the lock wait and/or stat phase.
   * @returns A session holding the lock (or a `lockFailed` session).
   */
  public open(signal?: AbortSignal | null): Promise<FileHashCacheSession> {
    const lockTimeoutMs = this.#lockTimeoutMs;
    // Fast path: #acquire returns a plain number (0) when the slot is free,
    // saving the `await` microtask tick. The sync path never returns -1 —
    // only #acquireSlow can fail the wait. See #acquire for details.
    const acquired = this.#acquire(signal, lockTimeoutMs);
    if (typeof acquired === "number") {
      return this.#doOpen(signal, lockTimeoutMs, acquired);
    }
    return this.#openSlow(signal, lockTimeoutMs, acquired);
  }

  async #openSlow(
    signal: AbortSignal | null | undefined,
    lockTimeoutMs: number,
    acquireP: Promise<number>
  ): Promise<FileHashCacheSession> {
    const elapsed = await acquireP;
    if (elapsed < 0) {
      this.#detachActiveSession();
      return this.#makeLockFailedSession();
    }
    return this.#doOpen(signal, lockTimeoutMs, elapsed);
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
    const sig = options?.signal ?? null;
    const lockTimeoutMs = options?.lockTimeoutMs ?? this.#lockTimeoutMs;
    const acquired = this.#acquire(sig, lockTimeoutMs);
    const elapsed = typeof acquired === "number" ? acquired : await acquired;
    if (elapsed < 0) {
      // JS-mutex wait was cancelled or timed out — mirror C++ lockFailed behavior.
      return false;
    }
    try {
      this.#detachActiveSession();
      if (this.#absoluteFiles === null && this.#fileCount === 0) {
        throw new Error("FileHashCache: files must be set before calling overwrite");
      }
      const sb = this.#stateBuf;
      this.#syncStateBuf(deductTimeout(lockTimeoutMs, elapsed));
      if (options) {
        sb.writeDoubleLE(options.payloadValue0 ?? 0, S_PAYLOAD0);
        sb.writeDoubleLE(options.payloadValue1 ?? 0, S_PAYLOAD1);
        sb.writeDoubleLE(options.payloadValue2 ?? 0, S_PAYLOAD2);
        sb.writeDoubleLE(options.payloadValue3 ?? 0, S_PAYLOAD3);
      } else {
        sb.fill(0, S_PAYLOAD0, S_PAYLOAD3 + 8);
      }
      const cancelCb = setupCancel(sb, sig);
      let result: number;
      try {
        result = await cacheWriteNew(
          sb,
          this.#encodedPaths,
          this.#rootPath,
          options?.compressedPayloads ?? null,
          options?.uncompressedPayloads ?? null
        );
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

  /**
   * Wait until the cache file is no longer exclusively locked.
   *
   * @param lockTimeoutMs Maximum time to wait in ms. Defaults to this instance's lockTimeoutMs.
   * @param signal Optional AbortSignal to cancel the wait.
   * @returns `true` if unlocked, `false` on timeout or cancellation.
   */
  public async waitUnlocked(lockTimeoutMs?: number, signal?: AbortSignal | null): Promise<boolean> {
    const timeout = lockTimeoutMs ?? this.#lockTimeoutMs;
    // Wait for any in-process holder on this path to release (JS mutex) — don't take the slot.
    const waited = this.#waitForSlotFree(signal, timeout);
    const elapsed = typeof waited === "number" ? waited : await waited;
    if (elapsed < 0) {
      return false;
    }
    const remaining = deductTimeout(timeout, elapsed);
    if (timeout > 0 && remaining === 0) {
      // Whole budget consumed by the JS-mutex wait.
      return false;
    }
    const sb = this.#stateBuf;
    const cancelCb = setupCancel(sb, signal);
    try {
      return await cacheWaitUnlocked(sb, remaining);
    } finally {
      teardownCancel(signal, cancelCb);
    }
  }

  // - Static API

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

  // - Internal API (used by FileHashCacheSession)

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
    this.#dirty = null;
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

  /**
   * Write configuration fields into the stateBuf before a C++ call.
   * `lockTimeoutMs` is always passed explicitly by the caller — typically
   * an already-deducted timeout after waiting on the JS mutex.
   *
   * Hot path: when nothing about the cache config changed since the last
   * sync (and the previously-written lockTimeoutMs is still correct), this
   * is a single comparison and an early return — no buffer writes at all.
   */
  #syncStateBuf(lockTimeoutMs: number): void {
    const sb = this.#stateBuf;
    if (this.#sbInSync) {
      // Config slots are already correct. Only re-write lockTimeoutMs if
      // the value we need this call differs from what's there.
      if (this.#sbLastLockTimeoutMs !== lockTimeoutMs) {
        sb.writeInt32LE(lockTimeoutMs, S_LOCK_TIMEOUT);
        this.#sbLastLockTimeoutMs = lockTimeoutMs;
      }
      return;
    }
    const fp = this.#fingerprint;
    sb.writeUInt32LE(this.#version, S_VERSION);
    sb.writeInt32LE(lockTimeoutMs, S_LOCK_TIMEOUT);
    sb.writeUInt32LE(this.#fileCount, S_FILE_COUNT);
    if (fp) {
      sb.set(fp, S_FINGERPRINT);
    } else {
      sb.fill(0, S_FINGERPRINT, S_FINGERPRINT + 16);
    }
    this.#sbLastLockTimeoutMs = lockTimeoutMs;
    this.#sbInSync = true;
  }

  /** Detach (and close) the previously installed session without releasing the JS slot. */
  #detachActiveSession(): void {
    const prev = this.#activeSession;
    if (prev) {
      // Clear before closing so _clearSession's identity check fails and #release() is not called.
      this.#activeSession = null;
      prev.close();
    }
  }

  /**
   * Build a synthetic lockFailed session without calling C++.
   * Used when the JS-mutex wait was cancelled or timed out.
   */
  #makeLockFailedSession(): FileHashCacheSession {
    const sb = this.#stateBuf;
    sb.writeUInt32LE(5, S_STATUS); // 5 = LOCK_FAILED in STATUS_MAP
    sb.writeInt32LE(-1, S_FILE_HANDLE);
    sb.writeDoubleLE(0, S_CACHE_STAT0);
    sb.writeDoubleLE(0, S_CACHE_STAT1);
    const dataBuf = bufferAlloc(HEADER_SIZE);
    const session = new FileHashCacheSession(this, dataBuf, sb, this.#rootPath, this.#lockTimeoutMs);
    this.#activeSession = session;
    return session;
  }

  /**
   * Wait until the path slot is free, **without taking it**.
   *
   * Returns a plain number when the answer is known synchronously:
   *   - `0`  when the slot is already free (no wait happened),
   *   - `-1` when we can fail immediately (already-aborted signal, or
   *          `lockTimeoutMs === 0` while contended).
   * Otherwise returns a Promise resolving to the elapsed wait time in ms (≥ 0)
   * or `-1` on cancellation/timeout.
   *
   * The sync split lets the common "slot free" case avoid an `async` method's
   * microtask + Promise allocation entirely.
   */
  #waitForSlotFree(signal: AbortSignal | null | undefined, lockTimeoutMs: number): number | Promise<number> {
    const map = _pathMutexMap;
    if (map === undefined) {
      return 0;
    }
    const key = this.#cachePath;
    if (!map.has(key)) {
      return 0;
    }
    if (lockTimeoutMs === 0 || signal?.aborted) {
      return -1;
    }
    return this.#waitForSlotFreeSlow(signal, lockTimeoutMs, map, key);
  }

  /**
   * Slow path for {@link #waitForSlotFree}: actually waits for the holder to release.
   *
   * Hot path optimizations:
   *  - No signal AND no finite timeout (the default `lockTimeoutMs = -1`): plain
   *    `await prev` in a tight loop. No race promise, no closures, no setTimeout,
   *    no `performance.now()`, no abort listener. The prev promise is provably
   *    never rejected, so single-arg `.then` is unnecessary too.
   *  - Race path (signal and/or finite timeout): the resolver-shuttle closures
   *    are allocated once per call, the abort listener is attached once, and
   *    only the per-iteration race promise + optional setTimeout are recreated.
   */
  async #waitForSlotFreeSlow(
    signal: AbortSignal | null | undefined,
    lockTimeoutMs: number,
    map: Map<string, PathMutexSlot | null>,
    key: string
  ): Promise<number> {
    // Fastest contended path: no signal AND no finite timeout. Tight `await prev`
    // loop with zero allocations beyond what `await` itself needs.
    // The slot promise is provably never rejected (see #release), so the bare
    // `await` here cannot throw.
    if (!signal && lockTimeoutMs < 0) {
      while (true) {
        const cur = map.get(key);
        if (cur === undefined) {
          return 0;
        }
        await lazySlotPromise(map, key, cur);
      }
    }

    // Race path: with signal and/or finite timeout.
    // Hoist the resolver-shuttle and its handlers so they are allocated exactly
    // once per call, regardless of how many iterations the wait takes.
    const start = performance.now();
    let remaining = lockTimeoutMs; // > 0, or < 0 when paired with a signal
    let resolver: ((ok: boolean) => void) | null = null;
    const onPrev = (): void => {
      const r = resolver;
      if (r !== null) {
        resolver = null;
        r(true);
      }
    };
    const onCancel = (): void => {
      const r = resolver;
      if (r !== null) {
        resolver = null;
        r(false);
      }
    };
    if (signal) {
      signal.addEventListener("abort", onCancel);
    }
    try {
      while (true) {
        // Re-check abort each iteration: it may have fired in the synchronous
        // window between `resolver = null` and the next race-promise setup.
        if (signal?.aborted) {
          return -1;
        }
        // We store either `null` (no waiters yet) or a slot in the map, never
        // undefined — so `get()` returning undefined unambiguously means "absent".
        const cur = map.get(key);
        if (cur === undefined) {
          return performance.now() - start;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ok = await new Promise<boolean>((resolve) => {
          resolver = resolve;
          // slot promise never rejects, so single-arg .then is sufficient.
          lazySlotPromise(map, key, cur ?? null).then(onPrev);
          if (remaining > 0) {
            timer = setTimeout(onCancel, remaining);
          }
        });
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (!ok) {
          return -1;
        }
        // Holder released. Refresh the remaining budget; another waiter
        // may have grabbed the slot in the meantime.
        if (lockTimeoutMs > 0) {
          remaining = lockTimeoutMs - (performance.now() - start);
          if (remaining <= 0) {
            return -1;
          }
        }
      }
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onCancel);
      }
    }
  }

  /**
   * Acquire the module-level path mutex.
   *
   * Fast path: if the slot is free, grab it synchronously and return `0`
   * (so `busy` is true before any await). NOT marked `async` so that the
   * fast path returns a plain number — avoids microtask + Promise wrapping
   * that hurt the "no change" benchmark. The map entry is set to `null`
   * (no allocation) — only contention promotes it to a real `PathMutexSlot`.
   *
   * Slow path: wait for the current holder via {@link #waitForSlotFree}, then
   * grab the slot. Returns the elapsed wait time in ms, or `-1` on cancellation
   * / timeout (no slot was taken).
   *
   * Cancellation and timeout never throw — they return `-1` so the caller can
   * synthesize a `lockFailed` result, mirroring the C++ side.
   */
  #acquire(signal: AbortSignal | null | undefined, lockTimeoutMs: number): number | Promise<number> {
    const key = this.#cachePath;
    const map = _pathMutexMap ?? (_pathMutexMap = new Map());
    // Fast path: free slot, grab synchronously with ZERO allocations.
    // The map value stays `null` until a waiter promotes it to a real slot.
    if (!map.has(key)) {
      map.set(key, null);
      this.#holdsSlot = true;
      return 0;
    }
    // Slow path delegated to an async helper so the fast path stays sync.
    return this.#acquireSlow(signal, lockTimeoutMs, map, key);
  }

  async #acquireSlow(
    signal: AbortSignal | null | undefined,
    lockTimeoutMs: number,
    map: Map<string, PathMutexSlot | null>,
    key: string
  ): Promise<number> {
    let totalElapsed = 0;
    let remaining = lockTimeoutMs;
    while (true) {
      const w = this.#waitForSlotFree(signal, remaining);
      const waited = typeof w === "number" ? w : await w;
      if (waited < 0) {
        return -1;
      }
      totalElapsed += waited;
      if (!map.has(key)) {
        map.set(key, null);
        this.#holdsSlot = true;
        return totalElapsed;
      }
      // Another waiter grabbed it first — keep waiting with the remaining budget.
      // (lockTimeoutMs === 0 is impossible here: #waitForSlotFree returns -1 immediately
      // for that case, so we'd have bailed at the `waited < 0` check above.)
      if (lockTimeoutMs > 0) {
        remaining = lockTimeoutMs - totalElapsed;
        if (remaining <= 0) {
          return -1;
        }
      }
    }
  }

  /** Release the module-level path mutex (no-op if we don't hold it). */
  #release(): void {
    if (!this.#holdsSlot) {
      return;
    }
    this.#holdsSlot = false;
    const map = _pathMutexMap;
    if (map === undefined) {
      return; // unreachable, but cheap
    }
    const key = this.#cachePath;
    const slot = map.get(key);
    map.delete(key);
    // If a waiter promoted the entry to a real slot, resolve its promise.
    if (slot !== undefined && slot !== null) {
      slot.r();
    }
  }

  /**
   * Run the open path on a worker thread, returning the resulting session.
   * Caller has already acquired the JS slot via {@link #acquire}. On throw we
   * release both the OS lock (via cacheClose, which is a no-op if cacheOpen
   * never grabbed it) and the JS slot.
   */
  async #doOpen(
    signal: AbortSignal | null | undefined,
    lockTimeoutMs: number,
    elapsedWaitMs: number
  ): Promise<FileHashCacheSession> {
    let dataBuf: Buffer;
    try {
      if (this.#activeSession !== null) {
        this.#detachActiveSession();
      }
      this.#syncStateBuf(deductTimeout(lockTimeoutMs, elapsedWaitMs));

      // Build dirty paths buffer for C++ watch-mode optimization.
      //   `dirty === "all"`  → dirtyBuf=null           (stat everything)
      //   `dirty === null`   → dirtyBuf=emptyBuf()     (nothing dirty)
      //   `dirty` is a Set   → encoded paths           (stat just these)
      let dirtyBuf: Buffer | null = null;
      let dirtyCount = 0;
      const dirty = this.#dirty;
      if (dirty === null) {
        dirtyBuf = emptyBuf();
      } else if (dirty !== "all") {
        const dirtyArray = Array.from(dirty);
        dirtyBuf = encodeNormalizedPaths(dirtyArray);
        dirtyCount = dirtyArray.length;
      }

      const sb = this.#stateBuf;
      if (signal) {
        // Race path: attach abort listener; tear it down via try/finally so an
        // abort during the C++ work cannot leak the listener.
        const cancelCb = setupCancel(sb, signal);
        try {
          dataBuf = await cacheOpen(sb, this.#encodedPaths, this.#rootPath, dirtyBuf, dirtyCount);
        } finally {
          teardownCancel(signal, cancelCb);
        }
      } else {
        // Hot path: no signal, no listener to tear down. Inline the cancel
        // flag clear (single 4-byte write) and skip the inner try/finally.
        sb.writeUInt32LE(0, S_CANCEL_FLAG);
        dataBuf = await cacheOpen(sb, this.#encodedPaths, this.#rootPath, dirtyBuf, dirtyCount);
      }

      this.#dirty = null;
      this.#opened = true;

      // In reuse-from-disk mode, adopt file identity from the cache file.
      if (this.#fileCount === 0) {
        const diskFc = dataBuf.readUInt32LE(H_FILE_COUNT);
        if (diskFc > 0) {
          this.#encodedPaths = extractEncodedPaths(dataBuf, diskFc);
          this.#fileCount = diskFc;
          this.#absoluteFiles = null;
        }
      }

      const session = new FileHashCacheSession(this, dataBuf, sb, this.#rootPath, this.#lockTimeoutMs);
      this.#activeSession = session;

      if (session.status === "upToDate") {
        this.#lastWrittenVersion = this.#version;
        this.#lastWrittenFingerprint = this.#fingerprint;
      }

      return session;
    } catch (e) {
      // If cacheOpen acquired the OS lock but a later sync step threw, release
      // the held fd. cacheClose is a no-op when fileHandle is still invalid.
      cacheClose(this.#stateBuf);
      this.#release();
      throw e;
    }
  }
}

/**
 * Subtract elapsed JS-mutex wait time from a `lockTimeoutMs` budget.
 * Returns `-1` (forever) and `0` (try-once) unchanged. Otherwise returns
 * `max(0, floor(lockTimeoutMs - elapsed))` as an integer.
 */
function deductTimeout(lockTimeoutMs: number, elapsedMs: number): number {
  if (lockTimeoutMs <= 0) {
    return lockTimeoutMs;
  }
  const remaining = lockTimeoutMs - elapsedMs;
  return remaining > 0 ? Math.floor(remaining) : 0;
}
