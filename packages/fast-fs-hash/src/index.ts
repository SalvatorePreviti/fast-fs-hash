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

import { homedir } from "node:os";
import { hashesToHexArray, hashToHex } from "./functions";
import { binding } from "./init-native";
import type { ProjectRoot } from "./public-types";
import { findCommonRootPath, normalizeFilePaths, toRelativePath } from "./utils";
import { XxHash128Stream } from "./XxHash128Stream";

export type {
  CacheStatus,
  FileHashCacheConfigOptions,
  FileHashCacheEntries,
  FileHashCacheEntry,
  FileHashCacheOptions,
  FileHashCacheSession,
  FileHashCacheWriteOptions,
} from "./FileHashCache";
export { FileHashCache } from "./FileHashCache";
export type { IXxHash128Functions, ProjectRoot } from "./public-types";
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

/**
 * Returns the maximum compressed size for a given input size.
 * @param inputSize Uncompressed input size in bytes.
 */
export const lz4CompressBound: (inputSize: number) => number = binding.lz4CompressBound;

/**
 * Compress a buffer (synchronous, new allocation).
 * @param input Data to compress.
 * @param offset Start offset in bytes. Default 0.
 * @param length Number of bytes to compress. Default rest of buffer.
 */
export const lz4CompressBlock: (input: Uint8Array, offset?: number, length?: number) => Buffer =
  binding.lz4CompressBlock;

/**
 * Compress into a pre-allocated output buffer (synchronous, zero-alloc). Returns bytes written.
 * @param input Data to compress.
 * @param output Pre-allocated destination buffer.
 * @param outputOffset Byte offset into `output`. Default 0.
 * @param inputOffset Start offset in `input`. Default 0.
 * @param inputLength Number of bytes to compress from `input`. Default rest of buffer.
 */
export const lz4CompressBlockTo: (
  input: Uint8Array,
  output: Uint8Array,
  outputOffset?: number,
  inputOffset?: number,
  inputLength?: number
) => number = binding.lz4CompressBlockTo;

/**
 * Compress on a pool thread (asynchronous, non-blocking).
 * @param input Data to compress.
 * @param offset Start offset in bytes. Default 0.
 * @param length Number of bytes to compress. Default rest of buffer.
 */
export const lz4CompressBlockAsync: (input: Uint8Array, offset?: number, length?: number) => Promise<Buffer> =
  binding.lz4CompressBlockAsync;

/**
 * Decompress LZ4 block data (synchronous, new allocation). `uncompressedSize` must match exactly.
 * @param input Compressed data.
 * @param uncompressedSize Expected decompressed size in bytes.
 * @param offset Start offset in `input`. Default 0.
 * @param length Number of compressed bytes. Default rest of buffer.
 */
export const lz4DecompressBlock: (
  input: Uint8Array,
  uncompressedSize: number,
  offset?: number,
  length?: number
) => Buffer = binding.lz4DecompressBlock;

/**
 * Decompress into a pre-allocated output buffer (synchronous, zero-alloc). Returns bytes written.
 * @param input Compressed data.
 * @param uncompressedSize Expected decompressed size in bytes.
 * @param output Pre-allocated destination buffer.
 * @param outputOffset Byte offset into `output`. Default 0.
 * @param inputOffset Start offset in `input`. Default 0.
 * @param inputLength Number of compressed bytes from `input`. Default rest of buffer.
 */
export const lz4DecompressBlockTo: (
  input: Uint8Array,
  uncompressedSize: number,
  output: Uint8Array,
  outputOffset?: number,
  inputOffset?: number,
  inputLength?: number
) => number = binding.lz4DecompressBlockTo;

/**
 * Decompress on a pool thread (asynchronous, non-blocking). `uncompressedSize` must match exactly.
 * @param input Compressed data.
 * @param uncompressedSize Expected decompressed size in bytes.
 * @param offset Start offset in `input`. Default 0.
 * @param length Number of compressed bytes. Default rest of buffer.
 */
export const lz4DecompressBlockAsync: (
  input: Uint8Array,
  uncompressedSize: number,
  offset?: number,
  length?: number
) => Promise<Buffer> = binding.lz4DecompressBlockAsync;

/**
 * Compare two files for byte-equality asynchronously on a pool thread.
 * Returns false if either file cannot be opened/read or if sizes differ.
 * @param pathA First file path.
 * @param pathB Second file path.
 */
export const filesEqual: (pathA: string, pathB: string) => Promise<boolean> = binding.filesEqual;

/**
 * Walk the parent chain from `startPath` and locate project markers:
 * `.git`, `package.json`, `tsconfig.json`, and `node_modules/`. For each
 * marker the result contains `nearest*` (first hit walking up) and `root*`
 * (last hit, bounded by the enclosing `.git`). Also reports `gitRoot`
 * (innermost, matching `git rev-parse --show-toplevel`) and `gitSuperRoot`
 * (outermost `.git` directory when nested in a submodule or worktree,
 * otherwise `null`).
 *
 * The walk stops at the filesystem root, at the user's home directory (or
 * any ancestor of it), at `stopPath` (same rule — if provided), and at a
 * depth cap of 128 (symlink-loop defense).
 *
 * Tolerant of missing paths and mid-walk stat errors — missing fields are
 * returned as `null` rather than throwing. If `startPath` doesn't exist, the
 * walk begins from its longest existing ancestor.
 *
 * Runs asynchronously on the compute thread pool.
 * @param startPath Starting path — may be a file or a directory.
 * @param stopPath Optional directory — if the walker reaches this path (or
 *   any strict ancestor of it), the walk stops without probing.
 */
export async function findProjectRoot(startPath: string, stopPath?: string): Promise<ProjectRoot> {
  return binding.findProjectRoot(startPath, homedir(), stopPath ?? "");
}

/**
 * Synchronous variant of {@link findProjectRoot}. Blocks the JS thread for
 * the duration of the walk (typically tens of microseconds on a warm
 * filesystem). Recommended for startup-time configuration and build tooling.
 * @param startPath Starting path — may be a file or a directory.
 * @param stopPath Optional directory — if the walker reaches this path (or
 *   any strict ancestor of it), the walk stops without probing.
 */
export function findProjectRootSync(startPath: string, stopPath?: string): ProjectRoot {
  return binding.findProjectRootSync(startPath, homedir(), stopPath ?? "");
}

/**
 * Hash a file and return the digest as a 32-character hex string.
 * Convenience wrapper around {@link digestFile} + {@link hashToHex}.
 * @param path File path.
 * @param throwOnError If false, returns an all-zero hex string on error. Default true.
 */
export async function digestFileToHex(path: string, throwOnError?: boolean): Promise<string> {
  return hashToHex(await XxHash128Stream.digestFile(path, throwOnError));
}

/**
 * Hash multiple files in parallel and return an array of 32-character hex strings.
 * Each string is the individual xxHash3-128 digest of the corresponding file.
 * @param paths Array of file paths.
 * @param concurrency Max parallel file reads. Default 8.
 * @param throwOnError If false, returns all-zero hex for unreadable files. Default true.
 */
export async function digestFilesToHexArray(
  paths: readonly string[],
  concurrency?: number,
  throwOnError?: boolean
): Promise<string[]> {
  const n = paths.length;
  if (n === 0) {
    return [];
  }
  const conc = concurrency && concurrency > 0 && concurrency <= 64 ? concurrency : 8;
  const result = new Array<string>(n);
  let i = 0;
  const run = async () => {
    while (i < n) {
      const idx = i++;
      result[idx] = hashToHex(await XxHash128Stream.digestFile(paths[idx], throwOnError));
    }
  };
  const workers = new Array(Math.min(conc, n));
  for (let w = 0; w < workers.length; w++) {
    workers[w] = run();
  }
  await Promise.all(workers);
  return result;
}

/**
 * Read a file and LZ4-block-compress it asynchronously on a pool thread.
 * Returns the compressed data and the original uncompressed size (needed for decompression).
 * Max file size: 512 MiB.
 * @param path File path.
 */
export const lz4ReadAndCompress: (path: string) => Promise<{ data: Buffer; uncompressedSize: number }> =
  binding.lz4ReadAndCompress;

/**
 * Decompress LZ4 data and write to a file asynchronously on a pool thread.
 * Creates parent directories if needed. The inverse of {@link lz4ReadAndCompress}.
 * @param compressedData LZ4-compressed data.
 * @param uncompressedSize Original uncompressed size (from lz4ReadAndCompress).
 * @param path Output file path.
 */
export const lz4DecompressAndWrite: (
  compressedData: Uint8Array,
  uncompressedSize: number,
  path: string
) => Promise<boolean> = binding.lz4DecompressAndWrite;

/**
 * Wake idle native pool threads so they can self-terminate and free memory.
 * Threads with pending work will continue running — this is not a shutdown.
 * Threads respawn automatically when new work arrives.
 */
export const threadPoolTrim: () => void = binding.poolTrim;

export { findCommonRootPath, hashesToHexArray, hashToHex, normalizeFilePaths, toRelativePath };
