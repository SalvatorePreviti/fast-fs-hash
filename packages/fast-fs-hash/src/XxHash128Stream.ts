/**
 * XxHash128Stream — streaming and one-shot xxHash3-128 hashing.
 *
 * Supports incremental (streaming) hashing via instance methods and
 * one-shot hashing via static methods. All hashing is performed by
 * the native C++ addon with SIMD acceleration.
 *
 * @module
 */

import { bufferAllocUnsafe, effectiveConcurrency, encodeFilePaths } from "./functions";
import { binding } from "./init-native";
import { resolvedPromise } from "./utils";

const {
  digestBufferTo,
  digestBufferRangeTo,
  digestStringTo,
  digestFileTo,
  encodedPathsDigestFilesParallelTo,
  encodedPathsDigestFilesSequentialTo,
  streamAllocState,
  streamReset,
  streamAddBuffer,
  streamAddString,
  streamDigestTo,
  streamAddFile,
  streamAddFilesParallel,
  streamAddFilesSequential,
  streamClone,
} = binding;

/**
 * Streaming (incremental) and one-shot xxHash3-128 hasher.
 *
 * **Streaming usage:** create an instance, feed data via `addBuffer`, `addString`,
 * `addFile`, etc., then call `digest()` to finalize.
 *
 * **One-shot usage:** call static methods like `XxHash128Stream.digestBuffer(data)`
 * or `XxHash128Stream.hash(input)` directly.
 *
 * **Concurrency warning:** instance methods are **not** thread-safe. Do not call
 * any method while an async operation (`addFile`, `addFiles`, `addFilesParallel`)
 * is pending. Always `await` each async call before invoking another method.
 *
 * @example
 * ```ts
 * // Streaming
 * const h = new XxHash128Stream();
 * h.addString("hello ");
 * h.addBuffer(Buffer.from("world"));
 * console.log(h.digest().toString("hex"));
 *
 * // One-shot
 * const hash = XxHash128Stream.digestBuffer(myData);
 * ```
 */
export class XxHash128Stream {
  /** Lower 32 bits of the 64-bit seed. */
  public seedLow: number;

  /** Upper 32 bits of the 64-bit seed. */
  public seedHigh: number;

  #state: object;

  /**
   * Creates a new streaming hash instance with an optional 64-bit seed.
   *
   * @param seedLow Lower 32 bits of the 64-bit seed. Default: `0`.
   * @param seedHigh Upper 32 bits of the 64-bit seed. Default: `0`.
   */
  public constructor(seedLow = 0, seedHigh = 0) {
    this.seedLow = seedLow;
    this.seedHigh = seedHigh;
    this.#state = streamAllocState(seedLow, seedHigh);
  }

  /** Feeds an entire binary buffer into the running hash state. */
  public addBuffer(input: Uint8Array): void {
    streamAddBuffer(this.#state, input);
  }

  /**
   * Feeds a subrange of a binary buffer into the running hash state.
   *
   * @param input Binary data.
   * @param offset Starting byte offset.
   * @param length Number of bytes. If omitted, feeds to end of buffer.
   */
  public addBufferRange(input: Uint8Array, offset: number, length?: number): void {
    streamAddBuffer(this.#state, input, offset, length);
  }

  /** Feeds a UTF-8 string into the running hash state. */
  public addString(input: string): void {
    streamAddString(this.#state, input);
  }

  /**
   * Reads a single file and feeds its content into the running hash state.
   *
   * @param path File path.
   * @param throwOnError If `true` (default), rejects on I/O error. If `false`, silently skips.
   */
  public addFile(path: string, throwOnError = true): Promise<void> {
    return streamAddFile(this.#state, path, throwOnError);
  }

  /**
   * Reads multiple files sequentially and feeds each into the running hash state.
   *
   * @param paths Array of file paths.
   * @param throwOnError If `true` (default), rejects on I/O error. If `false`, silently skips.
   */
  public addFiles(paths: readonly string[], throwOnError = true): Promise<void> {
    if (paths.length === 0) {
      return resolvedPromise();
    }
    return streamAddFilesSequential(this.#state, encodeFilePaths(paths), throwOnError);
  }

  /**
   * Reads multiple files in parallel and feeds each into the running hash state.
   *
   * Per-file digests are computed in parallel and then fed into the stream in path-order.
   *
   * @param paths File paths.
   * @param concurrency Max concurrent I/O lanes (0 = default, max 8).
   * @param throwOnError If `true` (default), rejects on I/O error. If `false`, unreadable files produce a zero hash.
   */
  public addFilesParallel(paths: readonly string[], concurrency = 0, throwOnError = true): Promise<void> {
    const n = paths.length;
    if (n === 0) {
      return resolvedPromise();
    }
    return streamAddFilesParallel(
      this.#state,
      encodeFilePaths(paths),
      effectiveConcurrency(n, concurrency),
      throwOnError
    );
  }

  /**
   * Finalizes and returns the current 128-bit digest.
   * The internal state is **not** reset — calling `digest()` again without further feeds returns the same value.
   *
   * @returns A new 16-byte `Buffer` containing the digest.
   */
  public digest(): Buffer {
    return streamDigestTo(this.#state, bufferAllocUnsafe(16)) as Buffer;
  }

  /**
   * Finalizes and writes the 128-bit digest into an existing output buffer.
   *
   * @param out Destination buffer (>= 16 writable bytes at `outOffset`).
   * @param outOffset Byte offset in `out`. Default: `0`.
   * @returns The `out` buffer for convenience.
   */
  public digestTo<TOut extends Uint8Array = Buffer>(out: TOut, outOffset?: number): TOut {
    return streamDigestTo(this.#state, out, outOffset) as TOut;
  }

  /**
   * Resets the internal hash state, discarding all previously fed data.
   *
   * @param seedLow Lower 32 bits of the 64-bit seed. Default: the seed used at construction.
   * @param seedHigh Upper 32 bits of the 64-bit seed. Default: the seed used at construction.
   */
  public reset(seedLow?: number, seedHigh?: number): void {
    const sl = seedLow ?? this.seedLow;
    const sh = seedHigh ?? this.seedHigh;
    if (seedLow !== undefined) {
      this.seedLow = sl;
    }
    if (seedHigh !== undefined) {
      this.seedHigh = sh;
    }
    streamReset(this.#state, sl, sh);
  }

  /**
   * Returns a new independent stream with a copy of the current hash state.
   * The cloned stream shares no state with the original.
   */
  public clone(): XxHash128Stream {
    const copy = new XxHash128Stream(this.seedLow, this.seedHigh);
    streamClone(copy.#state, this.#state);
    return copy;
  }

  /**
   * One-shot: hash a buffer or string and return the 128-bit digest.
   *
   * @param input Binary data or string to hash.
   * @returns A new 16-byte `Buffer` containing the digest.
   */
  public static hash(input: Uint8Array | string): Buffer {
    const out = bufferAllocUnsafe(16);
    if (typeof input === "string") {
      digestStringTo(input, out);
    } else {
      digestBufferTo(input, out);
    }
    return out as Buffer;
  }

  /** Hashes an entire binary buffer and returns the 128-bit digest. */
  public static digestBuffer(input: Uint8Array): Buffer {
    return digestBufferTo(input, bufferAllocUnsafe(16)) as Buffer;
  }

  /** Hashes a sub-range of a binary buffer and returns the 128-bit digest. */
  public static digestBufferRange(input: Uint8Array, offset: number, length?: number): Buffer {
    return digestBufferRangeTo(
      input,
      offset,
      length !== undefined ? length : input.byteLength - offset,
      bufferAllocUnsafe(16)
    ) as Buffer;
  }

  /** Hashes an entire binary buffer and writes the digest into `out`. */
  public static digestBufferTo<TOut extends Uint8Array = Buffer>(
    input: Uint8Array,
    out: TOut,
    outOffset?: number
  ): TOut {
    return digestBufferTo(input, out, outOffset) as TOut;
  }

  /** Hashes a sub-range of a binary buffer and writes the digest into `out`. */
  public static digestBufferRangeTo<TOut extends Uint8Array = Buffer>(
    input: Uint8Array,
    offset: number,
    length: number,
    out: TOut,
    outOffset?: number
  ): TOut {
    return digestBufferRangeTo(input, offset, length, out, outOffset) as TOut;
  }

  /** Hashes a UTF-8 string and returns the 128-bit digest. */
  public static digestString(input: string): Buffer {
    return digestStringTo(input, bufferAllocUnsafe(16)) as Buffer;
  }

  /** Hashes a UTF-8 string and writes the digest into `out`. */
  public static digestStringTo<TOut extends Uint8Array = Buffer>(input: string, out: TOut, outOffset?: number): TOut {
    return digestStringTo(input, out, outOffset) as TOut;
  }

  /** Reads a file and returns its 128-bit content hash. */
  public static digestFile(path: string, throwOnError?: boolean): Promise<Buffer> {
    return digestFileTo(path, bufferAllocUnsafe(16), undefined, throwOnError) as Promise<Buffer>;
  }

  /** Reads a file and writes its 128-bit content hash into `out`. */
  public static digestFileTo<TOut extends Uint8Array = Buffer>(
    path: string,
    out: TOut,
    outOffset?: number,
    throwOnError?: boolean
  ): Promise<TOut> {
    return digestFileTo(path, out, outOffset, throwOnError);
  }

  /** Reads multiple files sequentially and returns the aggregate 128-bit digest. */
  public static digestFilesSequential(paths: readonly string[], throwOnError?: boolean): Promise<Buffer> {
    return encodedPathsDigestFilesSequentialTo(
      encodeFilePaths(paths),
      bufferAllocUnsafe(16),
      undefined,
      throwOnError
    ) as Promise<Buffer>;
  }

  /** Reads multiple files sequentially and writes the aggregate digest into `out`. */
  public static digestFilesSequentialTo<TOut extends Uint8Array>(
    paths: readonly string[],
    out: TOut,
    outOffset?: number,
    throwOnError?: boolean
  ): Promise<TOut> {
    return encodedPathsDigestFilesSequentialTo(encodeFilePaths(paths), out, outOffset, throwOnError) as Promise<TOut>;
  }

  /** Reads multiple files in parallel and returns the aggregate 128-bit digest. */
  public static digestFilesParallel(
    paths: readonly string[],
    concurrency = 0,
    throwOnError?: boolean
  ): Promise<Buffer> {
    return encodedPathsDigestFilesParallelTo(
      encodeFilePaths(paths),
      effectiveConcurrency(paths.length, concurrency),
      bufferAllocUnsafe(16),
      undefined,
      throwOnError
    ) as Promise<Buffer>;
  }

  /** Reads multiple files in parallel and writes the aggregate digest into `out`. */
  public static digestFilesParallelTo<TOut extends Uint8Array>(
    paths: readonly string[],
    out: TOut,
    outOffset?: number,
    concurrency = 0,
    throwOnError?: boolean
  ): Promise<TOut> {
    return encodedPathsDigestFilesParallelTo(
      encodeFilePaths(paths),
      effectiveConcurrency(paths.length, concurrency),
      out,
      outOffset,
      throwOnError
    ) as Promise<TOut>;
  }
}
