/**
 * Benchmark: static hash() on in-memory buffers — native vs WASM vs Node.js crypto md5.
 *
 * Tests three buffer sizes:
 * - Small   (1 KB)
 * - Medium  (64 KB)
 * - Large   (1 MB)
 */

import { createHash, randomBytes } from "node:crypto";
import { bench, describe } from "vitest";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";
import { XXHash128Wasm } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128-wasm";

function nodeCryptoMd5(data: Buffer): Buffer {
  return createHash("md5").update(data).digest();
}

describe("static hash() — in-memory buffer", async () => {
  await XXHash128.init();
  await XXHash128Wasm.init();

  const small = randomBytes(1024);
  const medium = randomBytes(64 * 1024);
  const large = randomBytes(1024 * 1024);

  //  - 1 KB

  describe("1 KB buffer", () => {
    bench("native XXH3-128", () => {
      XXHash128.hash(small);
    });

    bench("WASM XXH3-128", () => {
      XXHash128Wasm.hash(small);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5(small);
    });
  });

  //  - 64 KB

  describe("64 KB buffer", () => {
    bench("native XXH3-128", () => {
      XXHash128.hash(medium);
    });

    bench("WASM XXH3-128", () => {
      XXHash128Wasm.hash(medium);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5(medium);
    });
  });

  //  - 1 MB

  describe("1 MB buffer", () => {
    bench("native XXH3-128", () => {
      XXHash128.hash(large);
    });

    bench("WASM XXH3-128", () => {
      XXHash128Wasm.hash(large);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5(large);
    });
  });
});
