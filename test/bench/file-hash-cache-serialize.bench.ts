/**
 * Benchmark: FileHashCache serialize — cold write (no existing cache).
 *
 * Each iteration deletes the cache file first, then runs a full
 * serialize from scratch (stat + hash every file).
 *
 * Uses the same raw-data fixtures as hashfiles.bench.ts (~705 files).
 */

import { unlinkSync } from "node:fs";
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

describe("FileHashCache — serialize (no existing cache)", async () => {
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

  //  - Benchmarks

  const cpNative = cachePath(cacheDir, "cold-native");
  const cpWasm = cachePath(cacheDir, "cold-wasm");

  bench(
    "native  serialize (no existing cache)",
    async () => {
      try {
        unlinkSync(cpNative);
      } catch {}
      const cache = new FileHashCache(cpNative, { version: 1, writable: true });
      cache.setFiles(files);
      await cache.serialize();
      await cache.dispose();
    },
    { warmupIterations: 1, throws: true }
  );

  bench(
    "wasm    serialize (no existing cache)",
    async () => {
      try {
        unlinkSync(cpWasm);
      } catch {}
      const cache = new FileHashCacheWasm(cpWasm, { version: 1, writable: true });
      cache.setFiles(files);
      await cache.serialize();
      await cache.dispose();
    },
    { warmupIterations: 1, throws: true }
  );
});
