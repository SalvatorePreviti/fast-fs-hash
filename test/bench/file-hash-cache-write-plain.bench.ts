/**
 * Benchmark: FileHashCache write path with incompressible payloads.
 *
 * The writer picks PLAIN encoding when LZ4 doesn't shrink the body. The
 * PLAIN branch uses writev to gather header + uncompressed-section + body
 * in one syscall, avoiding a body-sized memcpy. Sizes here straddle the
 * range where writev showed wins in the writev-vs-memcpy micro-bench
 * (~25-45% in 64 KiB to 512 KiB).
 *
 * `compressedPayloads` is the right channel to stress the compressed-body
 * section; the writer LZ4s it, sees it grew, and falls to PLAIN.
 */

import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { bench, describe } from "vitest";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

const RAW_DATA_DIR = path.join(import.meta.dirname, "raw-data");

/** Deterministic xorshift32 — incompressible byte stream, no flakiness. */
function incompressibleBytes(byteLength: number, seed = 0xc0ffee): Buffer {
  const out = Buffer.alloc(byteLength);
  let s = seed >>> 0;
  for (let i = 0; i < byteLength; i += 4) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out.writeUInt32LE(s >>> 0, i);
  }
  return out;
}

let counter = 0;
function cp(cacheDir: string, label: string): string {
  return path.join(cacheDir, `${label}-${++counter}.cache`);
}

const SIZES: Array<{ label: string; bytes: number }> = [
  { label: "64 KiB", bytes: 64 * 1024 },
  { label: "128 KiB", bytes: 128 * 1024 },
  { label: "256 KiB", bytes: 256 * 1024 },
  { label: "512 KiB", bytes: 512 * 1024 },
  { label: "1 MiB", bytes: 1024 * 1024 },
];

for (const { label, bytes } of SIZES) {
  describe(`FileHashCache — overwrite with ${label} incompressible compressedPayload (PLAIN)`, async () => {
    const { files, cacheDir } = generate();
    const payload = incompressibleBytes(bytes);
    const cache = new FileHashCache({
      cachePath: cp(cacheDir, `plain-comp-${bytes}`),
      files,
      rootPath: RAW_DATA_DIR,
    });

    await cache.overwrite({ compressedPayloads: [payload] }); // warm up

    bench(
      `overwrite ${label} PLAIN compressedPayload`,
      async () => {
        await cache.overwrite({ compressedPayloads: [payload] });
      },
      { warmupIterations: 1, throws: true }
    );
  });

  // uncompressedPayloads section is always written raw (regardless of body
  // format). With writev the uncompressed bytes are streamed straight from
  // the caller's buffer — exercises the writev path for the uncompressed
  // segment specifically.
  describe(`FileHashCache — overwrite with ${label} uncompressedPayload`, async () => {
    const { files, cacheDir } = generate();
    const payload = incompressibleBytes(bytes, 0xfeedface);
    const cache = new FileHashCache({
      cachePath: cp(cacheDir, `unc-${bytes}`),
      files,
      rootPath: RAW_DATA_DIR,
    });

    await cache.overwrite({ uncompressedPayloads: [payload] }); // warm up

    bench(
      `overwrite ${label} uncompressedPayload`,
      async () => {
        await cache.overwrite({ uncompressedPayloads: [payload] });
      },
      { warmupIterations: 1, throws: true }
    );
  });
}
