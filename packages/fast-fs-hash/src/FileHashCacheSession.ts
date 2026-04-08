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
  H_PAYLOAD0_BYTE,
  H_PAYLOAD1_BYTE,
  H_PAYLOAD2_BYTE,
  H_PAYLOAD3_BYTE,
  S_CANCEL_FLAG,
  S_FILE_COUNT,
  S_FLAGS,
  S_STATUS,
} from "./file-hash-cache-format";
import {
  cacheClose,
  cacheWrite,
  decodeFilePathsFromBuf,
  readPayloadData,
  STATUS_MAP,
  setupCancel,
  teardownCancel,
  toAbsolutePaths,
} from "./file-hash-cache-internal";

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

  /** Payload f64 value (slot 0) read from disk. `0` when status is `'missing'`. */
  public readonly payloadValue0: number;

  /** Payload f64 value (slot 1) read from disk. `0` when status is `'missing'`. */
  public readonly payloadValue1: number;

  /** Payload f64 value (slot 2) read from disk. `0` when status is `'missing'`. */
  public readonly payloadValue2: number;

  /** Payload f64 value (slot 3) read from disk. `0` when status is `'missing'`. */
  public readonly payloadValue3: number;

  readonly #cache: FileHashCache;
  /** 0 = open, 1 = writing, 2 = closed */
  #state: number;
  readonly #dataBuf: Buffer;
  readonly #stateBuf: Buffer;
  readonly #lockTimeoutMs: number;
  #files: readonly string[] | null;
  #payloadData: readonly Buffer[] | null;
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
    this.#payloadData = null;
    this.#resolvedEntries = null;

    this.status = STATUS_MAP[stateBuf.readUInt32LE(S_STATUS)] ?? "missing";
    this.version = cache.version;
    this.rootPath = openRootPath;
    this.payloadValue0 = dataBuf.readDoubleLE(H_PAYLOAD0_BYTE);
    this.payloadValue1 = dataBuf.readDoubleLE(H_PAYLOAD1_BYTE);
    this.payloadValue2 = dataBuf.readDoubleLE(H_PAYLOAD2_BYTE);
    this.payloadValue3 = dataBuf.readDoubleLE(H_PAYLOAD3_BYTE);
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

  /** Opaque binary payloadData read from disk. Empty array if none. Lazily decoded, zero-copy. */
  public get payloadData(): readonly Buffer[] {
    let d = this.#payloadData;
    if (!d) {
      d = readPayloadData(this.#dataBuf);
      this.#payloadData = d;
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
   * `true` if the cache configuration (files, version, fingerprint) was modified
   * since this session was opened (via setters or {@link FileHashCache.configure}).
   */
  public get configChanged(): boolean {
    return this.#cache.needsOpen;
  }

  /**
   * Check if a write is needed — either because the cache status indicates changes
   * on disk, or because the cache configuration was modified since this session was opened.
   *
   * Equivalent to `session.status !== 'upToDate' || session.configChanged`.
   */
  public get wouldNeedWrite(): boolean {
    return this.status !== "upToDate" || this.#cache.needsOpen;
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
    const p0 = options?.payloadValue0 ?? this.payloadValue0;
    const p1 = options?.payloadValue1 ?? this.payloadValue1;
    const p2 = options?.payloadValue2 ?? this.payloadValue2;
    const p3 = options?.payloadValue3 ?? this.payloadValue3;
    const ud =
      options?.payloadData !== undefined
        ? (options.payloadData ?? null)
        : this.payloadData.length > 0
          ? this.payloadData
          : null;
    const encoded = cache._encodedPaths;
    const fc = cache.fileCount;
    const root = cache.rootPath;
    const sb = this.#stateBuf;
    const fp = cache.fingerprint;

    if (this.status === "lockFailed") {
      // The lockFailed session never acquired the JS path mutex or the OS lock,
      // so we cannot write through it directly — that would race against any
      // other in-isolate instance currently holding the slot. Delegate to
      // cache.overwrite() which goes through #acquire and serializes correctly.
      this.close();
      return cache.overwrite({
        payloadValue0: p0,
        payloadValue1: p1,
        payloadValue2: p2,
        payloadValue3: p3,
        payloadData: ud,
        signal,
        lockTimeoutMs: options?.lockTimeoutMs ?? this.#lockTimeoutMs,
      });
    }

    const dataBuf = this.#dataBuf;

    dataBuf.writeDoubleLE(p0, H_PAYLOAD0_BYTE);
    dataBuf.writeDoubleLE(p1, H_PAYLOAD1_BYTE);
    dataBuf.writeDoubleLE(p2, H_PAYLOAD2_BYTE);
    dataBuf.writeDoubleLE(p3, H_PAYLOAD3_BYTE);

    // fp is already validated (length === 16) by FileHashCache.fingerprint setter.
    if (fp) {
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
