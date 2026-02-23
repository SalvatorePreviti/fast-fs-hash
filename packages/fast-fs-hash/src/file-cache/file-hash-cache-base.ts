import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { decodeFilePaths, encodeFilePaths } from "../functions";
import { bufferAlloc, bufferAllocUnsafe, finalizeWrite, noop, safeClose } from "../helpers";
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

const O_RD = constants.O_RDONLY;

/**
 * Abstract base class for cache-file readers, validators, and writers.
 *
 * @example
 * ```ts
 * await FileHashCache.init();
 * await using cache = new FileHashCache(".cache/fsh", {
 *   version: 1, writable: true, fingerprint: myConfigHash,
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
  /** The file path this cache operates on. */
  public readonly filePath: string;

  /** Whether this instance can serialize (write) cache files. */
  public readonly writable: boolean;

  /** User-defined cache version. Mismatch rejects the cache immediately. */
  public readonly version: number;

  /** Backend library status: `"native"` or `"wasm"`. */
  public readonly libraryStatus: XXHash128LibraryStatus;

  /**
   * Current position for {@link read} / {@link write} operations.
   *
   * After a successful {@link validate}, points to the start of the
   * user data section. After {@link serialize}, points past the
   * internal metadata. Not auto-advanced by read/write.
   */
  public position = 0;

  /** Backend-specific stat+hash operations. @internal */
  private readonly _impl: FileHashCacheImpl;

  private readonly _fingerprint: Uint8Array | null = null;

  private _files: string[] | null = null;
  private _pathsBuf: Buffer | null = null;
  private _fileCount = 0;
  private _fh: FileHandle | null = null;
  private _writeFh: FileHandle | null = null;
  private _writeTmpPath: string | null = null;
  private _writeOutPath: string | null = null;
  private _disposed = false;

  /** New entries buffer (N × ENTRY_STRIDE), built by validate/serialize. */
  private _entriesBuf: Buffer | null = null;

  /** Per-file state flags (F_NOT_CHECKED / F_DONE / F_NEED_HASH / F_HAS_OLD). */
  private _fileStates: Uint8Array | null = null;

  /** Whether {@link complete} has been called (entries fully hashed). */
  private _completed = false;

  /** Cached result of {@link getChangedFiles} — reset to null whenever {@link _completed} resets. */
  private _changedFiles: readonly string[] | null = null;

  /**
   * @param filePath  Path to the cache file on disk.
   * @param options   Configuration (version, fingerprint, writable, seeds).
   * @param impl      Backend implementation for stat+hash operations.
   */
  protected constructor(filePath: string, options: FileHashCacheOptions | undefined, impl: FileHashCacheImpl) {
    this.filePath = filePath;
    this.writable = options?.writable ?? false;
    this.version = (options?.version ?? 0) >>> 0;
    this._impl = impl;
    this.libraryStatus = impl.libraryStatus;

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
   * Equal to the length of the array returned by {@link getFiles}.
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
   * Provided as a method to match the `getFiles` / `getChangedFiles` naming
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
   * Paths are sorted lexicographically and deduplicated.
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
   * @param files File paths to track.
   */
  public setFiles(files: Iterable<string>): void {
    const arr = Array.isArray(files) ? files.slice() : Array.from(files);
    arr.sort();
    // Deduplicate adjacent entries (already sorted).
    if (arr.length > 1) {
      let w = 1;
      for (let r = 1; r < arr.length; r++) {
        if (arr[r] !== arr[r - 1]) {
          arr[w++] = arr[r];
        }
      }
      arr.length = w;
    }

    // Fast-path: same list via string comparison — skip UTF-8 re-encoding entirely.
    // _files is non-null after any prior setFiles call; null only when the list was
    // loaded from a cache file (getFiles decodes it lazily).
    const oldFiles = this._files;
    if (oldFiles !== null && oldFiles.length === arr.length) {
      let same = true;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== oldFiles[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        this._files = arr;
        return;
      }
    }

    const newPathsBuf = arr.length > 0 ? encodeFilePaths(arr) : (bufferAlloc(0) as Buffer);

    // Fallback same-list check: _files was null (list from cache), compare encoded buffers.
    const oldPathsBuf = this._pathsBuf;
    if (
      oldPathsBuf &&
      this._fileCount === arr.length &&
      oldPathsBuf.length === newPathsBuf.length &&
      oldPathsBuf.equals(newPathsBuf)
    ) {
      this._files = arr;
      return;
    }

    // Try to remap in-memory validation state from a previous validate.
    const oldEntriesBuf = this._entriesBuf;
    const oldFileStates = this._fileStates;

    this._files = arr;
    this._pathsBuf = newPathsBuf;
    this._fileCount = arr.length;
    this._completed = false;
    this._changedFiles = null;

    if (oldEntriesBuf && oldFileStates && oldPathsBuf && arr.length > 0) {
      const oldCount = oldFileStates.length;
      const newCount = arr.length;

      // Different file list — remap only F_DONE entries (valid stat+hash).
      // Zero out non-F_DONE entries to prevent remapping partial/invalid data.
      for (let i = 0; i < oldCount; i++) {
        if (oldFileStates[i] !== F_DONE) {
          oldEntriesBuf.fill(0, i * ENTRY_STRIDE, (i + 1) * ENTRY_STRIDE);
        }
      }

      const newEntriesBuf = bufferAlloc(newCount * ENTRY_STRIDE);
      const newFileStates = new Uint8Array(newCount);
      this._impl.remapOldEntries(
        oldEntriesBuf,
        oldPathsBuf,
        oldCount,
        newEntriesBuf,
        newFileStates,
        newPathsBuf,
        newCount
      );

      this._entriesBuf = newEntriesBuf;
      this._fileStates = newFileStates;
    } else {
      this._entriesBuf = null;
      this._fileStates = null;
    }
  }

  /**
   * Get the current file list as a sorted, deduplicated array.
   *
   * Available throughout the full lifecycle: after {@link setFiles},
   * {@link validate}, {@link serialize}, and even after {@link dispose}.
   * Returns `[]` before any of those are called.
   *
   * The returned array is cached — repeated calls return the same reference
   * until the file list changes.
   *
   * @returns Sorted, deduplicated file paths. Empty array if no files
   *   have been configured via {@link setFiles} or loaded from a cache
   *   by {@link validate}.
   */
  public getFiles(): readonly string[] {
    let files = this._files;
    if (!files) {
      const pathsBuf = this._pathsBuf;
      if (!pathsBuf) {
        return [];
      }
      files = decodeFilePaths(pathsBuf) as string[];
      this._files = files;
    }
    return files;
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
   *   {@link getFiles} whose stat metadata or content hash differed from
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
    if (!this._completed) {
      return []; // not ready — call complete() or serialize() first
    }
    const fileStates = this._fileStates;
    if (!fileStates) {
      return (this._changedFiles = []);
    }
    let files = this._files;
    if (!files) {
      const pathsBuf = this._pathsBuf;
      if (!pathsBuf) {
        return (this._changedFiles = []);
      }
      files = decodeFilePaths(pathsBuf) as string[];
      this._files = files;
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
   * @param index  Zero-based index into the list returned by {@link getFiles}.
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
    if (this._completed) {
      return;
    }
    if (this._disposed) {
      throw new Error("FileHashCache: already disposed");
    }
    this._completed = true;

    const n = this._fileCount;
    if (n === 0) {
      return;
    }

    const pathsBuf = this._pathsBuf;
    if (!pathsBuf) {
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

    await this._impl.completeEntries(entriesBuf, fileStates, pathsBuf);
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
    if (this._disposed) {
      throw new Error("FileHashCache: already disposed");
    }
    if (this._fh || this._writeFh) {
      throw new Error("FileHashCache: validate() cannot be called again — instance is single-use");
    }

    // Reset completion state — validate rebuilds _entriesBuf and _fileStates from scratch.
    this._completed = false;
    this._changedFiles = null;

    // Try to open and read old cache header + body.
    const old = await this._openAndReadOldCache();

    let pathsBuf = this._pathsBuf;
    let n = this._fileCount;

    if (!pathsBuf) {
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
      this._completed = true;
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

      return this._impl.statAndMatch(entriesBuf, old.entriesBuf, fileStates, pathsBuf).then((unchanged) => {
        if (unchanged) {
          // All files matched — mark as fully complete so getChangedFiles()
          // and complete() skip the redundant stat pass.
          this._completed = true;
          this._changedFiles = [];
        }
        return unchanged;
      });
    }

    // File list changed — remap old entries to speed up serialize.
    if (this.writable) {
      this._impl.remapOldEntries(old.entriesBuf, old.pathsBuf, old.fileCount, entriesBuf, fileStates, pathsBuf, n);
    }

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
   * @throws If not in writable mode, or serialize was already called.
   *         A file list must have been established via {@link setFiles}
   *         or {@link validate} (which reads it from the cache file).
   */
  public async serialize(): Promise<FileHashCacheSerializeResult> {
    if (this._disposed) {
      throw new Error("FileHashCache: already disposed");
    }
    if (this._writeFh) {
      throw new Error("FileHashCache: serialize() cannot be called again — instance is single-use");
    }
    if (!this.writable) {
      throw new Error("FileHashCache: serialize() requires writable mode");
    }

    const n = this._fileCount;

    // Zero files — delete old cache.
    if (n === 0) {
      return this._deleteEmptyCacheFile();
    }

    // Complete all pending stat/hash work (idempotent).
    await this.complete();

    const entriesBuf = this._entriesBuf;
    const pathsBuf = this._pathsBuf;
    if (!entriesBuf || !pathsBuf) {
      return "error";
    }

    // Pre-encoded paths (guaranteed non-null when n > 0).
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
   * (except `getFiles`) may be called.
   */
  public async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

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
    u32[H_FILE_COUNT] = (n << 1) | (this.libraryStatus === "wasm" ? 1 : 0);
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
    this._completed = true;
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
      await mkdir(path.dirname(outPath), { recursive: true });
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

      const fileCount = u32[H_FILE_COUNT] >>> 1;
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
