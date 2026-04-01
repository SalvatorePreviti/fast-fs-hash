/**
 * fast-fs-hash — Blazing fast filesystem hashing library for Node.js.
 *
 * Uses XXH3-128 via a native C++ addon with SIMD acceleration.
 *
 * @example
 * ```ts
 * import { digestBuffer, hashToHex } from "fast-fs-hash";
 *
 * const digest = digestBuffer(myData);
 * console.log(hashToHex(digest));
 * ```
 *
 * @module
 */

import { hashesToHexArray, hashToHex } from "./functions";
import { binding } from "./init-native";
import { findCommonRootPath, normalizeFilePaths, toRelativePath } from "./utils";
import { XxHash128Stream } from "./XxHash128Stream";

export type { CacheStatus, FileHashCacheWriteOptions } from "./FileHashCache";
export { FileHashCache } from "./FileHashCache";
export type { FileHashCacheOptions, IXxHash128Functions } from "./public-types";
export { XxHash128Stream };

/**
 * Hash an entire binary buffer and return the 128-bit digest.
 * @param input The buffer to hash.
 */
export const digestBuffer: (input: Uint8Array) => Buffer = XxHash128Stream.digestBuffer;

/**
 * Hash a sub-range of a binary buffer and return the 128-bit digest.
 * @param input The buffer to hash.
 * @param offset Start offset in bytes.
 * @param length Number of bytes to hash. Defaults to the rest of the buffer.
 */
export const digestBufferRange: (input: Uint8Array, offset: number, length?: number) => Buffer =
  XxHash128Stream.digestBufferRange;

/**
 * Hash an entire binary buffer and write the digest into `out`.
 * @param input The buffer to hash.
 * @param out Destination buffer (must have at least 16 bytes from outOffset).
 * @param outOffset Byte offset into `out`. Default 0.
 */
export const digestBufferTo: <TOut extends Uint8Array = Buffer>(
  input: Uint8Array,
  out: TOut,
  outOffset?: number
) => TOut = XxHash128Stream.digestBufferTo;

/**
 * Hash a sub-range of a binary buffer and write the digest into `out`.
 * @param input The buffer to hash.
 * @param offset Start offset in bytes.
 * @param length Number of bytes to hash.
 * @param out Destination buffer.
 * @param outOffset Byte offset into `out`. Default 0.
 */
export const digestBufferRangeTo: <TOut extends Uint8Array = Buffer>(
  input: Uint8Array,
  offset: number,
  length: number,
  out: TOut,
  outOffset?: number
) => TOut = XxHash128Stream.digestBufferRangeTo;

/**
 * Hash a UTF-8 string and return the 128-bit digest.
 * @param input The string to hash.
 */
export const digestString: (input: string) => Buffer = XxHash128Stream.digestString;

/**
 * Hash a UTF-8 string and write the digest into `out`.
 * @param input The string to hash.
 * @param out Destination buffer.
 * @param outOffset Byte offset into `out`. Default 0.
 */
export const digestStringTo: <TOut extends Uint8Array = Buffer>(input: string, out: TOut, outOffset?: number) => TOut =
  XxHash128Stream.digestStringTo;

/**
 * Read a file and return its 128-bit content hash.
 * @param path File path.
 * @param throwOnError If false, returns a zeroed digest on error. Default true.
 */
export const digestFile: (path: string, throwOnError?: boolean) => Promise<Buffer> = XxHash128Stream.digestFile;

/**
 * Read a file and write its 128-bit content hash into `out`.
 * @param path File path.
 * @param out Destination buffer.
 * @param outOffset Byte offset into `out`. Default 0.
 * @param throwOnError If false, writes a zeroed digest on error. Default true.
 */
export const digestFileTo: <TOut extends Uint8Array = Buffer>(
  path: string,
  out: TOut,
  outOffset?: number,
  throwOnError?: boolean
) => Promise<TOut> = XxHash128Stream.digestFileTo;

/**
 * Read multiple files sequentially and return the aggregate 128-bit digest.
 * @param paths Array of file paths.
 * @param throwOnError If false, skips unreadable files. Default true.
 */
export const digestFilesSequential: (paths: readonly string[], throwOnError?: boolean) => Promise<Buffer> =
  XxHash128Stream.digestFilesSequential;

/**
 * Read multiple files sequentially and write the aggregate digest into `out`.
 * @param paths Array of file paths.
 * @param out Destination buffer.
 * @param outOffset Byte offset into `out`. Default 0.
 * @param throwOnError If false, skips unreadable files. Default true.
 */
export const digestFilesSequentialTo: <TOut extends Uint8Array>(
  paths: readonly string[],
  out: TOut,
  outOffset?: number,
  throwOnError?: boolean
) => Promise<TOut> = XxHash128Stream.digestFilesSequentialTo;

/**
 * Read multiple files in parallel and return the aggregate 128-bit digest.
 * @param paths Array of file paths.
 * @param concurrency Max parallel reads. Default 8.
 * @param throwOnError If false, skips unreadable files. Default true.
 */
export const digestFilesParallel: (
  paths: readonly string[],
  concurrency?: number,
  throwOnError?: boolean
) => Promise<Buffer> = XxHash128Stream.digestFilesParallel;

/**
 * Read multiple files in parallel and write the aggregate digest into `out`.
 * @param paths Array of file paths.
 * @param out Destination buffer.
 * @param outOffset Byte offset into `out`. Default 0.
 * @param concurrency Max parallel reads. Default 8.
 * @param throwOnError If false, skips unreadable files. Default true.
 */
export const digestFilesParallelTo: <TOut extends Uint8Array>(
  paths: readonly string[],
  out: TOut,
  outOffset?: number,
  concurrency?: number,
  throwOnError?: boolean
) => Promise<TOut> = XxHash128Stream.digestFilesParallelTo;

/** Returns the maximum compressed size for a given input size. */
export const lz4CompressBound: (inputSize: number) => number = binding.lz4CompressBound;

/** Compress a buffer (synchronous, new allocation). */
export const lz4CompressBlock: (input: Uint8Array, offset?: number, length?: number) => Buffer =
  binding.lz4CompressBlock;

/** Compress into a pre-allocated output buffer (synchronous, zero-alloc). Returns bytes written. */
export const lz4CompressBlockTo: (
  input: Uint8Array,
  output: Uint8Array,
  outputOffset?: number,
  inputOffset?: number,
  inputLength?: number
) => number = binding.lz4CompressBlockTo;

/** Compress on a pool thread (asynchronous, non-blocking). */
export const lz4CompressBlockAsync: (input: Uint8Array, offset?: number, length?: number) => Promise<Buffer> =
  binding.lz4CompressBlockAsync;

/** Decompress LZ4 block data (synchronous, new allocation). `uncompressedSize` must match exactly. */
export const lz4DecompressBlock: (
  input: Uint8Array,
  uncompressedSize: number,
  offset?: number,
  length?: number
) => Buffer = binding.lz4DecompressBlock;

/** Decompress into a pre-allocated output buffer (synchronous, zero-alloc). Returns bytes written. */
export const lz4DecompressBlockTo: (
  input: Uint8Array,
  uncompressedSize: number,
  output: Uint8Array,
  outputOffset?: number,
  inputOffset?: number,
  inputLength?: number
) => number = binding.lz4DecompressBlockTo;

/** Decompress on a pool thread (asynchronous, non-blocking). `uncompressedSize` must match exactly. */
export const lz4DecompressBlockAsync: (
  input: Uint8Array,
  uncompressedSize: number,
  offset?: number,
  length?: number
) => Promise<Buffer> = binding.lz4DecompressBlockAsync;

export { findCommonRootPath, hashesToHexArray, hashToHex, normalizeFilePaths, toRelativePath };
