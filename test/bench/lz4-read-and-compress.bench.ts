/**
 * Benchmark: lz4ReadAndCompress — native vs Node.js readFile + zlib deflate.
 *
 * Tests small, medium, and large files.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

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

async function nodeReadAndCompress(filePath: string): Promise<Buffer> {
  const data = await readFile(filePath);
  return deflateSync(data);
}

describe("lz4ReadAndCompress (file → compressed buffer)", async () => {
  const { files } = generate();

  const small = pickFileBySize(files, 1024);
  const medium = pickFileBySize(files, 50 * 1024);
  const large = pickFileBySize(files, 200 * 1024);

  // Pre-warm OS page cache
  await readFile(small.file);
  await readFile(medium.file);
  await readFile(large.file);

  describe(`small file (~${(small.size / 1024).toFixed(1)} KB)`, () => {
    bench("native lz4ReadAndCompress", async () => {
      await native.lz4ReadAndCompress(small.file);
    });

    bench("Node.js readFile + zlib deflate", async () => {
      await nodeReadAndCompress(small.file);
    });
  });

  describe(`medium file (~${(medium.size / 1024).toFixed(1)} KB)`, () => {
    bench("native lz4ReadAndCompress", async () => {
      await native.lz4ReadAndCompress(medium.file);
    });

    bench("Node.js readFile + zlib deflate", async () => {
      await nodeReadAndCompress(medium.file);
    });
  });

  describe(`large file (~${(large.size / 1024).toFixed(1)} KB)`, () => {
    bench("native lz4ReadAndCompress", async () => {
      await native.lz4ReadAndCompress(large.file);
    });

    bench("Node.js readFile + zlib deflate", async () => {
      await nodeReadAndCompress(large.file);
    });
  });
});
