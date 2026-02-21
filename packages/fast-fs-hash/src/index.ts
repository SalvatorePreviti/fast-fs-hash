/**
 * fast-fs-hash — Blazing fast filesystem hashing library for Node.js.
 *
 * Uses XXH3-128 via a native C++ addon (with SIMD acceleration)
 * or a WASM fallback.
 *
 * @example
 * ```ts
 * import { XXHash128 } from "fast-fs-hash";
 *
 * await XXHash128.init();
 *
 * const h = new XXHash128();
 * await h.updateFilesBulk(["/src/index.ts", "/src/utils.ts"], true);
 * console.log(h.digest().toString("hex"));
 * ```
 *
 * @module
 */

export { decodeFilePaths, encodeFilePaths, hashesToHexArray } from "./functions";
export type { HashInput } from "./types";
export { XXHash128 } from "./xxhash128";
export type { XXHash128LibraryStatus } from "./xxhash128-base";
export { XXHash128Base } from "./xxhash128-base";
export { XXHash128Wasm } from "./xxhash128-wasm";
