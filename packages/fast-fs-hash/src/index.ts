/**
 * fast-fs-hash — Blazing fast filesystem hashing library for Node.js.
 *
 * Uses XXH3-128 via a native C++ addon (with SIMD acceleration)
 * or a WASM fallback.
 *
 * @example
 * ```ts
 * import { XXHash128, hashToHex } from "fast-fs-hash";
 *
 * await XXHash128.init();
 *
 * const digest = await XXHash128.hashFilesBulk({
 *   files: ["/src/index.ts", "/src/utils.ts"],
 * });
 * console.log(hashToHex(digest));
 * ```
 *
 * @module
 */

export { FileHashCache } from "./file-cache/file-hash-cache";
export { FileHashCacheManager } from "./file-cache/manager";
export type {
  FileHashCacheDataValue,
  FileHashCacheHeaderInfo,
  FileHashCacheManagerOptions,
  FileHashCacheValidateResult,
  FileHashCacheWriteOptions,
} from "./file-cache/types";
export { decodeFilePaths, encodeFilePaths, hashesToHexArray, hashToHex, iterateFilePaths } from "./functions";
export type { HashInput } from "./types";
export { XXHash128 } from "./xxhash128";
export type { HashFilesBulkOptions, HashFilesBulkOutputMode, XXHash128LibraryStatus } from "./xxhash128-base";
export { XXHash128Base } from "./xxhash128-base";
export { XXHash128Wasm } from "./xxhash128-wasm";
