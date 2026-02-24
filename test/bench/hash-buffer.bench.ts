/**
 * Benchmark: static hashTo() on in-memory buffers — native vs WASM vs Node.js crypto md5.
 * All methods write into a pre-allocated output buffer so the comparison is fair
 * (no allocation overhead in the measured loop).
 *
 * Tests three buffer sizes:
 * - Small   (2 KB)
 * - Medium  (64 KB)
 * - Large   (1 MB)
 */

import { createHash, randomBytes } from "node:crypto";
import { bench, describe } from "vitest";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";
import { XXHash128Wasm } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128-wasm";

function nodeCryptoMd5To(data: Buffer, out: Buffer): void {
  createHash("md5").update(data).digest().copy(out);
}

describe("static hashTo() — in-memory buffer", async () => {
  await XXHash128.init();
  await XXHash128Wasm.init();

  const small = randomBytes(2048);
  const medium = randomBytes(64 * 1024);
  const large = randomBytes(1024 * 1024);
  const out = Buffer.alloc(16);

  describe("2 KB buffer", () => {
    bench("native XXH3-128", () => {
      XXHash128.hashTo(small, out);
    });

    bench("WASM XXH3-128", () => {
      XXHash128Wasm.hashTo(small, out);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5To(small, out);
    });
  });

  describe("64 KB buffer", () => {
    bench("native XXH3-128", () => {
      XXHash128.hashTo(medium, out);
    });

    bench("WASM XXH3-128", () => {
      XXHash128Wasm.hashTo(medium, out);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5To(medium, out);
    });
  });

  describe("1 MB buffer", () => {
    bench("native XXH3-128", () => {
      XXHash128.hashTo(large, out);
    });

    bench("WASM XXH3-128", () => {
      XXHash128Wasm.hashTo(large, out);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5To(large, out);
    });
  });
});
