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
    const cache = new FileHashCache({ cachePath: seedCp, files, rootPath: RAW_DATA_DIR });
    await using session = await cache.open();
    await session.write();
  }

  const benchCp = cp(cacheDir, "unchanged");
  {
    const cache = new FileHashCache({ cachePath: benchCp, files, rootPath: RAW_DATA_DIR });
    await using session = await cache.open();
    await session.write();
  }

  const benchCache = new FileHashCache({ cachePath: benchCp, files, rootPath: RAW_DATA_DIR });

  bench(
    "native  no change",
    async () => {
      benchCache.invalidateAll();
      await using _session = await benchCache.open();
    },
    { warmupIterations: 1, throws: true }
  );
});
