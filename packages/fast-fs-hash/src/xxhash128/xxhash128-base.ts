import type { FileHandle } from "node:fs/promises";
import { readFile as fsReadFile } from "node:fs/promises";
import type { HashInput } from "../helpers";
import { notInitialized } from "../helpers";

/** Library backend status. */
export type XXHash128LibraryStatus = "native" | "wasm" | "not-initialized";

/** What to include in the output of {@link XXHash128Base.hashFilesBulk}. */
export type HashFilesBulkOutputMode = "all" | "digest" | "files";

/** Options for {@link XXHash128Base.hashFilesBulk}. */
export interface HashFilesBulkOptions {
  /** File paths as `string[]` or a `Uint8Array` of null-terminated UTF-8 paths. */
  files: Iterable<string> | Uint8Array;

  /**
   * What to include in the output buffer.
   *
   * - `"digest"` (default) — 16-byte aggregate digest only
   * - `"all"` — `[16-byte aggregate digest, N × 16-byte per-file hashes]`
   * - `"files"` — N × 16-byte per-file hashes only (no aggregate)
   */
  outputMode?: HashFilesBulkOutputMode;

  /** Max parallel threads. `0` (default) = auto (hardware concurrency). */
  concurrency?: number;

  /** Lower 32 bits of the 64-bit seed for the aggregate digest. Default: `0`. */
  seedLow?: number;

  /** Upper 32 bits of the 64-bit seed for the aggregate digest. Default: `0`. */
  seedHigh?: number;
}

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
  public constructor(
    /** Lower 32 bits of the seed. */
    public readonly seedLow = 0,
    /** Upper 32 bits of the seed. */
    public readonly seedHigh = 0,
    /**
     * Maximum number of parallel file reads for {@link updateFilesBulk}.
     * `0` means auto-detect (uses hardware concurrency).
     */
    public concurrency = 0
  ) {}

  /** Backend status — `'not-initialized'` until init is called. */
  public get libraryStatus(): XXHash128LibraryStatus {
    return "not-initialized";
  }

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

  /**
   * Hash many files in a single call.
   *
   * **This is the fastest way to hash a set of files.** Everything — parallel
   * file I/O, per-file hashing, and aggregate computation — runs off the
   * main thread in the native backend, so the JS thread is completely free
   * while the work executes.
   *
   * Output layout depends on {@link HashFilesBulkOptions.outputMode | outputMode}:
   * - `"digest"` (default): 16-byte aggregate only
   * - `"all"`: `[16-byte aggregate, N × 16-byte per-file hashes]`
   * - `"files"`: `N × 16`-byte per-file hashes only
   *
   * Use the instance method {@link updateFilesBulk} instead when you need to
   * combine file hashes with additional data (e.g. configuration strings)
   * before finalizing the digest.
   *
   * @param options  See {@link HashFilesBulkOptions}.
   * @returns A new `Buffer` containing the hash output.
   */
  public static async hashFilesBulk(_options: HashFilesBulkOptions): Promise<Buffer> {
    return notInitialized();
  }

  /**
   * Like {@link hashFilesBulk}, but writes results into a pre-allocated
   * output buffer instead of returning a new one.
   *
   * @param options       See {@link HashFilesBulkOptions}.
   * @param output        Destination buffer for the hash output.
   * @param outputOffset  Byte offset within `output` to start writing (default `0`).
   */
  public static async hashFilesBulkTo(
    _options: HashFilesBulkOptions,
    _output: Uint8Array,
    _outputOffset?: number
  ): Promise<void> {
    notInitialized();
  }

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

  /**
   * Hash a single file and return its 16-byte xxHash3-128 digest.
   *
   * Uses the instance’s seed. In the native backend this is overridden
   * with a standalone off-thread worker that does NOT touch the streaming state.
   *
   * @param filePath      Path to the file to hash.
   * @returns A new 16-byte `Buffer`.
   */
  public async hashFile(_filePath: string): Promise<Buffer> {
    return notInitialized();
  }

  /**
   * Hash a single file and return its 16-byte xxHash3-128 digest.
   *
   * Opens the file, reads its content, and hashes it in one operation.
   * In the native backend, all work happens off the main thread.
   *
   * @param filePath      Path to the file to hash.
   * @param seedLow       Lower 32 bits of the 64-bit seed (default `0`).
   * @param seedHigh      Upper 32 bits of the 64-bit seed (default `0`).
   * @param salt          Optional salt bytes prepended to the hash input.
   * @returns A new 16-byte `Buffer`.
   */
  public static async hashFile(
    _filePath: string,
    _seedLow?: number,
    _seedHigh?: number,
    _salt?: Uint8Array
  ): Promise<Buffer> {
    return notInitialized();
  }

  /**
   * Hash a single file and write its 16-byte digest into `output`.
   *
   * @param filePath      Path to the file to hash.
   * @param output        Destination buffer for the 16-byte digest.
   * @param outputOffset  Byte offset within `output` to write at (default `0`).
   * @param seedLow       Lower 32 bits of the 64-bit seed (default `0`).
   * @param seedHigh      Upper 32 bits of the 64-bit seed (default `0`).
   * @param salt          Optional salt bytes prepended to the hash input.
   */
  public static async hashFileTo(
    _filePath: string,
    _output: Uint8Array,
    _outputOffset?: number,
    _seedLow?: number,
    _seedHigh?: number,
    _salt?: Uint8Array
  ): Promise<void> {
    notInitialized();
  }

  /**
   * Hash a single file and write its 16-byte digest into `output`.
   *
   * Uses the instance’s seed.
   *
   * @param filePath      Path to the file to hash.
   * @param output        Destination buffer for the 16-byte digest.
   * @param outputOffset  Byte offset within `output` (default `0`).
   */
  public async hashFileTo(_filePath: string, _output: Uint8Array, _outputOffset?: number): Promise<void> {
    notInitialized();
  }

  /**
   * Hash an already-open file (instance seed) and return its 16-byte digest.
   *
   * Uses the instance’s seed.
   *
   * @param fh            Open FileHandle.
   * @returns A new 16-byte `Buffer`.
   */
  public async hashFileHandle(_fh: FileHandle): Promise<Buffer> {
    return notInitialized();
  }

  /**
   * Hash an already-open file and return a 16-byte xxHash3-128 digest.
   *
   * @param fh            Open FileHandle.
   * @param seedLow       Lower 32 bits of the 64-bit seed (default `0`).
   * @param seedHigh      Upper 32 bits of the 64-bit seed (default `0`).
   * @returns A new 16-byte `Buffer`.
   */
  public static async hashFileHandle(_fh: FileHandle, _seedLow?: number, _seedHigh?: number): Promise<Buffer> {
    return notInitialized();
  }

  /**
   * Hash an already-open file and write the 16-byte digest into `output`.
   *
   * @param fh            Open FileHandle.
   * @param output        Destination buffer for the 16-byte digest.
   * @param outputOffset  Byte offset within `output` to write at (default `0`).
   * @param seedLow       Lower 32 bits of the 64-bit seed (default `0`).
   * @param seedHigh      Upper 32 bits of the 64-bit seed (default `0`).
   */
  public static async hashFileHandleTo(
    _fh: FileHandle,
    _output: Uint8Array,
    _outputOffset?: number,
    _seedLow?: number,
    _seedHigh?: number
  ): Promise<void> {
    notInitialized();
  }

  /**
   * Hash an already-open file and write digest into `output`.
   *
   * Uses the instance’s seed.
   *
   * @param fh            Open FileHandle.
   * @param output        Destination buffer.
   * @param outputOffset  Byte offset.
   */
  public async hashFileHandleTo(_fh: FileHandle, _output: Uint8Array, _outputOffset?: number): Promise<void> {
    notInitialized();
  }

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

  /** Implementation — patched by backend init. */
  public async updateFilesBulk(_files: Iterable<string> | Uint8Array, _allFiles?: boolean): Promise<Buffer | null> {
    return notInitialized();
  }

  /**
   * Hash files in parallel, feed per-file hashes into this hasher, and write
   * per-file hashes into the provided output buffer.
   *
   * @param files        File paths.
   * @param output       Destination buffer (Uint8Array or Buffer).
   * @param outputOffset Byte offset to start writing (default `0`).
   * @throws {RangeError} If the buffer is too small for `N × 16` bytes at the given offset.
   */
  public async updateFilesBulkTo(
    _files: Iterable<string> | Uint8Array,
    _output: Uint8Array,
    _outputOffset?: number
  ): Promise<void> {
    notInitialized();
  }
}
