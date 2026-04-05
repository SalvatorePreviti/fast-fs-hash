/**
 * FileHashCacheSession — exclusive-lock session for a FileHashCache.
 *
 * Created by {@link FileHashCache.open}. Exposes what was read from disk
 * as read-only properties and provides {@link write} to persist changes.
 * The lock is released by {@link write}, {@link close}, or `using`.
 *
 * @module
 */

import type { CacheStatus, FileHashCache, FileHashCacheWriteOptions } from "./FileHashCache";
import { FileHashCacheEntries } from "./FileHashCacheEntries";
import {
  H_FINGERPRINT_BYTE,
  H_USER_VALUE0_BYTE,
  H_USER_VALUE1_BYTE,
  H_USER_VALUE2_BYTE,
  H_USER_VALUE3_BYTE,
  S_CANCEL_FLAG,
  S_FILE_COUNT,
  S_FINGERPRINT,
  S_FLAGS,
  S_LOCK_TIMEOUT,
  S_STATUS,
  S_USER_VALUE0,
  S_USER_VALUE1,
  S_USER_VALUE2,
  S_USER_VALUE3,
  S_VERSION,
} from "./file-hash-cache-format";
import {
  cacheClose,
  cacheWrite,
  cacheWriteNew,
  decodeFilePathsFromBuf,
  readPayloadData,
  STATUS_MAP,
  setupCancel,
  teardownCancel,
  toAbsolutePaths,
} from "./file-hash-cache-internal";
import { encodeNormalizedPaths, normalizeFilePaths } from "./utils";

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
  #resolvedEntries: FileHashCacheEntries | null;

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
    this.#resolvedEntries = null;

    this.status = (STATUS_MAP[stateBuf.readUInt32LE(S_STATUS)] as CacheStatus) ?? "missing";
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

  /** `true` while {@link resolve} or {@link write} is in progress. */
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

  /**
   * Release the exclusive lock and mark this session as disposed. Safe to call multiple times.
   * If called while {@link resolve} or {@link write} is in progress, cancels the operation
   * via the cancel flag and closes immediately.
   */
  public close(): void {
    if (this.#state >= 2) {
      return;
    }
    const wasBusy = this.#state === 1;
    const needsInvalidate = this.#state === 0;
    this.#state = 2;
    if (wasBusy) {
      // Cancel in-progress async operation so C++ exits early
      this.#stateBuf.writeUInt32LE(1, S_CANCEL_FLAG);
    }
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
   * Resolve all file entries — complete stat + hash for every tracked file.
   *
   * After `open()`, some entries may be only partially resolved (CacheOpen exits
   * early on the first change). This method completes stat + hash for ALL files,
   * then returns a {@link FileHashCacheEntries} snapshot with per-file metadata.
   *
   * Can be called before `write()`. The resolved data is reused by write.
   * Cannot be called after `write()` or `close()`.
   * Returns cached result on subsequent calls.
   *
   * @param signal Optional AbortSignal to cancel the resolve phase.
   * @returns Readonly snapshot of all file entries.
   */
  public async resolve(signal?: AbortSignal | null): Promise<FileHashCacheEntries> {
    if (this.#resolvedEntries) {
      return this.#resolvedEntries;
    }
    if (this.#state !== 0) {
      throw new Error("FileHashCacheSession: " + (this.#state >= 2 ? "already closed" : "operation in progress"));
    }
    this.#state = 1;
    const cache = this.#cache;
    const sb = this.#stateBuf;
    const dataBuf = this.#dataBuf;
    sb.writeUInt32LE(cache.fileCount, S_FILE_COUNT);
    sb.writeUInt32LE(1, S_FLAGS); // resolveOnly
    const cancelCb = setupCancel(sb, signal);
    try {
      await cacheWrite(sb, dataBuf, cache._encodedPaths, cache.rootPath, null);
    } finally {
      teardownCancel(signal, cancelCb);
      sb.writeUInt32LE(0, S_FLAGS);
      if (this.#state === 1) {
        this.#state = 0; // back to open (session still holds the lock)
      }
      // If state is 2, close() was called during resolve — session is already closed
    }
    if (this.#state >= 2) {
      throw new Error("FileHashCacheSession: closed during resolve");
    }
    const entries = new FileHashCacheEntries(this, dataBuf);
    this.#resolvedEntries = entries;
    return entries;
  }

  /**
   * Check if calling `write(opts)` would result in changes being written.
   *
   * Compares the session status and optional config overrides against the
   * current cache state. Does not perform I/O.
   *
   * @param opts Optional write options to check against.
   * @returns `true` if write would produce changes, `false` if cache is already up-to-date.
   */
  public wouldNeedWrite(opts?: FileHashCacheWriteOptions | null): boolean {
    const s = this.status;
    if (s !== "upToDate") {
      return true; // changed, stale, missing, statsDirty, lockFailed all need a write
    }
    if (!opts) {
      return false;
    }
    const cache = this.#cache;
    if (opts.version !== undefined && opts.version !== cache.version) {
      return true;
    }
    if (opts.fingerprint !== undefined) {
      const newFp = opts.fingerprint;
      const oldFp = cache.fingerprint;
      if (newFp !== oldFp) {
        if (!newFp || !oldFp || newFp.length !== 16 || oldFp.length !== 16) {
          return true;
        }
        if (!Buffer.from(newFp.buffer, newFp.byteOffset, 16).equals(Buffer.from(oldFp.buffer, oldFp.byteOffset, 16))) {
          return true;
        }
      }
    }
    if (opts.files !== undefined) {
      // Compare encoded paths — if the normalized file list differs, write is needed
      const root = opts.rootPath === true ? null : (opts.rootPath ?? cache.rootPath);
      if (opts.files === null) {
        return cache.fileCount > 0;
      }
      const normalized = normalizeFilePaths(root || cache.rootPath, opts.files);
      if (normalized.length !== cache.fileCount) {
        return true;
      }
      const newEncoded = encodeNormalizedPaths(normalized);
      const oldEncoded = cache._encodedPaths;
      if (newEncoded.length !== oldEncoded.length || !newEncoded.equals(oldEncoded)) {
        return true;
      }
    }
    return false;
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
