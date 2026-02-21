/**
 * XXHash128Base — Abstract base class for xxHash3-128 streaming hashers.
 *
 * All core instance methods throw until a subclass `init()` patches
 * the prototypes with a working implementation (WASM or native).
 *
 * Higher-level methods ({@link updateFile}, {@link hashFiles})
 * are implemented here in terms of the core primitives and work automatically
 * once `init()` has been called on any subclass.
 *
 * @module
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { types as utilTypes } from "node:util";
import { decodeFilePaths } from "./functions";
import { bufferAlloc, notInitialized } from "./helpers";
import type { HashInput } from "./types";

const { isUint8Array } = utilTypes;

// ── Public types ─────────────────────────────────────────────────────────

/** Library backend status. */
export type XXHash128LibraryStatus = "native" | "wasm" | "not-initialized";

/** @internal — Constructor signature for XXHash128Base subclasses. */
export type XXHash128Ctor = new (seedLow: number, seedHigh: number) => XXHash128Base;

// ── XXHash128Base class ──────────────────────────────────────────────────

/**
 * Abstract base class for XXHash128 streaming hashers.
 *
 * Core methods (`update`, `digest`, `reset`) throw by default.
 * After a subclass `init()` call patches the prototypes, instances
 * created from any concrete subclass will work.
 *
 * **File hashing methods:**
 *
 * - {@link updateFile} — read one file and feed its **raw content** into
 *   the streaming state. Equivalent to `update(await readFile(path))`.
 *
 * - {@link updateFilesBulk} — hash many files in parallel using a
 *   **two-level scheme**: each file is hashed individually (XXH3-128,
 *   seed 0) to produce a 16-byte per-file hash; all per-file hashes are
 *   then concatenated in order and fed as one block into the streaming
 *   state. This enables multi-threaded I/O + hashing while keeping the
 *   aggregate deterministic.
 */
export abstract class XXHash128Base {
  /** @internal — Lower 32 bits of the seed. */
  protected _seedLow = 0;

  /** @internal — Upper 32 bits of the seed. */
  protected _seedHigh = 0;

  /**
   * Maximum number of parallel file reads for {@link hashFiles}.
   * `0` means auto-detect (uses hardware concurrency).
   */
  public concurrency = 0;

  /** Backend status — `'not-initialized'` until init is called. */
  public get libraryStatus(): XXHash128LibraryStatus {
    return "not-initialized";
  }

  // ── Static convenience ─────────────────────────────────────────────

  /**
   * One-shot xxHash3-128.
   *
   * Creates a temporary instance, feeds the input, and returns the digest.
   * Subclasses must override this with a concrete implementation.
   *
   * @param input       Data to hash (string, Buffer, or Uint8Array).
   * @param seedLow     Lower 32 bits of the 64-bit seed (default `0`).
   * @param seedHigh    Upper 32 bits of the 64-bit seed (default `0`).
   * @returns 16-byte Buffer containing the hash in big-endian canonical form.
   */
  public static hash(_input: HashInput, _seedLow = 0, _seedHigh = 0): Buffer {
    return notInitialized();
  }

  // ── Core instance methods (patched by subclass init) ───────────────

  /** Reset the hasher state (same seed). */
  public reset(): void {
    notInitialized();
  }

  /**
   * Feed data into the hasher.
   *
   * @param input       Data to feed (string, Buffer, or Uint8Array).
   * @param inputOffset Byte offset into the buffer.
   * @param inputLength Byte length to hash.
   */
  public update(_input: HashInput, _inputOffset?: number | undefined, _inputLength?: number | undefined): void {
    notInitialized();
  }

  /**
   * Compute the digest of all data fed so far.
   *
   * The hasher state is **not** reset — you can continue calling
   * {@link update} and {@link digest} for incremental snapshots.
   *
   * @returns 16-byte Buffer in big-endian canonical form.
   */
  public digest(): Buffer {
    return notInitialized();
  }

  /**
   * Write the 16-byte digest into an existing buffer.
   *
   * @param output       Destination Uint8Array (or Buffer).
   * @param outputOffset Byte offset to write at (default `0`).
   */
  public digestTo(output: Uint8Array, outputOffset?: number | undefined): void {
    const off = outputOffset ?? 0;
    if (off + 16 > output.byteLength) {
      throw new RangeError("digestTo: output buffer too small (need 16 bytes)");
    }
    output.set(this.digest(), off);
  }

  // ── Higher-level methods (use core primitives) ─────────────────────

  /**
   * Read a single file and feed its **raw content** directly into the hasher.
   *
   * Unlike {@link updateFilesBulk}, this does **not** compute a per-file hash.
   * The file bytes are fed directly into the streaming state, so:
   *
   * ```ts
   * await h.updateFile("a.txt");
   * // is equivalent to:
   * h.update(await readFile("a.txt"));
   * ```
   *
   * @param path  Path to the file to read.
   * @throws If the file cannot be read (ENOENT, EPERM, etc.).
   */
  public async updateFile(path: string): Promise<void> {
    const content = await fsReadFile(path);
    this.update(content);
  }

  /**
   * Hash files in parallel and feed per-file hashes into this hasher's state.
   *
   * **Two-level hashing:** Each file is hashed individually with XXH3-128
   * (seed 0) producing a 16-byte per-file hash. All per-file hashes are
   * then concatenated in order and fed as one contiguous block into
   * **this** instance's streaming state via {@link update}.
   *
   * This approach enables parallel file hashing (using {@link concurrency}
   * threads in the native backend) while keeping the aggregate deterministic
   * regardless of I/O scheduling.
   *
   * Files that cannot be read (ENOENT, EPERM, etc.) produce 16 zero bytes,
   * matching a zeroed hash slot.
   *
   * Uses {@link concurrency} to control parallelism (0 = auto).
   *
   * @param files File paths as `string[]` or a `Uint8Array` of
   *              null-terminated UTF-8 paths.
   * @returns `null` (no per-file output).
   */
  public async updateFilesBulk(files: Iterable<string> | Uint8Array): Promise<null>;

  /**
   * Hash files in parallel, feed per-file hashes into this hasher, and return
   * a newly allocated `Buffer` of all per-file hashes (N × 16 bytes).
   *
   * @param files    File paths.
   * @param allFiles Pass `true` to allocate and return per-file hashes.
   * @returns New `Buffer` of `N × 16` bytes.
   */
  public async updateFilesBulk(files: Iterable<string> | Uint8Array, allFiles: true): Promise<Buffer>;

  /**
   * Hash files in parallel, feed per-file hashes into this hasher, and write
   * per-file hashes into the provided buffer.
   *
   * @param files        File paths.
   * @param output       Destination buffer (Uint8Array or Buffer).
   * @param outputOffset Byte offset to start writing (default `0`).
   * @returns The same `output` buffer, typed generically.
   * @throws {RangeError} If the buffer is too small for `N × 16` bytes at the given offset.
   */
  public async updateFilesBulk<T extends Uint8Array>(
    files: Iterable<string> | Uint8Array,
    output: T,
    outputOffset?: number
  ): Promise<T>;

  /** Implementation. */
  public async updateFilesBulk(
    files: Iterable<string> | Uint8Array,
    allFilesOrOutput?: boolean | Uint8Array,
    outputOffset?: number
  ): Promise<Buffer | Uint8Array | null> {
    const paths = isUint8Array(files) ? decodeFilePaths(files) : Array.from(files);
    const fileCount = paths.length;

    if (fileCount === 0) {
      if (allFilesOrOutput === true) {
        return bufferAlloc(0);
      }
      if (allFilesOrOutput != null && typeof allFilesOrOutput === "object") {
        return allFilesOrOutput;
      }
      return null;
    }

    // Single contiguous buffer for all per-file hashes (N × 16 bytes, zero-init).
    const hashes = bufferAlloc(fileCount * 16);

    // Phase 1: Read all files in parallel (I/O-bound — use high concurrency).
    const ioLanes = Math.min(this.concurrency > 0 ? this.concurrency : 64, fileCount);
    const buffers = new Array<Buffer | null>(fileCount);
    let cursor = 0;
    const reader = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= fileCount) {
          break;
        }
        try {
          buffers[idx] = await fsReadFile(paths[idx]);
        } catch {
          // Unreadable files remain null → zero hash
        }
      }
    };
    const workers = new Array<Promise<void>>(ioLanes);
    for (let i = 0; i < ioLanes; i++) {
      workers[i] = reader();
    }
    await Promise.all(workers);

    // Phase 2: Hash all files synchronously with a single hasher instance.
    // Subclasses can override _hashFileBuffers for backend-specific optimizations.
    this._hashFileBuffers(buffers, hashes);

    // Feed all per-file hashes into this instance as one contiguous block.
    this.update(hashes, 0, fileCount * 16);

    // Return per-file hashes if requested.
    if (allFilesOrOutput === true) {
      return hashes;
    }
    if (allFilesOrOutput != null && typeof allFilesOrOutput === "object") {
      const off = outputOffset ?? 0;
      const needed = fileCount * 16;
      if (off + needed > allFilesOrOutput.byteLength) {
        throw new RangeError(
          `updateFilesBulk: output buffer too small (need ${needed} bytes at offset ${off}, have ${allFilesOrOutput.byteLength})`
        );
      }
      allFilesOrOutput.set(hashes, off);
      return allFilesOrOutput;
    }
    return null;
  }

  // ── Internal batch-hash helper (overridden by WASM for direct access) ──

  /**
   * Hash an array of pre-read file buffers and write 16-byte per-file
   * hashes into the output array.
   *
   * The default implementation uses reset/update/digestTo.
   * The WASM backend patches this with a zero-GC version that accesses
   * WASM memory directly and skips state save/restore.
   *
   * @internal
   */
  public _hashFileBuffers(buffers: (Buffer | null)[], hashes: Uint8Array): void {
    const Ctor = this.constructor as unknown as XXHash128Ctor;
    const h = new Ctor(0, 0);
    for (let i = 0; i < buffers.length; i++) {
      const data = buffers[i];
      if (data != null) {
        h.reset();
        if (data.length > 0) {
          h.update(data, 0, data.length);
        }
        h.digestTo(hashes, i * 16);
      }
    }
  }
}
