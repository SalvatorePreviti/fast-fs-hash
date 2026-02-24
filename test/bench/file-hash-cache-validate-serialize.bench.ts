/**
 * Benchmark: FileHashCache validate + serialize — one file changed.
 *
 * The cache file is pre-seeded, then a single file is mutated before
 * each iteration.  validate detects the change, serialize rewrites.
 *
 * NOTE: vitest bench `setup` runs once per timing phase (warmup/run),
 * NOT per iteration.  Stateful mutations must live inside the bench fn.
 *
 * Uses the same raw-data fixtures as hashfiles.bench.ts (~705 files).
 */

import path from "node:path";
import { bench, describe } from "vitest";
import { FileHashCache } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache";
import { FileHashCacheWasm } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-wasm";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";

const { generate, mutateModFile } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
  mutateModFile: () => void;
};

const RAW_DATA_DIR = path.join(import.meta.dirname, "raw-data");

let counter = 0;
function cachePath(cacheDir: string, label: string): string {
  return path.join(cacheDir, `${label}-${++counter}.cache`);
}

describe("FileHashCache — validate+serialize (1 file changed)", async () => {
  const { files, cacheDir } = generate();
  await XXHash128.init();
  await FileHashCacheWasm.init();

  //  - Warmup: prime FS caches with both backends

  for (const Ctor of [FileHashCache, FileHashCacheWasm]) {
    const cp = cachePath(cacheDir, "warmup");
    const c = new Ctor(RAW_DATA_DIR, cp, { version: 1 });
    c.setFiles(files);
    await c.validate();
    await c.serialize();
    await c.dispose();
  }

  //  - Seed cache files

  const cpNative = cachePath(cacheDir, "one-change-native");
  {
    const c = new FileHashCache(RAW_DATA_DIR, cpNative, { version: 1 });
    c.setFiles(files);
    await c.validate();
    await c.serialize();
    await c.dispose();
  }

  const cpWasm = cachePath(cacheDir, "one-change-wasm");
  {
    const c = new FileHashCacheWasm(RAW_DATA_DIR, cpWasm, { version: 1 });
    c.setFiles(files);
    await c.validate();
    await c.serialize();
    await c.dispose();
  }

  //  - Benchmarks

  bench(
    "native  validate+serialize (1 file changed)",
    async () => {
      mutateModFile();
      const cache = new FileHashCache(RAW_DATA_DIR, cpNative, { version: 1 });
      cache.setFiles(files);
      if (await cache.validate()) {
        throw new Error("should not validate");
      }
      if ((await cache.serialize()) !== "written") {
        throw new Error("should serialize");
      }
      await cache.dispose();
    },
    { warmupIterations: 1, throws: true }
  );

  bench(
    "wasm    validate+serialize (1 file changed)",
    async () => {
      mutateModFile();
      const cache = new FileHashCacheWasm(RAW_DATA_DIR, cpWasm, { version: 1 });
      cache.setFiles(files);
      if (await cache.validate()) {
        throw new Error("should not validate");
      }
      if ((await cache.serialize()) !== "written") {
        throw new Error("should serialize");
      }
      await cache.dispose();
    },
    { warmupIterations: 1, throws: true }
  );
});
