/**
 * Tests: FileHashCache auto root path.
 *
 * Covers rootPath: true in write options, auto-computation of common root
 * from absolute file paths, files spanning multiple directories, and fallback
 * to system root.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileHashCacheSession } from "fast-fs-hash";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-auto-root");
const FIX_A = path.join(TEST_DIR, "project-a");
const FIX_B = path.join(TEST_DIR, "project-b");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

async function withCache<T>(
  cp: string,
  files: string[],
  opts: { rootPath?: string; version?: number; fingerprint?: Uint8Array | null; lockTimeoutMs?: number },
  run: (session: FileHashCacheSession) => Promise<T> | T
): Promise<T> {
  using session = await new FileHashCache({ cachePath: cp, files, ...opts }).open();
  return await run(session);
}

//  - Tests

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIX_A, { recursive: true });
  mkdirSync(FIX_B, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  writeFileSync(path.join(FIX_A, "a.txt"), "aaa\n");
  writeFileSync(path.join(FIX_A, "b.txt"), "bbb\n");
  writeFileSync(path.join(FIX_B, "c.txt"), "ccc\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileHashCache auto root path [native]", () => {
  it("rootPath: true in write auto-computes root from files in same dir", async () => {
    const cp = cachePath("auto-same");
    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");
    const files = [fileA, fileB];

    await withCache(cp, [], { rootPath: TEST_DIR, version: 1 }, async (ctx1) => {
      await ctx1.write({ files, rootPath: true });
    });

    // Verify: re-open with the same files (root auto-detected as FIX_A)
    const status = await withCache(cp, files, { rootPath: FIX_A, version: 1 }, (ctx2) => ctx2.status);
    expect(status).toBe("upToDate");
  });

  it("rootPath: true with files spanning two directories uses common parent", async () => {
    const cp = cachePath("auto-span");
    const fileA = path.join(FIX_A, "a.txt");
    const fileC = path.join(FIX_B, "c.txt");
    const files = [fileA, fileC];

    await withCache(cp, [], { rootPath: TEST_DIR, version: 1 }, async (ctx1) => {
      await ctx1.write({ files, rootPath: true });
    });

    // Root should be TEST_DIR (common parent of project-a and project-b)
    const status = await withCache(cp, files, { rootPath: TEST_DIR, version: 1 }, (ctx2) => ctx2.status);
    expect(status).toBe("upToDate");
  });

  it("full cycle: open + write then validate", async () => {
    const cp = cachePath("auto-cycle");
    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");
    const files = [fileA, fileB];

    await withCache(cp, files, { rootPath: FIX_A, version: 1 }, async (ctx1) => {
      await ctx1.write();
    });

    const status = await withCache(cp, files, { rootPath: FIX_A, version: 1 }, (ctx2) => ctx2.status);
    expect(status).toBe("upToDate");
  });

  it("rootPath: true in write overrides auto-detected root from open", async () => {
    const cp = cachePath("auto-override");
    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");
    const files = [fileA, fileB];

    await withCache(cp, [], { rootPath: TEST_DIR, version: 1 }, async (ctx1) => {
      await ctx1.write({ files, rootPath: true });
    });

    // Should have used auto-computed root (FIX_A)
    const status = await withCache(cp, files, { rootPath: FIX_A, version: 1 }, (ctx2) => ctx2.status);
    expect(status).toBe("upToDate");
  });

  it("rootPath: explicit string in write sets root", async () => {
    const cp = cachePath("auto-explicit");
    const files = [path.join(FIX_A, "a.txt")];

    await withCache(cp, [], { rootPath: TEST_DIR, version: 1 }, async (ctx1) => {
      await ctx1.write({ files, rootPath: FIX_A });
    });

    const status = await withCache(cp, files, { rootPath: FIX_A, version: 1 }, (ctx2) => ctx2.status);
    expect(status).toBe("upToDate");
  });
});
