/**
 * Native binding loader — loads the C++ addon at module init time.
 *
 * @module
 * @internal
 */

import { resolve } from "node:path";
import { DIST_DIR } from "./utils";

/** Shape of the native binding export. */
export interface BindingExportNative {
  digestBufferTo(input: Uint8Array, out: Uint8Array, outOffset?: number): Uint8Array;
  digestBufferRangeTo(
    input: Uint8Array,
    offset: number,
    length: number,
    out: Uint8Array,
    outOffset?: number
  ): Uint8Array;
  digestStringTo(input: string, out: Uint8Array, outOffset?: number): Uint8Array;
  digestFileTo<TOut extends Uint8Array = Buffer>(
    path: string,
    out: TOut,
    outOffset?: number,
    throwOnError?: boolean
  ): Promise<TOut>;
  encodedPathsDigestFilesParallelTo(
    pathsBuf: Uint8Array,
    concurrency: number,
    output: Uint8Array,
    outputOffset?: number,
    throwOnError?: boolean
  ): Promise<Uint8Array>;
  encodedPathsDigestFilesSequentialTo(
    pathsBuf: Uint8Array,
    output: Uint8Array,
    outputOffset?: number,
    throwOnError?: boolean
  ): Promise<Uint8Array>;
  streamAllocState(seedLow: number, seedHigh: number): object;
  streamReset(state: object, seedLow: number, seedHigh: number): void;
  streamAddBuffer(state: object, input: Uint8Array, offset?: number, length?: number): void;
  streamAddString(state: object, str: string): void;
  streamDigestTo(state: object, out: Uint8Array, offset?: number): Uint8Array;
  streamAddFile(state: object, path: string, throwOnError?: boolean): Promise<void>;
  streamAddFilesParallel(
    state: object,
    pathsBuf: Uint8Array,
    concurrency: number,
    throwOnError?: boolean
  ): Promise<void>;
  streamAddFilesSequential(state: object, pathsBuf: Uint8Array, throwOnError?: boolean): Promise<void>;
  streamClone(dst: object, src: object): void;
  cacheOpen(
    encodedPaths: Uint8Array,
    fileCount: number,
    cachePath: string,
    rootPath: string,
    version: number,
    fingerprint: Uint8Array | null,
    lockTimeoutMs: number,
    cancelBuf?: Uint8Array | null
  ): Promise<Buffer>;
  cacheWrite(
    dataBuf: Uint8Array,
    encodedPaths: Uint8Array | null,
    fileCount: number,
    cachePath: string,
    rootPath: string,
    userData: readonly Uint8Array[] | null | undefined,
    cancelBuf?: Uint8Array | null
  ): Promise<number>;
  cacheWriteNew(
    encodedPaths: Uint8Array,
    fileCount: number,
    cachePath: string,
    rootPath: string,
    version: number,
    fingerprint: Uint8Array | null,
    userValue0: number,
    userValue1: number,
    userValue2: number,
    userValue3: number,
    userData: readonly Uint8Array[] | null | undefined,
    lockTimeoutMs: number,
    cancelBuf?: Uint8Array | null
  ): Promise<number>;
  cacheClose(handle: number): void;
  cacheIsLocked(cachePath: string): boolean;
  cacheWaitUnlocked(cachePath: string, lockTimeoutMs?: number, cancelBuf?: Uint8Array | null): Promise<boolean>;
  poolTrim(): void;
  lz4CompressBlock(input: Uint8Array, offset?: number, length?: number): Buffer;
  lz4CompressBlockTo(
    input: Uint8Array,
    output: Uint8Array,
    outputOffset?: number,
    inputOffset?: number,
    inputLength?: number
  ): number;
  lz4CompressBlockAsync(input: Uint8Array, offset?: number, length?: number): Promise<Buffer>;
  lz4DecompressBlock(input: Uint8Array, uncompressedSize: number, offset?: number, length?: number): Buffer;
  lz4DecompressBlockTo(
    input: Uint8Array,
    uncompressedSize: number,
    output: Uint8Array,
    outputOffset?: number,
    inputOffset?: number,
    inputLength?: number
  ): number;
  lz4DecompressBlockAsync(
    input: Uint8Array,
    uncompressedSize: number,
    offset?: number,
    length?: number
  ): Promise<Buffer>;
  lz4CompressBound(inputSize: number): number;
  getCpuFeatures(): { avx2: boolean; avx512: boolean };
}

function loadBinding(): BindingExportNative {
  const { platform, arch } = process;
  const req = require("node:module").createRequire(resolve(DIST_DIR, "_"));
  const errors: string[] = [];

  const tryLoad = (
    id: string
  ): (BindingExportNative & { getCpuFeatures?: () => { avx2: boolean; avx512: boolean } }) | null => {
    try {
      return req(id);
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  // Build the list of candidate paths (baseline suffix "" always included)
  const candidates: string[] = [];

  const pkgBase = `@fast-fs-hash/fast-fs-hash-node-${platform}-${arch}`;
  if (platform === "linux") {
    const isMusl = !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header
      ?.glibcVersionRuntime;
    const libcs = isMusl ? ["musl", "gnu"] : ["gnu", "musl"];
    for (const libc of libcs) {
      candidates.push(`${pkgBase}-${libc}/fast_fs_hash.node`);
    }
  } else {
    const pkg = platform === "win32" ? `${pkgBase}-msvc` : pkgBase;
    candidates.push(`${pkg}/fast_fs_hash.node`);
  }
  candidates.push(resolve(DIST_DIR, "..", "build", "Release", "fast_fs_hash.node"));

  // Step 1: Load baseline (always safe — compiled for generic x64 / arm64)
  let baseline: ReturnType<typeof tryLoad> = null;
  for (const c of candidates) {
    baseline = tryLoad(c);
    if (baseline) {
      break;
    }
  }

  if (!baseline) {
    const details = errors.length > 0 ? errors.join("\n  - ") : "no candidates found";
    throw new Error(
      `fast-fs-hash: native binding unavailable. Ensure the correct platform-specific package is installed.\n  - ${details}`
    );
  }

  // Step 2: On x64, check CPU features and try loading an optimized variant
  if (arch === "x64") {
    // Environment variable override: FAST_FS_HASH_ISA=avx512|avx2|baseline
    const isaOverride = process.env.FAST_FS_HASH_ISA?.toLowerCase();
    let targetSuffix: string | undefined;

    if (isaOverride === "baseline") {
      return baseline;
    }
    if (isaOverride === "avx512") {
      targetSuffix = "_avx512";
    } else if (isaOverride === "avx2") {
      targetSuffix = "_avx2";
    } else {
      // Auto-detect via native CPUID (reliable, cross-platform, no file I/O)
      const features = baseline.getCpuFeatures?.();
      if (features?.avx512) {
        targetSuffix = "_avx512";
      } else if (features?.avx2) {
        targetSuffix = "_avx2";
      }
    }

    if (targetSuffix) {
      // Try loading the optimized variant from the same candidate paths
      for (const c of candidates) {
        const optimized = tryLoad(c.replace(/\.node$/, `${targetSuffix}.node`));
        if (optimized) {
          return optimized;
        }
      }
      // Fall back to AVX2 if AVX-512 variant not found
      if (targetSuffix === "_avx512") {
        for (const c of candidates) {
          const optimized = tryLoad(c.replace(/\.node$/, "_avx2.node"));
          if (optimized) {
            return optimized;
          }
        }
      }
    }
  }

  return baseline;
}

export const binding = loadBinding();
