/**
 * Benchmark: FileHashCache update — cold write (no existing cache).
 *
 * Each iteration deletes the cache file first, then runs a full
 * update from scratch (stat + hash every file).
 *
 * Uses the same raw-data fixtures as hashfiles.bench.ts (~705 files).
 */

import { unlinkSync } from "node:fs";
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

describe("FileHashCache — no existing cache", async () => {
  const { files, cacheDir } = generate();

  // Warmup
  const warmupCp = cp(cacheDir, "warmup");
  {
    const cache = new FileHashCache({ cachePath: warmupCp, files, rootPath: RAW_DATA_DIR });
    using session = await cache.open();
    await session.write();
  }

  const benchCp = cp(cacheDir, "cold");
  const benchCache = new FileHashCache({ cachePath: benchCp, files, rootPath: RAW_DATA_DIR });

  bench(
    "native  no existing cache",
    async () => {
      try {
        unlinkSync(benchCp);
      } catch {}
      benchCache.invalidateAll();
      using session = await benchCache.open();
      await session.write();
    },
    { warmupIterations: 1, throws: true }
  );
});
