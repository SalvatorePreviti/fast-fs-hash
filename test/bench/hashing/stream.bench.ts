/**
 *
 * Tests addBuffer, addString, addBufferRange, addFile, addFiles,
 * addFilesParallel, multi-feed, and reset/re-digest patterns.
 *
 * Run with: npx vitest bench test/bench/hashing/stream.bench.ts
 */

import { resolve } from "node:path";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

const BENCH_OPTS = { time: 100, warmupTime: 50, warmupIterations: 3 } as const;
const b = (name: string, fn: () => void | Promise<void>) => bench(name, fn, BENCH_OPTS);

const SMALL_BUF = Buffer.from("hello world xxhash128 benchmark");
const MEDIUM_BUF = Buffer.alloc(4096);
const LARGE_BUF = Buffer.alloc(256 * 1024);

for (let i = 0; i < MEDIUM_BUF.length; i++) {
  MEDIUM_BUF[i] = (i * 31 + 17) & 0xff;
}
for (let i = 0; i < LARGE_BUF.length; i++) {
  LARGE_BUF[i] = (i * 31 + 17) & 0xff;
}

const BUFFERS = [SMALL_BUF, MEDIUM_BUF, LARGE_BUF] as const;

const SMALL_STR = "hello world xxhash128 benchmark test string";
const MEDIUM_STR = "x".repeat(4096);
const LARGE_STR = "x".repeat(256 * 1024);

const STRINGS = [
  { label: "44 chars", value: SMALL_STR },
  { label: "4 K chars", value: MEDIUM_STR },
  { label: "256 K chars", value: LARGE_STR },
] as const;

const OUT_BUF = Buffer.alloc(16);

const FIXTURE_DIR = resolve(__dirname, "../../fixtures/hash-fixture");
const FIXTURE_FILES = [
  resolve(FIXTURE_DIR, "a.txt"),
  resolve(FIXTURE_DIR, "b.txt"),
  resolve(FIXTURE_DIR, "data-4k.bin"),
];

describe.each(BUFFERS)("Stream addBuffer + digest", (buf) => {
  describe(buf.length + " B", () => {
    b("Native", () => {
      const s = new native.XxHash128Stream();
      s.addBuffer(buf);
      s.digest();
    });
  });
});

describe.each(STRINGS)("Stream addString + digest", ({ label, value }) => {
  describe(label, () => {
    b("Native", () => {
      const s = new native.XxHash128Stream();
      s.addString(value);
      s.digest();
    });
  });
});

describe("Stream addBufferRange + digestTo", () => {
  describe("first 16 B of 4 KB", () => {
    b("Native", () => {
      const s = new native.XxHash128Stream();
      s.addBufferRange(MEDIUM_BUF, 0, 16);
      s.digestTo(OUT_BUF);
    });
  });
});

describe("Stream addFile + digest (4 KB)", () => {
  const filePath = resolve(FIXTURE_DIR, "data-4k.bin");
  b("Native", async () => {
    const s = new native.XxHash128Stream();
    await s.addFile(filePath);
    s.digest();
  });
});

describe("Stream addFiles + digest (3 files)", () => {
  b("Native", async () => {
    const s = new native.XxHash128Stream();
    await s.addFiles(FIXTURE_FILES);
    s.digest();
  });
});

describe("Stream addFilesParallel + digest (3 files)", () => {
  b("Native", async () => {
    const s = new native.XxHash128Stream();
    await s.addFilesParallel(FIXTURE_FILES);
    s.digest();
  });
});

describe("Stream multi-feed (10x 4KB) + digest", () => {
  b("Native", () => {
    const s = new native.XxHash128Stream();
    for (let i = 0; i < 10; i++) {
      s.addBuffer(MEDIUM_BUF);
    }
    s.digest();
  });
});

describe("Stream reset + re-digest (4 KB)", () => {
  const sn = new native.XxHash128Stream();

  b("Native", () => {
    sn.reset();
    sn.addBuffer(MEDIUM_BUF);
    sn.digest();
  });
});
