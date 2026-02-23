/**
 *
 * Tests three file sizes from the raw-data fixtures:
 * - Small  (~1 KB)
 * - Medium (~50 KB)
 * - Large  (~200 KB+)
 *
 * Uses deterministic fixture files in test/bench/raw-data/.
 *
 * Run `npm run build:all` before benchmarking to ensure the compiled output is up to date.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

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

describe("digestFile (single file)", async () => {
  const { files } = generate();

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
      await native.digestFile(small.file);
    });

    bench("Node.js crypto (md5)", async () => {
      await nodeCryptoHashFile(small.file);
    });
  });

  //  - Medium file

  describe(`medium file (~${(medium.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await native.digestFile(medium.file);
    });

    bench("Node.js crypto (md5)", async () => {
      await nodeCryptoHashFile(medium.file);
    });
  });

  //  - Large file

  describe(`large file (~${(large.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await native.digestFile(large.file);
    });

    bench("Node.js crypto (md5)", async () => {
      await nodeCryptoHashFile(large.file);
    });
  });
});
