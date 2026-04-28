import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-flows-ctor");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cp(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fx(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

const ROOT = FIXTURE_DIR.endsWith("/") ? FIXTURE_DIR : FIXTURE_DIR + "/";

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(fx("a.txt"), "aaa\n");
  writeFileSync(fx("b.txt"), "bbb\n");
  writeFileSync(fx("c.txt"), "ccc\n");
  writeFileSync(fx("d.txt"), "ddd\n");
  writeFileSync(fx("e.txt"), "eee\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// - Constructor

describe("constructor with files", () => {
  it("sets files and fileCount immediately", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt"), fx("b.txt")], rootPath: FIXTURE_DIR });
    expect(cache.files).toHaveLength(2);
    expect(cache.fileCount).toBe(2);
  });

  it("normalizes, sorts, and returns absolute paths", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("b.txt"), fx("a.txt")], rootPath: FIXTURE_DIR });
    const files = cache.files;
    expect(files).not.toBeNull();
    expect(files?.[0]).toBe(ROOT + "a.txt");
    expect(files?.[1]).toBe(ROOT + "b.txt");
  });
});

describe("constructor without files", () => {
  it("files is null and fileCount is 0", () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);
  });
});

// - Files setter

describe("files setter", () => {
  it("sets files after construction", () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    expect(cache.files).toBeNull();

    cache.files = [fx("a.txt"), fx("c.txt")];
    expect(cache.fileCount).toBe(2);
    expect(cache.files).toHaveLength(2);
  });

  it("overrides constructor files", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    expect(cache.fileCount).toBe(1);

    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    expect(cache.fileCount).toBe(3);
    expect(cache.files).toHaveLength(3);
  });

  it("setting null clears files", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    cache.files = null;
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);
  });

  it("returns absolute paths from setter", () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    cache.files = [fx("b.txt"), fx("a.txt")];
    expect(cache.files?.[0]).toBe(ROOT + "a.txt");
    expect(cache.files?.[1]).toBe(ROOT + "b.txt");
  });
});

// Files setter between open/write does not affect existing session files
// but DOES affect what gets written to disk

describe("files setter during active session", () => {
  it("cache.files reflects setter value immediately", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    const s = await cache.open();
    expect(cache.fileCount).toBe(1);

    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    expect(cache.fileCount).toBe(3);
    expect(cache.files).toHaveLength(3);

    await s.write();

    // The written cache has the new 3-file list
    {
      cache.invalidateAll();
      using s2 = await cache.open();
      expect(s2.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
      expect(s2.fileCount).toBe(3);
    }
  });
});
