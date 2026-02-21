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

export { decodeFilePaths, encodeFilePaths, hashesToHexArray, hashToHex } from "./functions";
export type { HashInput } from "./types";
export { XXHash128 } from "./xxhash128";
export type { XXHash128LibraryStatus, HashFilesBulkOptions, HashFilesBulkOutputMode } from "./xxhash128-base";
export { XXHash128Base } from "./xxhash128-base";
export { XXHash128Wasm } from "./xxhash128-wasm";
