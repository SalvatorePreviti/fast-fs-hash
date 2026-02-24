import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileHashCache } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache";
import { FileHashCacheWasm } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-wasm";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-auto-root");
const FIX_A = path.join(TEST_DIR, "project-a");
const FIX_B = path.join(TEST_DIR, "project-b");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

beforeAll(async () => {
  await XXHash128.init();
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

//  - Tests

describe("autoRootPath (rootPath: true)", () => {
  // ── Constructor with true ─────────────────────────────────────────

  it("constructor with true uses system root initially", () => {
    const cp = cachePath("ctor-true");
    const c = new FileHashCache(true, cp, { version: 1 });
    // Before setFiles, rootPath is the system root.
    expect(c.rootPath).toBe(path.resolve("/"));
    c.dispose();
  });

  it("constructor with explicit string sets rootPath", () => {
    const cp = cachePath("ctor-string");
    const c = new FileHashCache(FIX_A, cp, { version: 1 });
    expect(c.rootPath).toBe(FIX_A);
    c.dispose();
  });

  // ── setFiles auto-computes root ───────────────────────────────────

  it("setFiles computes root from absolute file paths when autoRootPath is true", () => {
    const cp = cachePath("auto-setfiles");
    const c = new FileHashCache(true, cp, { version: 1 });
    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");
    c.setFiles([fileA, fileB]);

    expect(c.rootPath).toBe(FIX_A);
    expect(c.currentFiles).toEqual(["a.txt", "b.txt"]);
    c.dispose();
  });

  it("setFiles recomputes root on subsequent calls", () => {
    const cp = cachePath("auto-recompute");
    const c = new FileHashCache(true, cp, { version: 1 });
    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");
    const fileC = path.join(FIX_B, "c.txt");

    // First call: both in project-a → root = project-a
    c.setFiles([fileA, fileB]);
    expect(c.rootPath).toBe(FIX_A);

    // Second call with files spanning both dirs → root = TEST_DIR
    c.setFiles([fileA, fileC]);
    expect(c.rootPath).toBe(TEST_DIR);
    c.dispose();
  });

  it("falls back to system root when files have no common directory", () => {
    const cp = cachePath("auto-fallback");
    const c = new FileHashCache(true, cp, { version: 1 });
    // Bare filenames have no directory component → findCommonRootPath returns ""
    c.setFiles(["just-a-name.txt"]);
    expect(c.rootPath).toBe(path.resolve("/"));
    c.dispose();
  });

  // ── setFiles with rootPath parameter ──────────────────────────────

  it("setFiles with rootPath=true enables auto mode on a previously fixed cache", () => {
    const cp = cachePath("enable-auto");
    const c = new FileHashCache(FIX_A, cp, { version: 1 });

    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");
    c.setFiles([fileA, fileB], true);
    expect(c.rootPath).toBe(FIX_A);
    c.dispose();
  });

  it("setFiles with explicit string rootPath disables auto mode", () => {
    const cp = cachePath("disable-auto");
    const c = new FileHashCache(true, cp, { version: 1 });

    c.setFiles(["a.txt", "b.txt"], FIX_A);
    expect(c.rootPath).toBe(FIX_A);
    expect(c.currentFiles).toEqual(["a.txt", "b.txt"]);
    c.dispose();
  });

  it("setFiles with null/undefined preserves current auto mode", () => {
    const cp = cachePath("preserve-mode");
    const c = new FileHashCache(true, cp, { version: 1 });

    const fileA = path.join(FIX_A, "a.txt");
    c.setFiles([fileA], null);
    expect(c.rootPath).toBe(FIX_A);

    c.setFiles([fileA], undefined);
    expect(c.rootPath).toBe(FIX_A);
    c.dispose();
  });

  // ── Full validate/serialize cycle with auto root ──────────────────

  it("full cycle: validate + serialize with auto root", async () => {
    const cp = cachePath("auto-cycle");
    const fileA = path.join(FIX_A, "a.txt");
    const fileB = path.join(FIX_A, "b.txt");

    // Write cache with auto root.
    {
      await using c = new FileHashCache(true, cp, { version: 1 });
      c.setFiles([fileA, fileB]);
      expect(c.rootPath).toBe(FIX_A);
      await c.serialize();
    }

    // Re-read and validate.
    {
      await using c = new FileHashCache(true, cp, { version: 1 });
      c.setFiles([fileA, fileB]);
      expect(c.rootPath).toBe(FIX_A);
      const valid = await c.validate();
      expect(valid).toBe(true);
      expect(c.getChangedFiles()).toEqual([]);
    }
  });

  // ── Wasm variant ──────────────────────────────────────────────────

  it("FileHashCacheWasm also supports rootPath: true", () => {
    const cp = cachePath("wasm-auto");
    const c = new FileHashCacheWasm(true, cp, { version: 1 });
    expect(c.rootPath).toBe(path.resolve("/"));

    const fileA = path.join(FIX_A, "a.txt");
    c.setFiles([fileA]);
    expect(c.rootPath).toBe(FIX_A);
    c.dispose();
  });
});
