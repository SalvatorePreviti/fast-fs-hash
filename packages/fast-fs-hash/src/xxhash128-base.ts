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
import { availableParallelism } from "node:os";
import { decodeFilePaths } from "./functions";
import { bufferAlloc, notInitialized } from "./helpers";
import type { HashInput } from "./types";

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
   * Read one or more files and feed their contents into the hasher.
   *
   * Files are processed **in the order given** so the resulting hash
   * is deterministic. When {@link concurrency} allows parallel reads,
   * files are read concurrently but fed in order. Files that cannot be
   * opened are silently skipped.
   *
   * @param path A single path or array of paths.
   * @returns The number of files successfully read and fed into the hasher.
   */
  public async updateFile(path: string | string[]): Promise<number> {
    const paths = typeof path === "string" ? [path] : path;
    if (paths.length === 0) {
      return 0;
    }

    const maxLanes = this.concurrency > 0 ? this.concurrency : availableParallelism();
    const lanes = Math.min(maxLanes, paths.length);

    // Read all files concurrently, storing contents.
    const results: (Buffer | null)[] = new Array<Buffer | null>(paths.length).fill(null);
    let cursor = 0;

    const reader = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= paths.length) {
          break;
        }
        try {
          results[idx] = await fsReadFile(paths[idx]);
        } catch {
          // Unreadable files remain null
        }
      }
    };

    const workers = new Array<Promise<void>>(lanes);
    for (let i = 0; i < lanes; i++) {
      workers[i] = reader();
    }
    await Promise.all(workers);

    // Feed in order, counting successes.
    let count = 0;
    for (let i = 0; i < paths.length; i++) {
      const data = results[i];
      if (data !== null) {
        if (data.length > 0) {
          this.update(data, 0, data.length);
        }
        count++;
      }
    }
    return count;
  }

  /**
   * Hash files and feed per-file hashes into this hasher's state.
   *
   * Each file is hashed individually (xxHash3-128, seed 0). The resulting
   * 16-byte per-file hash is then fed into **this** instance via
   * {@link update} as one contiguous block, so the combined digest
   * accumulates all files.
   *
   * Uses {@link concurrency} to control parallelism (0 = auto).
   *
   * @param files File paths as `string[]` or a `Uint8Array` of
   *              null-terminated UTF-8 paths.
   * @returns `null` (no per-file output).
   */
  public async hashFiles(files: string[] | Uint8Array): Promise<null>;

  /**
   * Hash files, feed per-file hashes into this hasher, and return
   * a newly allocated `Buffer` of all per-file hashes (N × 16 bytes).
   *
   * @param files    File paths.
   * @param allFiles Pass `true` to allocate and return per-file hashes.
   * @returns New `Buffer` of `N × 16` bytes.
   */
  public async hashFiles(files: string[] | Uint8Array, allFiles: true): Promise<Buffer>;

  /**
   * Hash files, feed per-file hashes into this hasher, and write
   * per-file hashes into the provided buffer.
   *
   * @param files        File paths.
   * @param output       Destination buffer (Uint8Array or Buffer).
   * @param outputOffset Byte offset to start writing (default `0`).
   * @returns The same `output` buffer, typed generically.
   * @throws {RangeError} If the buffer is too small for `N × 16` bytes at the given offset.
   */
  public async hashFiles<T extends Uint8Array>(
    files: string[] | Uint8Array,
    output: T,
    outputOffset?: number
  ): Promise<T>;

  /** Implementation. */
  public async hashFiles(
    files: string[] | Uint8Array,
    allFilesOrOutput?: boolean | Uint8Array,
    outputOffset?: number
  ): Promise<Buffer | Uint8Array | null> {
    const paths = Array.isArray(files) ? files : decodeFilePaths(files);
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

    // Hash each file individually using parallel workers.
    // Each worker reuses ONE hasher instance (reset between files) to avoid
    // creating hundreds of WASM/native instances.
    const Ctor = this.constructor as unknown as XXHash128Ctor;
    const maxLanes = this.concurrency > 0 ? this.concurrency : availableParallelism();
    const lanes = Math.min(maxLanes, fileCount);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      const h = new Ctor(0, 0);
      for (;;) {
        const idx = cursor++;
        if (idx >= fileCount) {
          break;
        }
        try {
          const data = await fsReadFile(paths[idx]);
          h.reset();
          if (data.length > 0) {
            h.update(data, 0, data.length);
          }
          h.digestTo(hashes, idx * 16);
        } catch {
          // Slot remains zeroed — unreadable files get zero hash
        }
      }
    };

    const workers = new Array<Promise<void>>(lanes);
    for (let i = 0; i < lanes; i++) {
      workers[i] = worker();
    }
    await Promise.all(workers);

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
          `hashFiles: output buffer too small (need ${needed} bytes at offset ${off}, have ${allFilesOrOutput.byteLength})`
        );
      }
      allFilesOrOutput.set(hashes, off);
      return allFilesOrOutput;
    }
    return null;
  }
}
