/**
 * Benchmark: FileHashCache.writeNew — static write (hash all from scratch).
 *
 * writeNew skips reading/decompressing the old cache — it locks the file,
 * hashes every entry, LZ4-compresses, and writes. Useful when you already
 * know a full rebuild is needed.
 *
 * Uses the same raw-data fixtures as other benchmarks (~705 files).
 */

import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { bench, describe } from "vitest";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

const RAW_DATA_DIR = path.join(import.meta.dirname, "raw-data");

let counter = 0;
function cp(cacheDir: string, label: string): string {
  return path.join(cacheDir, `${label}-${++counter}.cache`);
}

describe("FileHashCache — writeNew", async () => {
  const { files, cacheDir } = generate();

  // Warmup
  const warmupCp = cp(cacheDir, "warmup");
  await FileHashCache.writeNew(warmupCp, RAW_DATA_DIR, files);

  // Seed a cache to overwrite
  const benchCp = cp(cacheDir, "writeNew");
  await FileHashCache.writeNew(benchCp, RAW_DATA_DIR, files);

  bench(
    "native  writeNew",
    async () => {
      await FileHashCache.writeNew(benchCp, RAW_DATA_DIR, files);
    },
    { warmupIterations: 1, throws: true }
  );
});
