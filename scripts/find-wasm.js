import { readFileSync, writeFileSync } from "node:fs";

const esm = readFileSync("node_modules/hash-wasm/dist/index.esm.js", "utf8");

// Find the xxhash128 block specifically
const re = /var name(\$\w+) = "(\w+)";\nvar data\1 = "([^"]+)";\nvar hash\1 = "([^"]+)"/g;
let m;
while ((m = re.exec(esm)) !== null) {
  if (m[2] === "xxhash128") {
    const b64 = m[3];
    console.log(`Found xxhash128: var${m[1]}, data.length=${b64.length}, hash="${m[4]}"`);
    console.log("Binary size:", Buffer.from(b64, "base64").length, "bytes");

    // Write wasm-data.ts
    const ts = `/**
 * XXHash128 WASM binary (xxHash3-128, base64-encoded).
 *
 * Extracted from hash-wasm (MIT, Copyright (c) 2020 Dani Biró).
 * The embedded C xxHash implementation is BSD 2-Clause (Copyright (c) 2012-2020 Yann Collet).
 *
 * WASM exports:
 *   Hash_GetBuffer(): number   — offset of the I/O buffer in WASM memory
 *   Hash_Init(): void          — reads 8-byte seed (LE u32 low + u32 high) from buffer, then resets state
 *   Hash_Update(len: number)   — hashes \`len\` bytes from the buffer
 *   Hash_Final(): void         — writes 16-byte digest (big-endian canonical) to the buffer
 *   Hash_GetState(): number    — offset of internal state (for save/load)
 *   STATE_SIZE: number         — size of internal state in bytes
 *
 * @internal
 */

// prettier-ignore
export const XXHASH128_WASM_BASE64 = "${b64}";
`;

    writeFileSync("packages/fast-fs-hash/src/wasm-data.ts", ts);
    console.log("Wrote packages/fast-fs-hash/src/wasm-data.ts");
    break;
  }
}
