/**
 * Benchmark: single-file static hashFile — native vs WASM vs Node.js crypto.
 *
 * Tests three file sizes from the raw-data fixtures:
 * - Small  (~1 KB)
 * - Medium (~50 KB)
 * - Large  (~200 KB+)
 *
 * Uses deterministic fixture files in test/bench/raw-data/.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { bench, describe } from "vitest";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";
import { XXHash128Wasm } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128-wasm";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

/** Pick a file closest to a target size. */
function pickFileBySize(files: string[], targetBytes: number): { file: string; size: number } {
  let best = files[0];
  let bestDelta = Infinity;
  for (const f of files) {
    const sz = statSync(f).size;
    const delta = Math.abs(sz - targetBytes);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = f;
    }
  }
  return { file: best, size: statSync(best).size };
}

async function nodeCryptoHashFile(filePath: string): Promise<Buffer> {
  return createHash("md5")
    .update(await readFile(filePath))
    .digest();
}

describe("hashFile (static, single file)", async () => {
  const { files } = generate();
  await XXHash128.init();
  await XXHash128Wasm.init();

  const small = pickFileBySize(files, 1024);
  const medium = pickFileBySize(files, 50 * 1024);
  const large = pickFileBySize(files, 200 * 1024);

  // Pre-warm OS page cache for all three files.
  await readFile(small.file);
  await readFile(medium.file);
  await readFile(large.file);

  //  - Small file

  describe(`small file (~${(small.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await XXHash128.hashFile(small.file);
    });

    bench("WASM", async () => {
      await XXHash128Wasm.hashFile(small.file);
    });

    bench("Node.js crypto (md5)", async () => {
      await nodeCryptoHashFile(small.file);
    });
  });

  //  - Medium file

  describe(`medium file (~${(medium.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await XXHash128.hashFile(medium.file);
    });

    bench("WASM", async () => {
      await XXHash128Wasm.hashFile(medium.file);
    });

    bench("Node.js crypto (md5)", async () => {
      await nodeCryptoHashFile(medium.file);
    });
  });

  //  - Large file

  describe(`large file (~${(large.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await XXHash128.hashFile(large.file);
    });

    bench("WASM", async () => {
      await XXHash128Wasm.hashFile(large.file);
    });

    bench("Node.js crypto (md5)", async () => {
      await nodeCryptoHashFile(large.file);
    });
  });
});
