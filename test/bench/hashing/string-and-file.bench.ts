/**
 *
 * Tests digestString, digestStringTo, digestFile, digestFileTo,
 * digestFilesSequential, digestFilesParallel across various inputs.
 *
 * Run with: npx vitest bench test/bench/hashing/string-and-file.bench.ts
 */

import { resolve } from "node:path";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

const BENCH_OPTS = { time: 100, warmupTime: 50, warmupIterations: 3 } as const;
const b = (name: string, fn: () => void | Promise<void>) => bench(name, fn, BENCH_OPTS);

const SMALL_STR = "hello world xxhash128 benchmark test string";
const MEDIUM_STR = "x".repeat(4096);
const LARGE_STR = "x".repeat(256 * 1024);

const STRINGS = [
  { label: "44 chars", value: SMALL_STR },
  { label: "4 K chars", value: MEDIUM_STR },
  { label: "256 K chars", value: LARGE_STR },
] as const;

const OUT_BUF = Buffer.alloc(16);
const OUT_BUF_32 = Buffer.alloc(32);

const FIXTURE_DIR = resolve(__dirname, "../../fixtures/hash-fixture");
const FIXTURE_FILES = [
  resolve(FIXTURE_DIR, "a.txt"),
  resolve(FIXTURE_DIR, "b.txt"),
  resolve(FIXTURE_DIR, "data-4k.bin"),
];

describe.each(STRINGS)("digestString", ({ label, value }) => {
  describe(label, () => {
    const n = native.digestString;
    b("Native", () => {
      n(value);
    });
  });
});

describe.each(STRINGS)("digestStringTo", ({ label, value }) => {
  describe(label, () => {
    const n = native.digestStringTo;
    b("Native", () => {
      n(value, OUT_BUF);
    });
  });
});

describe.each(STRINGS)("digestStringTo (with offset)", ({ label, value }) => {
  describe(label, () => {
    const n = native.digestStringTo;
    b("Native", () => {
      n(value, OUT_BUF_32, 8);
    });
  });
});

describe("digestFile (4 KB)", () => {
  const filePath = resolve(FIXTURE_DIR, "data-4k.bin");
  const n = native.digestFile;
  b("Native", async () => {
    await n(filePath);
  });
});

describe("digestFileTo (4 KB)", () => {
  const filePath = resolve(FIXTURE_DIR, "data-4k.bin");
  const n = native.digestFileTo;
  b("Native", async () => {
    await n(filePath, OUT_BUF);
  });
});

describe("digestFilesSequential (3 files)", () => {
  const n = native.digestFilesSequential;
  b("Native", async () => {
    await n(FIXTURE_FILES);
  });
});

describe("digestFilesParallel (3 files)", () => {
  const n = native.digestFilesParallel;
  b("Native", async () => {
    await n(FIXTURE_FILES);
  });
});
