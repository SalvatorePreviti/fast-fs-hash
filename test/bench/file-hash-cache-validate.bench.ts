/**
 * Benchmark: FileHashCache update — nothing changed (hot path).
 *
 * The cache file is pre-seeded with valid data; each iteration opens
 * and stat-matches (all entries -> upToDate).
 *
 * Uses the same raw-data fixtures as hashfiles.bench.ts (~705 files).
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

describe("FileHashCache — no change", async () => {
  const { files, cacheDir } = generate();

  // Seed
  const seedCp = cp(cacheDir, "seed");
  {
    await using seedCtx = await FileHashCache.open(seedCp, RAW_DATA_DIR, files);
    await seedCtx.write();
  }

  const benchCp = cp(cacheDir, "unchanged");
  {
    await using seedCtx2 = await FileHashCache.open(benchCp, RAW_DATA_DIR, files);
    await seedCtx2.write();
  }

  bench(
    "native  no change",
    async () => {
      await using _ctx = await FileHashCache.open(benchCp, RAW_DATA_DIR, files);
    },
    { warmupIterations: 1, throws: true }
  );
});
