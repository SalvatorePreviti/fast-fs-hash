/**
 * FileHashCache — read, validate, and write file hash caches with exclusive locking.
 *
 * Every open acquires an exclusive OS-level lock on the cache file. The lock is
 * held until {@link close} is called (or the `using` / `await using` disposable
 * pattern releases it). Writes go directly to the locked fd — no atomic rename.
 *
 * @module
 */

import {
  ENTRY_STRIDE,
  H_FILE_COUNT,
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
import { resolveRoot, setFingerprint, validateUserData } from "./file-hash-cache-utils";
import { binding } from "./init-native";
import { encodeNormalizedPaths, normalizeFilePaths, pathResolve } from "./utils";

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Cache status.
 *
 * - `'upToDate'`   — nothing changed.
 * - `'statsDirty'` — stat metadata updated but content unchanged (cache needs rewrite).
 * - `'changed'`    — content changed (size or hash mismatch in at least one file).
 * - `'stale'`      — version/fingerprint mismatch (entries not trusted).
 * - `'missing'`    — no cache file or unreadable/corrupt.
 */
export type CacheStatus = "upToDate" | "statsDirty" | "changed" | "stale" | "missing";

/** Options for {@link FileHashCache.write}. */
export interface FileHashCacheWriteOptions {
  files?: Iterable<string> | null;
  rootPath?: string | true | null;
  userValue0?: number;
  userValue1?: number;
  userValue2?: number;
  userValue3?: number;
  fingerprint?: Uint8Array | null;
  userData?: readonly Uint8Array[] | null;
}

// ─── Internals ────────────────────────────────────────────────────────

const STATUS_MAP: readonly CacheStatus[] = ["upToDate", "changed", "stale", "missing", "statsDirty"];

const { cacheOpen, cacheWrite } = binding;

const _emptyBuf = Buffer.alloc(0);

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

// ─── FileHashCache ────────────────────────────────────────────────────

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
 * Release the lock via {@link close} or the `using` / `await using` disposable pattern.
 *
 * @example
 * ```ts
 * await using cache = await FileHashCache.open("cache.fsh", null, files, 1);
 * if (cache.status !== "upToDate") {
 *   // ... rebuild ...
 *   await cache.write({ userData: [outputManifest] });
 * }
 * // lock released here
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

  readonly #dataBuf: Buffer;
  readonly #encodedPaths: Buffer;
  #files: readonly string[] | null;
  #lockHandle: bigint;

  /** @internal */
  public constructor(
    cachePath: string,
    version: number,
    rootPath: string,
    fingerprint: Uint8Array | null,
    dataBuf: Buffer,
    encodedPaths: Buffer,
    openFiles: readonly string[] | null,
    lockHandle: bigint
  ) {
    this.#encodedPaths = encodedPaths;
    this.#files = openFiles ?? null;
    this.cachePath = cachePath;
    this.version = version;
    this.rootPath = rootPath;
    this.fingerprint = fingerprint;
    this.#dataBuf = dataBuf;
    this.#lockHandle = lockHandle;

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
    return this.#lockHandle === 0n;
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
   * detect changes. The lock is held until {@link close} is called.
   *
   * Use `await using` for automatic cleanup:
   * ```ts
   * await using cache = await FileHashCache.open("cache.fsh", null, files, 1);
   * if (cache.status !== "upToDate") {
   *   await cache.write({ userData: [manifest] });
   * }
   * // lock released here
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
   * @param timeoutMs Lock acquisition timeout in ms. `-1` (default) = block forever,
   *   `0` = non-blocking try, `>0` = timeout.
   */
  public static async open(
    cachePath: string,
    rootPath?: string | null,
    files?: Iterable<string> | null,
    version?: number,
    fingerprint?: Uint8Array | null,
    timeoutMs?: number
  ): Promise<FileHashCache> {
    const root = resolveRoot(rootPath ?? null, files ?? null);
    const resolvedCachePath = pathResolve(root, cachePath);
    const ver = (version ?? 0) >>> 0;
    const fp = setFingerprint(fingerprint) ?? null;
    const normalizedFiles = files ? normalizeFilePaths(root, files) : null;
    const encoded = normalizedFiles ? encodeNormalizedPaths(normalizedFiles) : _emptyBuf;
    const fileCount = normalizedFiles ? normalizedFiles.length : 0;

    const [lockHandle, dataBuf] = await cacheOpen(
      encoded,
      fileCount,
      resolvedCachePath,
      root,
      ver,
      fp,
      timeoutMs ?? -1
    );

    return new FileHashCache(resolvedCachePath, ver, root, fp, dataBuf, encoded, normalizedFiles, lockHandle);
  }

  /**
   * Release the lock and mark this instance as disposed.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  public close(): void {
    const h = this.#lockHandle;
    if (h === 0n) {
      return;
    }
    this.#lockHandle = 0n;
    binding.cacheLockRelease(h);
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
   * Check whether any process currently holds an exclusive lock on `cachePath`.
   * Non-blocking — does not acquire the lock.
   */
  public static isLocked(cachePath: string): boolean {
    return binding.cacheLockIsLocked(cachePath);
  }

  /**
   * Write the cache file. Hashes any unresolved entries, LZ4-compresses,
   * and writes directly to the locked cache fd.
   *
   * If `options.files` is provided, builds a new file list and remaps entries
   * from the current dataBuf (preserving hashes for unchanged files).
   *
   * @returns `true` if the write succeeded, `false` on failure.
   */
  public async write(options?: FileHashCacheWriteOptions): Promise<boolean> {
    const dataBuf = this.#dataBuf;
    const opts = options ?? {};

    const uv0 = opts.userValue0 ?? this.userValue0;
    const uv1 = opts.userValue1 ?? this.userValue1;
    const uv2 = opts.userValue2 ?? this.userValue2;
    const uv3 = opts.userValue3 ?? this.userValue3;

    if (uv0 !== this.userValue0 || uv1 !== this.userValue1 || uv2 !== this.userValue2 || uv3 !== this.userValue3) {
      dataBuf.writeDoubleLE(uv0, H_USER_VALUE0_BYTE);
      dataBuf.writeDoubleLE(uv1, H_USER_VALUE1_BYTE);
      dataBuf.writeDoubleLE(uv2, H_USER_VALUE2_BYTE);
      dataBuf.writeDoubleLE(uv3, H_USER_VALUE3_BYTE);
    }

    const fp = opts.fingerprint !== undefined ? setFingerprint(opts.fingerprint) : this.fingerprint;
    if (fp) {
      dataBuf.set(fp, H_FINGERPRINT_BYTE);
    } else {
      dataBuf.fill(0, H_FINGERPRINT_BYTE, H_FINGERPRINT_BYTE + 16);
    }

    const ud = opts.userData !== undefined ? opts.userData : this.userData;
    if (ud !== null && ud !== this.userData) {
      validateUserData(ud);
    }

    const resultFiles = opts.files;
    const root = this.rootPath;
    const lockHandle = this.#lockHandle;
    let result: number;
    if (resultFiles) {
      const newRoot = resolveRoot(null, resultFiles, opts.rootPath ?? root);
      const newNormalized = normalizeFilePaths(newRoot, resultFiles);
      const newEncoded = encodeNormalizedPaths(newNormalized);
      result = await cacheWrite(dataBuf, newEncoded, newNormalized.length, this.cachePath, newRoot, ud, lockHandle);
    } else {
      const encoded = this.#encodedPaths;
      result = await cacheWrite(dataBuf, encoded, this.fileCount, this.cachePath, root, ud, lockHandle);
    }
    return result === 0;
  }
}
