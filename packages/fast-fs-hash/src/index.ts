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

import type { XXHash128 } from "./xxhash128/xxhash128";
import type { XXHash128Wasm } from "./xxhash128/xxhash128-wasm";

export { FileHashCache } from "./file-cache/file-hash-cache";
export { FileHashCacheBase } from "./file-cache/file-hash-cache-base";
export { FileHashCacheWasm } from "./file-cache/file-hash-cache-wasm";
export type { FileHashCacheOptions, FileHashCacheSerializeResult } from "./file-cache/types";
export {
  decodeFilePaths,
  encodeFilePaths,
  HASH_SIZE,
  hashesToHexArray,
  hashToHex,
  iterateFilePaths,
} from "./functions";
export type { HashInput } from "./helpers";
export { XXHash128 } from "./xxhash128/xxhash128";
export type { HashFilesBulkOptions, HashFilesBulkOutputMode, XXHash128LibraryStatus } from "./xxhash128/xxhash128-base";
export { XXHash128Base } from "./xxhash128/xxhash128-base";
export { XXHash128Wasm } from "./xxhash128/xxhash128-wasm";

/** Any concrete XXHash128 hasher instance (native or WASM). */
export type XXHash128Hasher = XXHash128 | XXHash128Wasm;
