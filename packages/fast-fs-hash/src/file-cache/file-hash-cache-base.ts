import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, unlink } from "node:fs/promises";
import process from "node:process";
import { decodeFilePaths, encodeFilePaths } from "../functions";
import { arraysEqual, bufferAlloc, bufferAllocUnsafe, finalizeWrite, noop, safeClose } from "../helpers";
import { findCommonRootPath, normalizeFilePaths, pathDirname, pathResolve, toRelativePath } from "../path-utils";
import type { XXHash128LibraryStatus } from "../xxhash128/xxhash128-base";
import {
  ENTRY_STRIDE,
  F_DONE,
  H_FILE_COUNT,
  H_FINGERPRINT_BYTE,
  H_MAGIC,
  H_PATHS_LEN,
  H_USER,
  H_VERSION,
  HEADER_SIZE,
  MAGIC,
} from "./file-hash-cache-format";
import type { FileHashCacheImpl } from "./file-hash-cache-impl";
import type { FileHashCacheOptions, FileHashCacheSerializeResult } from "./types";

// Re-export constants so existing consumers (tests, format.ts) keep working.
export {
  ENTRY_STRIDE,
  H_FILE_COUNT,
  H_FINGERPRINT_BYTE,
  H_MAGIC,
  H_PATHS_LEN,
  H_USER,
  H_VERSION,
  HEADER_SIZE,
  MAGIC,
} from "./file-hash-cache-format";

/** 16-byte zero buffer for default fingerprint comparison. */
const ZERO_FP = new Uint8Array(16);

/** Shared frozen empty array — avoids allocating a new `[]` on every access. */
const EMPTY_FILES: readonly string[] = Object.freeze([]);

const O_RD = constants.O_RDONLY;

// ── Bit flags for FileHashCacheBase._flags ──────────────────────────
const FL_DISPOSED = 1;
const FL_COMPLETED = 2;
const FL_REMAPPED = 4;
const FL_AUTO_ROOT = 8;
const FL_NATIVE = 16;

/**
 * Abstract base class for cache-file readers, validators, and writers.
 *
 * @example
 * ```ts
 * await FileHashCache.init();
 * await using cache = new FileHashCache("/my/project", ".cache/fsh", {
 *   version: 1, fingerprint: myConfigHash,
 * });
 * cache.setFiles(["src/a.ts", "src/b.ts"]);
 * const valid = await cache.validate();
 * if (!valid) {
 *   await cache.serialize();
 *   await cache.write(compiledBytes);
 *   cache.position += compiledBytes.length;
 * } else {
 *   const buf = Buffer.alloc(expectedLen);
 *   await cache.read(buf);
 * }
 * // dispose is called automatically via `await using`
 * ```
 */
export abstract class FileHashCacheBase {
  /**
   * Absolute root directory for all tracked files.
   *
   * All file paths passed to {@link setFiles} are resolved relative to this
   * directory. Paths stored in the cache file are always unix-style relative
   * paths (no leading `./`, always `/` separators). Files outside this root
   * are silently ignored — this is both for portability (the cache stays valid
   * when the project directory moves) and for security (prevents accessing
   * files outside the project root).
   *
   * Can be changed via the `rootPath` parameter of {@link setFiles}.
   * When the constructor or {@link setFiles} receives `true`, the root
   * is auto-computed from the file list on every {@link setFiles} call.
   */
  public get rootPath(): string {
    return this._rootPath;
  }

  /**
   * `rootPath` with a guaranteed trailing `/` — avoids per-file
   * string concatenation in the WASM stat/hash hot path.
   */
  public get rootPathSlash(): string {
    return this._rootPathSlash;
  }

  /** The file path this cache operates on. */
  public readonly filePath: string;

  /** User-defined cache version. Mismatch rejects the cache immediately. */
  public readonly version: number;

  /** Backend library status: `"native"` or `"wasm"`. */
  public get libraryStatus(): XXHash128LibraryStatus {
    return this._flags & FL_NATIVE ? "native" : "wasm";
  }

  /**
   * Current position for {@link read} / {@link write} operations.
   *
   * After a successful {@link validate}, points to the start of the
   * user data section. After {@link serialize}, points past the
   * internal metadata. Not auto-advanced by read/write.
   */
  public position = 0;

  // ── Immutable configuration (set once in constructor) ─────────────

  /** Backend implementation for stat, hash and remap operations. @internal */
  private readonly _impl: FileHashCacheImpl;

  /**
   * Optional 16-byte fingerprint from {@link FileHashCacheOptions.fingerprint}.
   * When non-null, the cache is rejected if the stored fingerprint differs —
   * used to invalidate on config changes without bumping the version number.
   */
  private readonly _fingerprint: Uint8Array | null = null;

  // ── Current file list (hot path — setFiles / validate / complete) ─

  /**
   * Number of tracked files.
   * Equal to `_files.length` when `_files` is non-null, or the count
   * read from the cache header when the list was loaded via {@link validate}.
   */
  private _fileCount = 0;

  /**
   * User-provided file list from {@link setFiles}, or `null` when the list
   * was loaded from the cache file (in which case {@link currentFiles}
   * decodes {@link _pathsBuf} lazily via {@link oldFiles}).
   */
  private _files: string[] | null = null;

  /**
   * NUL-separated UTF-8 encoded file paths buffer.
   * Set to `null` by {@link setFiles} (lazy — encoded on demand by
   * {@link getPathsBuf}). Set directly when read from the cache file
   * during {@link validate}.
   */
  private _pathsBuf: Buffer | null = null;

  // ── Validation buffers (hot path — validate / complete / serialize) ─

  /**
   * Per-entry binary buffer: `_fileCount × ENTRY_STRIDE` bytes.
   * Each entry holds 32 bytes of stat metadata + 16 bytes of xxHash3-128 digest.
   * Allocated during {@link validate} or lazily in {@link complete}.
   */
  private _entriesBuf: Buffer | null = null;

  /**
   * Per-file state flags array (`_fileCount` elements).
   * Values: `F_NOT_CHECKED`, `F_DONE`, `F_NEED_HASH`, `F_HAS_OLD`.
   * Allocated alongside {@link _entriesBuf}.
   */
  private _fileStates: Uint8Array | null = null;

  // ── Completion / result state ─────────────────────────────────────

  /**
   * Packed boolean state flags — avoids four separate boolean fields.
   *
   * - `FL_DISPOSED`   — instance has been disposed
   * - `FL_COMPLETED`  — stat/hash pass is finished
   * - `FL_REMAPPED`   — post-validate remap was already performed
   * - `FL_AUTO_ROOT`  — auto-compute rootPath from file list
   */
  private _flags = 0;

  /**
   * Cached result of {@link getChangedFiles}.
   * Set to `null` whenever the completed flag is reset so the next call
   * recomputes the diff. Once computed, the same array reference is returned.
   */
  private _changedFiles: readonly string[] | null = null;

  // ── Old cache state (set during validate, read lazily) ────────────

  /**
   * Decoded file list from the previous cache file, or `null` if not yet
   * decoded. Populated lazily by the {@link oldFiles} getter from
   * {@link _oldPathsBuf}. Set to {@link EMPTY_FILES} when the cache was
   * empty or missing.
   */
  private _oldFiles: readonly string[] | null = null;

  /**
   * Raw NUL-separated UTF-8 paths buffer read from the old cache file.
   * Kept until {@link oldFiles} is first accessed (lazy decode), then
   * retained for the lifetime of the instance.
   */
  private _oldPathsBuf: Buffer | null = null;

  // ── I/O handles and lifecycle (cold path) ─────────────────────────

  /** Read-only file handle for the existing cache file, opened by {@link validate}. */
  private _fh: FileHandle | null = null;

  /** Write file handle for the new cache file, opened by {@link serialize}. */
  private _writeFh: FileHandle | null = null;

  /** Temporary file path for atomic write (renamed to {@link _writeOutPath} on dispose). */
  private _writeTmpPath: string | null = null;

  /** Final output path for the cache file (same as {@link filePath}). */
  private _writeOutPath: string | null = null;

  /** Absolute path to the project root directory, backing field for getter {@link rootPath}. */
  private _rootPath: string;

  /** `_rootPath + "/"` — cached to avoid per-file concatenation in the WASM hot path. */
  private _rootPathSlash: string;

  /**
   * @param rootPath  Absolute path to the project root directory, or `true`
   *   to auto-compute the root from the file list on every {@link setFiles}
   *   call.  When `true`, the initial root is set to the system root
   *   (`/` on POSIX, the CWD drive root on Windows) until {@link setFiles}
   *   is called.
   * @param filePath  Path to the cache file on disk.
   * @param options   Configuration (version, fingerprint, seeds).
   * @param impl      Backend implementation for stat+hash operations.
   */
  protected constructor(
    rootPath: string | true,
    filePath: string,
    options: FileHashCacheOptions | undefined,
    impl: FileHashCacheImpl
  ) {
    let resolved: string;
    let flags = impl.native ? FL_NATIVE : 0;
    if (rootPath === true) {
      flags |= FL_AUTO_ROOT;
      resolved = pathResolve("/");
    } else {
      resolved = pathResolve(rootPath);
    }
    this._flags = flags;
    this._rootPath = resolved;
    this._rootPathSlash = resolved.endsWith("/") ? resolved : resolved + "/";
    this.filePath = filePath;
    this.version = (options?.version ?? 0) >>> 0;
    this._impl = impl;

    const fp = options?.fingerprint;
    if (fp !== undefined) {
      if (!(fp instanceof Uint8Array) || fp.length !== 16) {
        throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
      }
      this._fingerprint = fp;
    }
  }

  /** User-defined unsigned 32-bit value persisted in the cache header. Available after {@link validate}. */
  public userValue0 = 0;

  /** User-defined unsigned 32-bit value persisted in the cache header. Available after {@link validate}. */
  public userValue1 = 0;

  /** User-defined unsigned 32-bit value persisted in the cache header. Available after {@link validate}. */
  public userValue2 = 0;

  /** User-defined unsigned 32-bit value persisted in the cache header. Available after {@link validate}. */
  public userValue3 = 0;

  /**
   * Number of files currently tracked.
   *
   * Equal to the length of the array returned by {@link currentFiles}.
   * Updated by {@link setFiles} and by {@link validate} when no prior
   * {@link setFiles} call was made (the count is read from the cache file).
   *
   * Use this to iterate {@link getFileHash} without allocating the files array.
   */
  public get fileCount(): number {
    return this._fileCount;
  }

  /**
   * Number of files currently tracked — same as {@link fileCount}.
   *
   * Provided as a method to match the `currentFiles` / `getChangedFiles` naming
   * convention. For use cases where a property access is preferred, use
   * {@link fileCount} directly.
   *
   * @returns The number of files in the current tracking list, or `0` if no
   *   files have been configured via {@link setFiles} or loaded from a cache
   *   by {@link validate}.
   */
  public getFileCount(): number {
    return this._fileCount;
  }

  /**
   * Set the file list for the next validate/serialize cycle.
   *
   * Each path is resolved relative to {@link rootPath} (or the provided
   * `rootPath` override) and normalized to a clean unix-style relative path
   * (forward slashes, no leading `./` or `../`). **Files that resolve
   * outside the root are silently dropped** — this is intentional for
   * security and portability.
   *
   * Paths are sorted lexicographically and deduplicated after normalization.
   *
   * When called after {@link validate} with a different file list,
   * fully-resolved entries from the previous validation are remapped
   * to the new list so {@link serialize} can skip rehashing unchanged
   * files that appear in both lists.
   *
   * Resets the completion state ({@link getChangedFiles} will return `[]`
   * until {@link complete}, {@link serialize}, or a new {@link validate}
   * cycle is run — unless the list is identical to the current one).
   *
   * After {@link validate}, `setFiles` may be called **at most once** with
   * a different file list. A second call throws — the remap would lose
   * already-resolved hashes.
   *
   * @param files    File paths to track (absolute or relative to the root).
   * @param rootPath Optional new root directory. When provided as a string,
   *   replaces the current {@link rootPath} before normalizing paths and
   *   disables auto-root mode.  When `true`, enables auto-root mode:
   *   the root is computed from the file list via {@link findCommonRootPath},
   *   falling back to the system root (`/` on POSIX, CWD drive root on
   *   Windows) when no common directory exists.
   *   When omitted, `null`, or `undefined` the existing root (and mode)
   *   is kept — if auto-root was previously enabled, the root is
   *   recomputed from the new file list.
   * @throws If disposed or if a post-validate remap has already been performed.
   */
  public setFiles(files: Iterable<string>, rootPath?: string | true | null | undefined): void {
    let flags = this._flags;
    if (flags & (FL_DISPOSED | FL_REMAPPED)) {
      if (flags & FL_DISPOSED) {
        throw new Error("FileHashCache: already disposed");
      }
      throw new Error("FileHashCache: setFiles() cannot be called again after a post-validate remap");
    }

    // Resolve auto-root mode: true → enable, string → disable, null/undefined → keep.
    if (rootPath === true) {
      flags |= FL_AUTO_ROOT;
    } else if (typeof rootPath === "string") {
      flags &= ~FL_AUTO_ROOT;
    }

    const oldRootPath = this._rootPath;
    let resolvedRoot: string;

    if (flags & FL_AUTO_ROOT) {
      // Auto-root: derive the common parent directory from the file list.
      // Materialize the iterable so it can be iterated twice (once here,
      // once in normalizeFilePaths).
      if (!Array.isArray(files)) {
        files = Array.from(files);
      }
      const computed = findCommonRootPath(files);
      resolvedRoot = pathResolve(computed || "/");
    } else if (typeof rootPath === "string") {
      resolvedRoot = pathResolve(rootPath);
    } else {
      resolvedRoot = oldRootPath;
    }

    const rootChanged = resolvedRoot !== oldRootPath;

    // Early exit: same array reference, no root change — nothing to do.
    if (!rootChanged && files === this.currentFiles) {
      this._flags = flags;
      return;
    }

    if (rootChanged) {
      this._rootPath = resolvedRoot;
      this._rootPathSlash = resolvedRoot.endsWith("/") ? resolvedRoot : resolvedRoot + "/";
    }

    const arr = normalizeFilePaths(this._rootPath, files);

    // Fast-path: same list via element-wise comparison — skip re-encoding.
    // When rootPath changed the old relative paths differ even if pointing to
    // the same absolute files, so skip this comparison entirely.
    if (!rootChanged && arraysEqual(arr, this.currentFiles)) {
      this._files = arr;
      this._flags = flags;
      return;
    }

    // Capture current file list BEFORE overwriting _files — needed by remap.
    const prevOldFiles = this.currentFiles;
    const oldEntriesBuf = this._entriesBuf;
    const oldFileStates = this._fileStates;

    this._files = arr;
    this._pathsBuf = null; // lazy — encoded on demand by getPathsBuf()
    this._fileCount = arr.length;
    this._changedFiles = null;

    if (oldEntriesBuf && oldFileStates && arr.length > 0) {
      flags = (flags & ~FL_COMPLETED) | FL_REMAPPED;
      this._flags = flags;

      // When rootPath changed, old relative paths are relative to the OLD root.
      let remapOldFiles: readonly string[];
      let remapOldEntries: Buffer;
      let remapOldCount: number;
      if (rootChanged) {
        const r = this._remapForNewRoot(oldRootPath, prevOldFiles, oldEntriesBuf, oldFileStates);
        remapOldFiles = r.files;
        remapOldEntries = r.entries;
        remapOldCount = r.count;
      } else {
        // Same root — zero non-F_DONE entries to prevent remapping partial/invalid data.
        const oldCount = oldFileStates.length;
        for (let i = 0; i < oldCount; i++) {
          if (oldFileStates[i] !== F_DONE) {
            oldEntriesBuf.fill(0, i * ENTRY_STRIDE, (i + 1) * ENTRY_STRIDE);
          }
        }
        remapOldFiles = prevOldFiles;
        remapOldEntries = oldEntriesBuf;
        remapOldCount = oldCount;
      }

      const newEntriesBuf = bufferAlloc(arr.length * ENTRY_STRIDE);
      const newFileStates = new Uint8Array(arr.length);
      this._impl.remapOldEntries(this, remapOldEntries, remapOldFiles, remapOldCount, newEntriesBuf, newFileStates);

      this._entriesBuf = newEntriesBuf;
      this._fileStates = newFileStates;
    } else {
      this._flags = flags & ~FL_COMPLETED;
      this._entriesBuf = null;
      this._fileStates = null;
    }
  }

  /**
   * Re-relativize old entries for a root path change.
   *
   * Resolves each old relative path (under `oldRoot`) against the current
   * `_rootPath` via {@link toRelativePath}. Paths that fall outside the new
   * root are dropped. Only `F_DONE` entries (valid stat+hash) are kept —
   * partial/invalid entries are discarded.
   *
   * The surviving entries are re-sorted by their new relative paths and
   * the entries buffer is permuted to match the new sort order.
   *
   * @returns Sorted entries buffer, re-relativized paths, and surviving count.
   */
  private _remapForNewRoot(
    oldRoot: string,
    oldFiles: readonly string[],
    oldEntriesBuf: Buffer,
    oldFileStates: Uint8Array
  ): { entries: Buffer; files: string[]; count: number } {
    // For each old relative path, resolve to absolute via oldRoot, then
    // re-relativize against _rootPath.  Paths outside the new root or
    // with non-F_DONE state are dropped.
    const newRoot = this._rootPath;
    const pairs: [string, number][] = [];
    const n = Math.min(oldFileStates.length, oldFiles.length);
    for (let i = 0; i < n; i++) {
      if (oldFileStates[i] !== F_DONE) {
        continue;
      }
      const p = toRelativePath(newRoot, pathResolve(oldRoot, oldFiles[i]));
      if (p !== null) {
        pairs.push([p, i]);
      }
    }

    // The merge-join in remapOldEntries requires both lists sorted.
    // When one root is an ancestor of the other (common case),
    // toRelativePath preserves order — skip the O(n log n) sort.
    let needSort = false;
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i][0] <= pairs[i - 1][0]) {
        needSort = true;
        break;
      }
    }
    if (needSort) {
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      // Deduplicate — two old paths may resolve to the same new relative
      // path when roots are unrelated. Already-sorted pairs can't have dupes
      // (normalizeFilePaths guarantees unique old paths under the old root,
      // and toRelativePath is injective for resolved paths).
      let w = 0;
      for (let r = 0; r < pairs.length; r++) {
        if (r === 0 || pairs[r][0] !== pairs[r - 1][0]) {
          pairs[w++] = pairs[r];
        }
      }
      pairs.length = w;
    }

    // Build permuted entries buffer and sorted paths list.
    const count = pairs.length;
    const entries = bufferAlloc(count * ENTRY_STRIDE);
    const files = new Array<string>(count);
    for (let k = 0; k < count; k++) {
      const oi = pairs[k][1];
      files[k] = pairs[k][0];
      oldEntriesBuf.copy(entries, k * ENTRY_STRIDE, oi * ENTRY_STRIDE, (oi + 1) * ENTRY_STRIDE);
    }

    return { entries, files, count };
  }

  /**
   * The current file list as a sorted, deduplicated readonly array.
   *
   * Available throughout the full lifecycle: after {@link setFiles},
   * {@link validate}, {@link serialize}, and even after {@link dispose}.
   * Returns `[]` before any of those are called.
   *
   * When {@link setFiles} was called, returns the user-provided list
   * (normalized). When only {@link validate} was called (no prior
   * {@link setFiles}), returns the file list read from the cache file.
   *
   * The returned array is cached — repeated calls return the same reference
   * until the file list changes.
   */
  public get currentFiles(): readonly string[] {
    return this._files ?? this.oldFiles;
  }

  /**
   * The file list that was stored in the old cache file, as a readonly array.
   *
   * Available after {@link validate} — returns the paths section from
   * the cache file that was read during validation. Returns `[]` if
   * {@link validate} has not been called or no valid cache existed.
   *
   * When {@link setFiles} was NOT called before {@link validate},
   * this returns the same list as {@link currentFiles} (the cache's
   * file list becomes the current list). When {@link setFiles} WAS
   * called, this returns the old cache's list which may differ from
   * the current one.
   *
   * The returned array is cached — repeated calls return the same
   * reference.
   */
  public get oldFiles(): readonly string[] {
    let files = this._oldFiles;
    if (!files) {
      const pathsBuf = this._oldPathsBuf;
      if (!pathsBuf) {
        return (this._oldFiles = EMPTY_FILES);
      }
      files = decodeFilePaths(pathsBuf) as string[];
      this._oldFiles = files;
    }
    return files;
  }

  /**
   * Get the NUL-separated UTF-8 paths buffer for the current file list.
   *
   * Lazily encodes {@link currentFiles} on first call; subsequent calls
   * return the cached buffer. The native C++ backend uses this to avoid
   * decoding string arrays. Also used by {@link serialize} for the
   * on-disk paths section.
   *
   * @internal — Not part of the public API.
   */
  public getPathsBuf(): Buffer {
    return (this._pathsBuf ??= encodeFilePaths(this.currentFiles) as Buffer);
  }

  /**
   * Get the list of files whose content or metadata changed since the
   * last cached state.
   *
   * **This method is synchronous and requires prior completion.**
   * You must call {@link complete}, {@link serialize}, or run a full
   * {@link validate} cycle before this method returns meaningful data.
   *
   * - Before completion: returns `[]` (not an error — simply not ready yet).
   * - After {@link complete} or {@link serialize}: returns the subset of
   *   {@link currentFiles} whose stat metadata or content hash differed from
   *   the previous cache. Empty array when nothing changed.
   * - After a successful {@link validate} (returned `true`): returns `[]`
   *   immediately without any I/O — the completion state is set by validate.
   *
   * The result is cached after the first computation and the same array
   * reference is returned on subsequent calls. The cache is reset whenever
   * {@link setFiles} changes the file list or {@link validate} is called.
   *
   * @returns Sorted array of changed file paths, or `[]` if not yet
   *   completed or nothing changed.
   */
  public getChangedFiles(): readonly string[] {
    const cached = this._changedFiles;
    if (cached !== null) {
      return cached;
    }
    if (!(this._flags & FL_COMPLETED)) {
      return []; // not ready — call complete() or serialize() first
    }
    const fileStates = this._fileStates;
    if (!fileStates) {
      return (this._changedFiles = []);
    }
    const files = this.currentFiles;
    if (files.length === 0) {
      return (this._changedFiles = []);
    }
    const result: string[] = [];
    for (let i = 0; i < fileStates.length; i++) {
      if (fileStates[i] !== F_DONE) {
        result.push(files[i]);
      }
    }
    return (this._changedFiles = result);
  }

  /**
   * Get the xxHash3-128 digest for the file at the given index.
   *
   * Returns a **16-byte zero-copy view** into the internal entries buffer.
   * The returned `Uint8Array` shares memory with internal state — do not
   * mutate or retain it beyond the current tick. Returns `null` when the
   * index is out of range or the entries buffer has not been populated yet.
   *
   * **You must call {@link complete}, {@link serialize}, or run a
   * {@link validate} cycle before this method returns meaningful data.**
   * Before completion the entries buffer is not allocated and this returns
   * `null`. After completion, files that could not be hashed (e.g. deleted)
   * will have all-zero bytes in the hash slot.
   *
   * Hashes are also available for unchanged files immediately after a
   * successful {@link validate} — their hashes are read from the cache file
   * and no extra {@link complete} call is needed.
   *
   * @param index  Zero-based index into the list returned by {@link currentFiles}.
   * @returns 16-byte hash `Uint8Array`, or `null` if not available.
   */
  public getFileHash(index: number): Uint8Array | null {
    const buf = this._entriesBuf;
    if (!buf || index >>> 0 >= this._fileCount) {
      return null;
    }
    const off = (index >>> 0) * ENTRY_STRIDE + 32;
    return new Uint8Array(buf.buffer, buf.byteOffset + off, 16);
  }

  /**
   * Complete all pending file hashing.
   *
   * Finishes stat + hash work for every file not yet resolved by
   * {@link validate}. Idempotent — safe to call multiple times.
   *
   * After this resolves, {@link getFileHash} returns populated hashes for
   * all files and {@link getChangedFiles} returns without doing any I/O.
   *
   * Also called internally by {@link serialize}.
   *
   * @throws If disposed.
   */
  public async complete(): Promise<void> {
    const flags = this._flags;
    if (flags & (FL_COMPLETED | FL_DISPOSED)) {
      if (flags & FL_COMPLETED) {
        return;
      }
      throw new Error("FileHashCache: already disposed");
    }
    this._flags = flags | FL_COMPLETED;

    const n = this._fileCount;
    if (n === 0) {
      return;
    }

    // No file list configured — nothing to complete.
    if (!this._files && !this._pathsBuf) {
      return;
    }

    // Ensure entries buffer exists (cold path without prior validate).
    let entriesBuf = this._entriesBuf;
    let fileStates = this._fileStates;
    if (!entriesBuf) {
      entriesBuf = bufferAlloc(n * ENTRY_STRIDE);
      this._entriesBuf = entriesBuf;
    }
    if (!fileStates) {
      fileStates = new Uint8Array(n); // all F_NOT_CHECKED
      this._fileStates = fileStates;
    }

    await this._impl.completeEntries(this, entriesBuf, fileStates);
  }

  /**
   * Validate the cache file against the configured file list.
   *
   * Opens the cache file, reads the header, and validates:
   * 1. Magic, version, fingerprint
   * 2. File count and sorted paths
   * 3. Per-file stat comparison (exits early on first change)
   *
   * If {@link setFiles} was not called before validate, the file list
   * is read from the existing cache file itself.  If no valid cache
   * exists and no file list was provided, returns `false`.
   *
   * After validate, {@link read} can be used to read user data, and
   * {@link userValue0}–{@link userValue3} contain the header values
   * from the previous cycle.
   * Per-file state is tracked for {@link serialize} optimization.
   *
   * @returns `true` if the cache is valid (unchanged), `false` if invalid.
   * @throws If already validated/disposed.
   */
  public async validate(): Promise<boolean> {
    if (this._flags & FL_DISPOSED) {
      throw new Error("FileHashCache: already disposed");
    }
    if (this._fh || this._writeFh) {
      throw new Error("FileHashCache: validate() cannot be called again — instance is single-use");
    }

    // Reset completion state — validate rebuilds _entriesBuf and _fileStates from scratch.
    this._flags &= ~(FL_COMPLETED | FL_REMAPPED);
    this._changedFiles = null;
    this._oldFiles = null;
    this._oldPathsBuf = null;

    // Try to open and read old cache header + body.
    const old = await this._openAndReadOldCache();

    // Store the old cache's file list for oldFiles.
    if (old) {
      this._oldPathsBuf = old.pathsBuf;
    }

    let pathsBuf = this._pathsBuf;
    let n = this._fileCount;

    if (!this._files) {
      // No setFiles() — use the file list from the cache file itself.
      if (!old) {
        return false; // No cache, no file list — nothing to validate.
      }
      pathsBuf = old.pathsBuf;
      n = old.fileCount;
      this._pathsBuf = pathsBuf;
      this._fileCount = n;
    }

    if (n === 0) {
      if (old?.fh) {
        await safeClose(old.fh);
      }
      this._flags |= FL_COMPLETED;
      this._changedFiles = [];
      return true;
    }

    // Allocate entries + file states.
    const entriesBuf = bufferAlloc(n * ENTRY_STRIDE);
    const fileStates = new Uint8Array(n);
    this._entriesBuf = entriesBuf;
    this._fileStates = fileStates;

    if (!old) {
      // No valid old cache — return false (buffers allocated for serialize).
      return false;
    }

    // Ensure pathsBuf is materialized for the equality check.
    // getPathsBuf() lazily encodes when _pathsBuf is null (after setFiles).
    pathsBuf = this.getPathsBuf();

    // Check if paths match exactly.
    if (old.fileCount === n && old.pathsBuf.length === pathsBuf.length && old.pathsBuf.equals(pathsBuf)) {
      // Exact match — populate user values, set up file handle.
      this.userValue0 = old.userValue0;
      this.userValue1 = old.userValue1;
      this.userValue2 = old.userValue2;
      this.userValue3 = old.userValue3;
      this._fh = old.fh;
      old.fh = null; // Transfer ownership — prevent cleanup below.
      this.position = HEADER_SIZE + n * ENTRY_STRIDE + pathsBuf.length;

      return this._impl.statAndMatch(this, entriesBuf, old.entriesBuf, fileStates).then((unchanged) => {
        if (unchanged) {
          // All files matched — mark as fully complete so getChangedFiles()
          // and complete() skip the redundant stat pass.
          this._flags |= FL_COMPLETED;
          this._changedFiles = [];
        }
        return unchanged;
      });
    }

    // File list changed — remap old entries to speed up complete/serialize.
    this._impl.remapOldEntries(this, old.entriesBuf, old.pathsBuf, old.fileCount, entriesBuf, fileStates);

    // Close old handle (not reusable — different paths).
    if (old.fh) {
      await safeClose(old.fh);
    }

    return false;
  }

  /**
   * Read raw bytes from the cache file at the given position.
   *
   * Reads up to `buffer.length` bytes into `buffer`.
   * Does NOT advance {@link position}.
   *
   * @param buffer    Destination buffer.
   * @param position  Position to read from. Defaults to {@link position}.
   * @returns The number of bytes actually read. 0 if no file handle is open.
   */
  public async read(buffer: Buffer, position = this.position): Promise<number> {
    const fh = this._fh;
    if (!fh) {
      return 0;
    }
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, position);
    return bytesRead;
  }

  /**
   * Scatter-read: read multiple buffers from the cache file sequentially
   * starting at the given position.
   *
   * Equivalent to a single `readv` system call — more efficient than
   * multiple individual {@link read} calls.
   * Does NOT advance {@link position}.
   *
   * @param buffers   Array of destination buffers to fill sequentially.
   * @param position  Position to start reading from. Defaults to {@link position}.
   * @returns Total number of bytes read. 0 if no file handle is open.
   */
  public async readv(buffers: readonly Buffer[], position = this.position): Promise<number> {
    const fh = this._fh;
    if (!fh || buffers.length === 0) {
      return 0;
    }
    const { bytesRead } = await fh.readv(buffers as Buffer[], position);
    return bytesRead;
  }

  /**
   * Serialize and write a new cache file.
   *
   * If the file list is empty, deletes any existing cache file and
   * returns `"deleted"` — there is nothing to store.
   *
   * Leverages per-file state from {@link validate} to skip rehashing
   * files whose stat metadata has not changed.
   *
   * After serialize returns `"written"`, {@link write} can append user data.
   * {@link dispose} finalizes the cache file atomically.
   *
   * Sets {@link position} to the start of the user data area.
   *
   * @returns `"written"` on success, `"deleted"` when the file list is
   *          empty, or `"error"` if an I/O failure occurred.
   * @throws If serialize was already called.
   *         A file list must have been established via {@link setFiles}
   *         or {@link validate} (which reads it from the cache file).
   */
  public async serialize(): Promise<FileHashCacheSerializeResult> {
    if (this._flags & FL_DISPOSED) {
      throw new Error("FileHashCache: already disposed");
    }
    if (this._writeFh) {
      throw new Error("FileHashCache: serialize() cannot be called again — instance is single-use");
    }

    const n = this._fileCount;

    // Zero files — delete old cache.
    if (n === 0) {
      return this._deleteEmptyCacheFile();
    }

    // Complete all pending stat/hash work (idempotent).
    await this.complete();

    const entriesBuf = this._entriesBuf;
    if (!entriesBuf) {
      return "error";
    }

    // Lazily encode paths — guaranteed non-null when n > 0.
    const pathsBuf = this.getPathsBuf();
    const pathsLen = pathsBuf.length;
    const entriesLen = n * ENTRY_STRIDE;
    const totalLen = HEADER_SIZE + entriesLen + pathsLen;

    const headerBuf = this._buildHeader(n, pathsLen);
    await this._closeReadHandle();

    return this._atomicWriteOpen(headerBuf, totalLen, entriesBuf, pathsBuf);
  }

  /**
   * Write raw bytes to the output file at the given position.
   *
   * Requires a prior {@link serialize} call.
   * Does NOT advance {@link position}.
   *
   * @param data      Bytes to write.
   * @param position  Position to write at. Defaults to {@link position}.
   * @throws If serialize() has not been called.
   */
  public async write(data: Uint8Array, position = this.position): Promise<void> {
    const wfh = this._writeFh;
    if (!wfh) {
      throw new Error("FileHashCache: write() requires a prior serialize() call");
    }
    if (data.length > 0) {
      await wfh.write(data, 0, data.length, position);
    }
  }

  /**
   * Scatter-write: write multiple buffers to the output file sequentially
   * starting at the given position.
   *
   * Equivalent to a single `writev` system call — more efficient than
   * multiple individual {@link write} calls.
   * Does NOT advance {@link position}.
   *
   * @param buffers   Array of buffers to write sequentially.
   * @param position  Position to start writing at. Defaults to {@link position}.
   * @throws If serialize() has not been called.
   */
  public async writev(buffers: readonly Uint8Array[], position = this.position): Promise<void> {
    const wfh = this._writeFh;
    if (!wfh) {
      throw new Error("FileHashCache: writev() requires a prior serialize() call");
    }
    if (buffers.length > 0) {
      await wfh.writev(buffers as Uint8Array[], position);
    }
  }

  /**
   * Dispose the instance: close all handles and finalize any pending write.
   *
   * If {@link serialize} was called, the cache file is atomically
   * committed to disk.
   *
   * Safe to call multiple times. After dispose, no other methods
   * (except `currentFiles` / `oldFiles`) may be called.
   */
  public async dispose(): Promise<void> {
    if (this._flags & FL_DISPOSED) {
      return;
    }
    this._flags |= FL_DISPOSED;

    // Capture write state before clearing (re-entrant safe).
    const writeFh = this._writeFh;
    const writeTmpPath = this._writeTmpPath;
    const writeOutPath = this._writeOutPath;
    const readFh = this._fh;

    this._fh = null;
    this._writeFh = null;
    this._writeTmpPath = null;
    this._writeOutPath = null;

    // Close read handle first (Windows: can't rename over an open file).
    if (readFh) {
      await safeClose(readFh);
    }

    // Finalize write: close -> rename.
    if (writeFh) {
      await finalizeWrite(writeFh, writeTmpPath, writeOutPath);
    }
  }

  /** Async dispose — calls {@link dispose}. */
  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  /** Close the read file handle (best-effort, no throw). */
  private async _closeReadHandle(): Promise<void> {
    const fh = this._fh;
    if (fh) {
      this._fh = null;
      await safeClose(fh);
    }
  }

  /** Build a fresh 64-byte header buffer for serialization. */
  private _buildHeader(n: number, pathsLen: number): Uint8Array {
    // Allocate the Uint32Array directly — natively zeroed, no Buffer wrapper needed.
    // All targets are LE; u8 is a zero-copy Uint8Array view for fingerprint set.
    const u32 = new Uint32Array(HEADER_SIZE >>> 2);
    u32[H_MAGIC] = MAGIC;
    u32[H_VERSION] = this.version;
    u32[H_USER] = this.userValue0;
    u32[H_USER + 1] = this.userValue1;
    u32[H_USER + 2] = this.userValue2;
    u32[H_USER + 3] = this.userValue3;
    u32[H_FILE_COUNT] = n;
    u32[H_PATHS_LEN] = pathsLen;
    // Slots 12-15 stay zero. Overlay Uint8Array only for fingerprint set.
    const u8 = new Uint8Array(u32.buffer);
    u8.set(this._fingerprint ?? ZERO_FP, H_FINGERPRINT_BYTE);
    return u8;
  }

  /** Handle serialize() for an empty file list: close read handle + delete cache. */
  private async _deleteEmptyCacheFile(): Promise<FileHashCacheSerializeResult> {
    await this._closeReadHandle();
    await unlink(this.filePath).catch(noop);
    this._flags |= FL_COMPLETED;
    this._changedFiles = [];
    this.position = 0;
    return "deleted";
  }

  /**
   * Open a temp file, write header + entries + paths via writev,
   * truncate to exact size. Sets write handle state on success.
   */
  private async _atomicWriteOpen(
    headerBuf: Uint8Array,
    totalLen: number,
    entriesBuf: Buffer,
    pathsBuf: Buffer
  ): Promise<FileHashCacheSerializeResult> {
    const outPath = this.filePath;
    const tmp = `${outPath}.${process.pid}.tmp`;
    try {
      await mkdir(pathDirname(outPath), { recursive: true });
      const wfh = await open(tmp, "w");
      try {
        await wfh.writev([headerBuf, entriesBuf, pathsBuf]);
        await wfh.truncate(totalLen);
      } catch {
        await safeClose(wfh);
        await unlink(tmp).catch(noop);
        return "error";
      }
      this._writeFh = wfh;
      this._writeTmpPath = tmp;
      this._writeOutPath = outPath;
      this.position = totalLen;
      return "written";
    } catch {
      return "error";
    }
  }

  /**
   * Open the existing cache file, read the header + entries + paths,
   * and validate magic/version/fingerprint.
   *
   * On success, returns the old cache data (file handle, entries, paths,
   * user values).  The caller is responsible for closing `fh` if it
   * does not transfer ownership (set `result.fh = null` to prevent
   * auto-close in the finally block).
   *
   * @returns Parsed old cache data, or `null` if the cache file is
   *          missing, corrupt, or has incompatible magic/version/fingerprint.
   */
  private async _openAndReadOldCache(): Promise<{
    fh: FileHandle | null;
    fileCount: number;
    entriesBuf: Buffer;
    pathsBuf: Buffer;
    userValue0: number;
    userValue1: number;
    userValue2: number;
    userValue3: number;
  } | null> {
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.filePath, O_RD);
      const hdr = bufferAllocUnsafe(HEADER_SIZE);
      const { bytesRead } = await fh.read(hdr, 0, HEADER_SIZE, 0);
      if (bytesRead < HEADER_SIZE) {
        return null;
      }

      // Overlay a Uint32Array view for all header field reads.
      // Safe: pool allocations are 8-byte aligned (byteOffset % 4 === 0), all targets are LE.
      const u32 = new Uint32Array(hdr.buffer, hdr.byteOffset, HEADER_SIZE >>> 2);

      if (u32[H_MAGIC] !== MAGIC || u32[H_VERSION] !== this.version) {
        return null;
      }

      // Fingerprint check: null → fast 4×u32 compare (avoids JS→C boundary for the common case).
      // Non-null → native memcmp via Buffer.compare. H_FINGERPRINT_BYTE=28 → u32 slots 7-10.
      const fp = this._fingerprint;
      if (fp === null) {
        if (u32[7] !== 0 || u32[8] !== 0 || u32[9] !== 0 || u32[10] !== 0) {
          return null;
        }
      } else if (hdr.compare(fp, 0, 16, H_FINGERPRINT_BYTE, H_FINGERPRINT_BYTE + 16) !== 0) {
        return null;
      }

      const fileCount = u32[H_FILE_COUNT];
      if (fileCount === 0) {
        return null;
      }

      // Read old entries + paths section.
      const pathsLen = u32[H_PATHS_LEN];
      const entriesLen = fileCount * ENTRY_STRIDE;
      const bodyLen = entriesLen + pathsLen;
      const bodyBuf = bufferAllocUnsafe(bodyLen);
      const { bytesRead: bodyRead } = await fh.read(bodyBuf, 0, bodyLen, HEADER_SIZE);
      if (bodyRead < bodyLen) {
        return null;
      }

      const result = {
        fh: fh as FileHandle,
        fileCount,
        entriesBuf: bodyBuf.subarray(0, entriesLen) as Buffer,
        pathsBuf: bodyBuf.subarray(entriesLen, bodyLen) as Buffer,
        userValue0: u32[H_USER],
        userValue1: u32[H_USER + 1],
        userValue2: u32[H_USER + 2],
        userValue3: u32[H_USER + 3],
      };
      fh = undefined; // Transfer ownership — prevent finally from closing.
      return result;
    } catch {
      return null;
    } finally {
      if (fh) {
        await safeClose(fh);
      }
    }
  }
}
