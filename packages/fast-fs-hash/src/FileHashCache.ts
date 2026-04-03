/**
 * FileHashCache — read, validate, and write file hash caches with exclusive locking.
 *
 * Every open acquires an exclusive OS-level lock on the cache file. The lock is
 * released by {@link FileHashCache.write} (after writing) or by
 * {@link FileHashCache.close} / the `using` / `await using` disposable pattern.
 * Writes go directly to the locked fd — no atomic rename.
 *
 * @module
 */

import {
  ENTRY_STRIDE,
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
import { resolveRoot } from "./file-hash-cache-utils";
import { binding } from "./init-native";
import { encodeNormalizedPaths, normalizeFilePaths, pathResolve } from "./utils";

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

/** Options for {@link FileHashCache.write}. */
export interface FileHashCacheWriteOptions {
  /** New file list to track. When provided, remaps entries from the current cache
   *  (preserving hashes for unchanged files). Omit to keep the current file list. */
  files?: Iterable<string> | null;
  /** Root directory for the new file list. Required when `files` is provided and
   *  paths are absolute. Pass `true` to auto-detect from the file paths. */
  rootPath?: string | true | null;
  /** User-defined f64 value (slot 0). Preserved from old cache when omitted. */
  userValue0?: number;
  /** User-defined f64 value (slot 1). Preserved from old cache when omitted. */
  userValue1?: number;
  /** User-defined f64 value (slot 2). Preserved from old cache when omitted. */
  userValue2?: number;
  /** User-defined f64 value (slot 3). Preserved from old cache when omitted. */
  userValue3?: number;
  /** 16-byte fingerprint for fast cache rejection. Pass `null` to clear. Omit to preserve. */
  fingerprint?: Uint8Array | null;
  /** Opaque binary payloads stored alongside the cache. Pass `null` to clear.
   *  Omit (`undefined`) to preserve old user data from the existing cache. */
  userData?: readonly Uint8Array[] | null;
  /** AbortSignal to cancel the hash phase. The file write itself is never cancelled.
   *  Ignored when the instance holds a lock (only used by the {@link FileHashCache.writeNew} fallback). */
  signal?: AbortSignal | null;
}

/** Options for the static {@link FileHashCache.writeNew}. */
export interface FileHashCacheWriteNewOptions {
  /** User-defined cache version (u32, 0-4294967295). Default: `0`. */
  version?: number;
  /** 16-byte fingerprint for fast cache rejection. `null` or omit for none. */
  fingerprint?: Uint8Array | null;
  /** User-defined f64 value (slot 0). Default: `0`. */
  userValue0?: number;
  /** User-defined f64 value (slot 1). Default: `0`. */
  userValue1?: number;
  /** User-defined f64 value (slot 2). Default: `0`. */
  userValue2?: number;
  /** User-defined f64 value (slot 3). Default: `0`. */
  userValue3?: number;
  /** Opaque binary payloads stored alongside the cache. `null` or omit for none. */
  userData?: readonly Uint8Array[] | null;
  /** Lock acquisition timeout in ms. `-1` (default) = block forever,
   *  `0` = non-blocking try, `>0` = timeout. */
  lockTimeoutMs?: number;
  /** AbortSignal to cancel the lock wait and/or hash phase.
   *  The file write itself is never cancelled — once hashing completes, the write
   *  always runs to completion to avoid corrupting the cache file. */
  signal?: AbortSignal | null;
}

const STATUS_MAP: readonly CacheStatus[] = ["upToDate", "changed", "stale", "missing", "statsDirty", "lockFailed"];

const { cacheOpen, cacheWrite, cacheWriteNew, cacheIsLocked, cacheWaitUnlocked, cacheClose } = binding;

const _emptyBuf = Buffer.alloc(0);
const _cancelledBuf = new Uint8Array([1]);

/** Abort signal listener cleanup state. Stored as a plain object to avoid
 *  V8 hidden class transitions on the Uint8Array. */
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
    // Calls into C++ which writes the cancelByte AND calls fire() on the
    // matching LockCancel — CancelIoEx on Windows, fired_ flag on POSIX.
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

function statusFromInt(n: number): CacheStatus {
  return STATUS_MAP[n] ?? "missing";
}

function decodeFilePaths(
  buf: Buffer,
  pathEndsStart: number,
  pathsStart: number,
  pathsLen: number,
  fc: number
): string[] {
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

function readAllUserData(
  dataBuf: Buffer,
  udDirStart: number,
  udPayloadsStart: number,
  udItemCount: number
): readonly Buffer[] {
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

/**
 * A file hash cache with an exclusive OS-level lock on the cache file.
 *
 * The lock is implemented via `fcntl F_SETLKW` (POSIX) or `LockFileEx` (Windows)
 * directly on the cache file. It is:
 *  - **Cross-process**: prevents concurrent writers from any process.
 *  - **Crash-safe**: automatically released when the process dies.
 *
 * Created via {@link FileHashCache.open}. Provides readonly access to
 * the cache state and a {@link write} method to persist changes.
 * The lock is released by {@link write} (after writing) or by {@link close}
 * / the `using` / `await using` disposable pattern.
 *
 * @example
 * ```ts
 * await using cache = await FileHashCache.open("cache.fsh", null, files, 1);
 * if (cache.status !== "upToDate") {
 *   // ... rebuild ...
 *   await cache.write({ userData: [outputManifest] });
 *   // write() released the lock — cache is now disposed
 * }
 * // `await using` calls close() again (no-op since already disposed)
 * ```
 */
export class FileHashCache {
  /** Cache file path (resolved). */
  public readonly cachePath: string;

  /** User-defined cache version. */
  public readonly version: number;

  /** Root path used for this open. */
  public readonly rootPath: string;

  /** Fingerprint used for this open (null = no fingerprint). */
  public readonly fingerprint: Uint8Array | null;

  /** Cache status after open. */
  public readonly status: CacheStatus;

  /** Number of file entries in the cache. */
  public readonly fileCount: number;

  /** User-defined f64 values (from old cache, or 0 if missing). */
  public readonly userValue0: number;
  public readonly userValue1: number;
  public readonly userValue2: number;
  public readonly userValue3: number;

  /** User data items loaded from the old cache (eagerly, synchronous access). */
  public readonly userData: readonly Buffer[];

  #closed: boolean;
  readonly #dataBuf: Buffer;
  readonly #encodedPaths: Buffer;
  readonly #lockTimeoutMs: number;
  readonly #cancelBuf: Uint8Array | null;
  #files: readonly string[] | null;

  /** @internal */
  public constructor(
    cachePath: string,
    version: number,
    rootPath: string,
    fingerprint: Uint8Array | null,
    dataBuf: Buffer,
    encodedPaths: Buffer,
    openFiles: readonly string[] | null,
    lockTimeoutMs: number,
    cancelBuf: Uint8Array | null
  ) {
    this.#closed = false;
    this.#dataBuf = dataBuf;
    this.#encodedPaths = encodedPaths;
    this.#lockTimeoutMs = lockTimeoutMs;
    this.#cancelBuf = cancelBuf;
    this.#files = openFiles ?? null;

    this.cachePath = cachePath;
    this.version = version;
    this.rootPath = rootPath;
    this.fingerprint = fingerprint;

    const hdrFc = dataBuf.readUInt32LE(H_FILE_COUNT);
    const pathsLen = dataBuf.readUInt32LE(H_PATHS_LEN);
    const udPayloadsLen = dataBuf.readUInt32LE(H_UD_PAYLOADS_LEN);
    let udItemCount = dataBuf.readUInt32LE(H_UD_ITEM_COUNT);
    const udDirStart = HEADER_SIZE + hdrFc * ENTRY_STRIDE;
    const pathEndsStart = udDirStart + udItemCount * 4;
    const pathsStart = pathEndsStart + hdrFc * 4;
    const udPayloadsStart = pathsStart + pathsLen;
    if (udPayloadsStart + udPayloadsLen > dataBuf.length) {
      udItemCount = 0;
    }

    this.status = statusFromInt(dataBuf.readUInt32LE(H_STATUS_BYTE));
    this.userValue0 = dataBuf.readDoubleLE(H_USER_VALUE0_BYTE);
    this.userValue1 = dataBuf.readDoubleLE(H_USER_VALUE1_BYTE);
    this.userValue2 = dataBuf.readDoubleLE(H_USER_VALUE2_BYTE);
    this.userValue3 = dataBuf.readDoubleLE(H_USER_VALUE3_BYTE);
    this.fileCount = openFiles ? openFiles.length : hdrFc;
    this.userData = readAllUserData(dataBuf, udDirStart, udPayloadsStart, udItemCount);
  }

  /** True once {@link close} has been called. Subsequent calls are no-ops. */
  public get disposed(): boolean {
    return this.#closed;
  }

  /** True if the cache holds a lock and the status indicates a write is needed.
   *  False for `'upToDate'`, `'lockFailed'`, or if already disposed. */
  public get needsWrite(): boolean {
    const s = this.status;
    return !this.#closed && s !== "upToDate" && s !== "lockFailed";
  }

  /** File paths (relative to rootPath, sorted). */
  public get files(): readonly string[] {
    let f = this.#files;
    if (!f) {
      const buf = this.#dataBuf;
      const hdrFc = buf.readUInt32LE(H_FILE_COUNT);
      const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
      const udItemCount = buf.readUInt32LE(H_UD_ITEM_COUNT);
      const udDirStart = HEADER_SIZE + hdrFc * ENTRY_STRIDE;
      const pathEndsStart = udDirStart + udItemCount * 4;
      const pathsStart = pathEndsStart + hdrFc * 4;
      f = decodeFilePaths(buf, pathEndsStart, pathsStart, pathsLen, hdrFc);
      this.#files = f;
    }
    return f;
  }

  /**
   * Open a file hash cache with an exclusive OS-level lock.
   *
   * Acquires an exclusive lock on the cache file, reads from disk, validates
   * version/fingerprint/file list, and if all match, stat-matches entries to
   * detect changes. The lock is held until {@link close} is called, or the
   * returned instance is disposed via `using` / `await using`.
   *
   * Use `await using` for automatic cleanup:
   * ```ts
   * await using cache = await FileHashCache.open("cache.fsh", null, files, 1);
   * if (cache.status !== "upToDate") {
   *   await cache.write({ userData: [manifest] });
   *   // write() released the lock
   * }
   * // `await using` calls close() (no-op if write() already released)
   * ```
   *
   * @param cachePath Path to the cache file. If relative, resolved from `rootPath`.
   * @param rootPath Root directory for file path resolution. When provided, file paths
   *   are stored relative to this directory. When `null`/`undefined`, auto-detected as
   *   the common parent of all `files`. Required when `files` is `null` (reuse mode).
   * @param files Absolute file paths to track. Omit or pass `null` to reuse the
   *   file list from the existing cache on disk.
   * @param version User-defined cache version (u32, 0–4294967295). A mismatch with the
   *   on-disk cache causes `status = 'stale'`. Default: `0`.
   * @param fingerprint 16-byte `Uint8Array` for fast cache rejection. A mismatch causes
   *   `status = 'stale'`. Omit or pass `null` for no fingerprint check.
   * @param lockTimeoutMs Lock acquisition timeout in ms. `-1` (default) = block forever,
   *   `0` = non-blocking try, `>0` = timeout. When the lock cannot be acquired,
   *   the returned instance has `status === 'lockFailed'` instead of throwing.
   *   You can still call {@link write} on it — it will transparently fall back to
   *   {@link writeNew} with a fresh lock attempt.
   * @param signal Optional AbortSignal to cancel the lock wait and/or stat phase.
   */
  public static async open(
    cachePath: string,
    rootPath?: string | null,
    files?: Iterable<string> | null,
    version?: number,
    fingerprint?: Uint8Array | null,
    lockTimeoutMs?: number,
    signal?: AbortSignal | null
  ): Promise<FileHashCache> {
    const root = resolveRoot(rootPath ?? null, files ?? null);
    const resolvedCachePath = pathResolve(root, cachePath);
    const ver = (version ?? 0) >>> 0;
    const fp = fingerprint ?? null;
    const normalizedFiles = files ? normalizeFilePaths(root, files) : null;
    const encoded = normalizedFiles ? encodeNormalizedPaths(normalizedFiles) : _emptyBuf;
    const fileCount = normalizedFiles ? normalizedFiles.length : 0;

    const timeout = lockTimeoutMs ?? -1;
    const cancelBuf = signal ? cancelBufFromSignal(signal) : null;
    let dataBuf: Buffer;
    try {
      dataBuf = await cacheOpen(encoded, fileCount, resolvedCachePath, root, ver, fp, timeout, cancelBuf);
    } catch (e) {
      cleanupCancelBuf(cancelBuf);
      throw e;
    }

    return new FileHashCache(resolvedCachePath, ver, root, fp, dataBuf, encoded, normalizedFiles, timeout, cancelBuf);
  }

  /**
   * Release the exclusive lock and mark this instance as disposed.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   * Also called automatically by {@link write} after a successful write.
   */
  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    cleanupCancelBuf(this.#cancelBuf);
    const buf = this.#dataBuf;
    const h = buf.readInt32LE(H_FILE_HANDLE);
    buf.writeInt32LE(-1, H_FILE_HANDLE);
    if (h !== -1) {
      cacheClose(h);
    }
  }

  /** Disposable — `using cache = ...` (synchronous close). */
  public [Symbol.dispose](): void {
    this.close();
  }

  /** AsyncDisposable — `await using cache = ...`. */
  public [Symbol.asyncDispose](): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  /**
   * Check whether another process currently holds an exclusive lock on `cachePath`.
   * Non-blocking — does not acquire the lock.
   *
   * **POSIX note:** uses `fcntl F_GETLK`, which only detects locks held by *other*
   * processes. Locks held by the calling process are invisible (standard POSIX behavior).
   *
   * @param cachePath Path to the cache file to check.
   */
  public static isLocked(cachePath: string): boolean {
    return cacheIsLocked(pathResolve(cachePath));
  }

  /**
   * Wait until the cache file is no longer exclusively locked by another process.
   *
   * For infinite wait (`lockTimeoutMs = -1`), blocks a pool thread in the kernel
   * using `fcntl F_SETLKW` (zero CPU). For finite timeouts, uses a platform-specific
   * timer to interrupt the blocking lock call.
   *
   * **POSIX note:** only detects locks held by *other* processes (same as {@link isLocked}).
   *
   * @param cachePath Path to the cache file to wait on.
   * @param lockTimeoutMs Maximum time to wait in milliseconds.
   *   `-1` (default) = block until unlocked, `0` = non-blocking check, `>0` = timeout.
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

  /**
   * Write a brand-new cache file without reading the old one.
   *
   * Acquires an exclusive lock, hashes all files, LZ4-compresses, and writes
   * directly to the cache file. This is equivalent to `open()` + `write()` but
   * skips the read/decompress/validate step entirely — useful when you know the
   * cache must be rebuilt (e.g., after a full build) and want to avoid the
   * overhead of reading + decompressing the old cache.
   *
   * @param cachePath Path to the cache file. If relative, resolved from `rootPath`.
   * @param rootPath Root directory for file path resolution.
   * @param files Absolute file paths to track. Required (cannot reuse from disk).
   * @param options Version, fingerprint, user values, user data, and timeout.
   * @returns `true` if the write succeeded, `false` on failure.
   */
  public static async writeNew(
    cachePath: string,
    rootPath: string | null,
    files: Iterable<string>,
    options?: FileHashCacheWriteNewOptions
  ): Promise<boolean> {
    const root = resolveRoot(rootPath, files);
    const normalizedFiles = normalizeFilePaths(root, files);
    const sig = options?.signal;
    const cancelBuf = sig ? cancelBufFromSignal(sig) : null;
    try {
      return (
        (await cacheWriteNew(
          encodeNormalizedPaths(normalizedFiles),
          normalizedFiles.length,
          pathResolve(root, cachePath),
          root,
          (options?.version ?? 0) >>> 0,
          options?.fingerprint ?? null,
          options?.userValue0 ?? 0,
          options?.userValue1 ?? 0,
          options?.userValue2 ?? 0,
          options?.userValue3 ?? 0,
          options?.userData ?? null,
          options?.lockTimeoutMs ?? -1,
          cancelBuf
        )) === 0
      );
    } finally {
      cleanupCancelBuf(cancelBuf);
    }
  }

  /**
   * Write the cache file and release the lock.
   *
   * Hashes any unresolved entries, LZ4-compresses, and writes directly to the
   * locked cache fd. After writing, the lock is released and this instance is
   * marked as disposed — no further reads or writes are possible.
   *
   * If `options.files` is provided, builds a new file list and remaps entries
   * from the current dataBuf (preserving hashes for unchanged files).
   *
   * If the instance has `status === 'lockFailed'` (lock was not acquired during
   * {@link open}), this method closes the instance and transparently falls back
   * to {@link writeNew}, which acquires a fresh lock and writes a new cache file.
   *
   * **Note:** The file lock is released asynchronously on the native pool thread
   * after the write completes. When this promise resolves, the JS-side instance
   * is disposed, but other processes calling {@link isLocked} may still briefly
   * observe the lock before the OS fully releases it.
   *
   * @param options Optional write options: new file list, user values, fingerprint, userData.
   * @throws If this instance has already been closed or written.
   * @returns `true` if the write succeeded, `false` on failure.
   */
  public async write(options?: FileHashCacheWriteOptions): Promise<boolean> {
    if (this.#closed) {
      throw new Error("FileHashCache: already closed");
    }

    if (this.status === "lockFailed") {
      this.close();
      const files = options?.files ?? this.files;
      const root = options?.rootPath ?? this.rootPath;
      return FileHashCache.writeNew(this.cachePath, typeof root === "string" ? root : null, files, {
        version: this.version,
        fingerprint: options?.fingerprint !== undefined ? options.fingerprint : this.fingerprint,
        userValue0: options?.userValue0 ?? this.userValue0,
        userValue1: options?.userValue1 ?? this.userValue1,
        userValue2: options?.userValue2 ?? this.userValue2,
        userValue3: options?.userValue3 ?? this.userValue3,
        userData: options?.userData !== undefined ? options.userData : this.userData,
        lockTimeoutMs: this.#lockTimeoutMs,
        signal: options?.signal,
      });
    }

    const dataBuf = this.#dataBuf;

    // Always write user values — 4 writeDoubleLE calls are cheaper than 4 comparisons.
    dataBuf.writeDoubleLE(options?.userValue0 ?? this.userValue0, H_USER_VALUE0_BYTE);
    dataBuf.writeDoubleLE(options?.userValue1 ?? this.userValue1, H_USER_VALUE1_BYTE);
    dataBuf.writeDoubleLE(options?.userValue2 ?? this.userValue2, H_USER_VALUE2_BYTE);
    dataBuf.writeDoubleLE(options?.userValue3 ?? this.userValue3, H_USER_VALUE3_BYTE);

    const fp = options?.fingerprint !== undefined ? options.fingerprint : this.fingerprint;
    if (fp) {
      if (!(fp instanceof Uint8Array) || fp.length !== 16) {
        throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
      }
      dataBuf.set(fp, H_FINGERPRINT_BYTE);
    } else {
      dataBuf.fill(0, H_FINGERPRINT_BYTE, H_FINGERPRINT_BYTE + 16);
    }

    const ud = options?.userData !== undefined ? options.userData : this.userData;

    const writeSig = options?.signal;
    const writeCancelBuf = writeSig ? cancelBufFromSignal(writeSig) : null;
    const cancelBuf = writeCancelBuf ?? this.#cancelBuf;

    const resultFiles = options?.files;
    const root = this.rootPath;
    let result: number;
    try {
      if (resultFiles) {
        const newRoot = resolveRoot(null, resultFiles, options?.rootPath ?? root);
        const newNormalized = normalizeFilePaths(newRoot, resultFiles);
        const newEncoded = encodeNormalizedPaths(newNormalized);
        result = await cacheWrite(dataBuf, newEncoded, newNormalized.length, this.cachePath, newRoot, ud, cancelBuf);
      } else {
        const encoded = this.#encodedPaths;
        result = await cacheWrite(dataBuf, encoded, this.fileCount, this.cachePath, root, ud, cancelBuf);
      }
    } finally {
      cleanupCancelBuf(writeCancelBuf);
      this.close();
    }
    return result === 0;
  }
}
