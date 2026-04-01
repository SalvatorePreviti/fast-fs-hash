/**
 * Benchmark: FileHashCache update — one file changed.
 *
 * The cache file is pre-seeded, then a single file is mutated once.
 * Each iteration restores the stale cache snapshot and runs open + write,
 * so only the actual cache update is timed (not the file mutation).
 *
 * Uses the same raw-data fixtures as hashfiles.bench.ts (~705 files).
 */

import { copyFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { bench, describe } from "vitest";

const { generate, mutateModFile } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
  mutateModFile: () => void;
};

const RAW_DATA_DIR = path.join(import.meta.dirname, "raw-data");

let counter = 0;
function cp(cacheDir: string, label: string): string {
  return path.join(cacheDir, `${label}-${++counter}.cache`);
}

describe("FileHashCache — 1 file changed", async () => {
  const { files, cacheDir } = generate();

  // Warmup
  const warmupCp = cp(cacheDir, "warmup");
  {
    await using warmupCtx = await FileHashCache.open(warmupCp, RAW_DATA_DIR, files);
    await warmupCtx.write();
  }

  const benchCp = cp(cacheDir, "one-change");
  const stalePath = benchCp + ".stale";

  // Seed the cache
  {
    await using seedCtx = await FileHashCache.open(benchCp, RAW_DATA_DIR, files);
    await seedCtx.write();
  }

  // Save stale snapshot, then mutate one file
  copyFileSync(benchCp, stalePath);
  mutateModFile();

  bench(
    "native  1 file changed",
    async () => {
      copyFileSync(stalePath, benchCp);
      await using ctx = await FileHashCache.open(benchCp, RAW_DATA_DIR, files);
      if (ctx.status === "upToDate") {
        throw new Error("should not be upToDate");
      }
      await ctx.write();
    },
    { warmupIterations: 1, throws: true }
  );
});
