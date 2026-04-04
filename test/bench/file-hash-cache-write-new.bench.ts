/**
 * Benchmark: FileHashCache.overwrite — write (hash all from scratch).
 *
 * overwrite skips reading/decompressing the old cache — it locks the file,
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

describe("FileHashCache — overwrite", async () => {
  const { files, cacheDir } = generate();

  const cacheInstance = new FileHashCache({ cachePath: cp(cacheDir, "overwrite"), files, rootPath: RAW_DATA_DIR });

  // Warmup
  await cacheInstance.overwrite();

  bench(
    "native  overwrite",
    async () => {
      await cacheInstance.overwrite();
    },
    { warmupIterations: 1, throws: true }
  );
});
