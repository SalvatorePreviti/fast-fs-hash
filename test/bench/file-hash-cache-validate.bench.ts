/**
 * Benchmark: FileHashCache validate — nothing changed (hot path).
 *
 * The cache file is pre-seeded with valid data; each iteration opens,
 * validates (all stat matches -> `true`), and closes.
 *
 * Uses the same raw-data fixtures as hashfiles.bench.ts (~705 files).
 */

import path from "node:path";
import { bench, describe } from "vitest";
import { FileHashCache } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache";
import { FileHashCacheWasm } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-wasm";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

let counter = 0;
function cachePath(cacheDir: string, label: string): string {
  return path.join(cacheDir, `${label}-${++counter}.cache`);
}

describe("FileHashCache — validate (no change)", async () => {
  const { files, cacheDir } = generate();
  await XXHash128.init();
  await FileHashCacheWasm.init();

  //  - Warmup: prime FS caches with both backends

  for (const Ctor of [FileHashCache, FileHashCacheWasm]) {
    const cp = cachePath(cacheDir, "warmup");
    const c = new Ctor(cp, { version: 1, writable: true });
    c.setFiles(files);
    await c.validate();
    await c.serialize();
    await c.dispose();
  }

  //  - Seed cache files

  const cpNative = cachePath(cacheDir, "unchanged-native");
  {
    const c = new FileHashCache(cpNative, { version: 1, writable: true });
    c.setFiles(files);
    await c.validate();
    await c.serialize();
    await c.dispose();
  }

  const cpWasm = cachePath(cacheDir, "unchanged-wasm");
  {
    const c = new FileHashCacheWasm(cpWasm, { version: 1, writable: true });
    c.setFiles(files);
    await c.validate();
    await c.serialize();
    await c.dispose();
  }

  //  - Benchmarks

  bench(
    "native  validate (no change)",
    async () => {
      const cache = new FileHashCache(cpNative, { version: 1 });
      cache.setFiles(files);
      await cache.validate();
      await cache.dispose();
    },
    { warmupIterations: 1, throws: true }
  );

  bench(
    "wasm    validate (no change)",
    async () => {
      const cache = new FileHashCacheWasm(cpWasm, { version: 1 });
      cache.setFiles(files);
      await cache.validate();
      await cache.dispose();
    },
    { warmupIterations: 1, throws: true }
  );
});
