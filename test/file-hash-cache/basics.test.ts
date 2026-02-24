import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileHashCache } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache";
import {
  ENTRY_STRIDE,
  FileHashCacheBase,
  H_FILE_COUNT,
  H_FINGERPRINT_BYTE,
  H_MAGIC,
  H_PATHS_LEN,
  H_USER,
  H_VERSION,
  HEADER_SIZE,
  MAGIC,
} from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-base";
import { FileHashCacheWasm } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-wasm";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";
import { XXHash128Wasm } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128-wasm";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-basics");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

beforeAll(async () => {
  await XXHash128.init();
  await XXHash128Wasm.init();
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  // Create test fixture files.
  writeFileSync(fixtureFile("a.txt"), "hello world\n");
  writeFileSync(fixtureFile("b.txt"), "goodbye world\n");
  writeFileSync(fixtureFile("c.txt"), "third file\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

//  - Tests

describe("FileHashCache", () => {
  //  - Class hierarchy

  describe("class hierarchy", () => {
    it("FileHashCache extends FileHashCacheBase", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      expect(c).toBeInstanceOf(FileHashCacheBase);
    });

    it("FileHashCacheWasm extends FileHashCacheBase", () => {
      const c = new FileHashCacheWasm(FIXTURE_DIR, cachePath(), { version: 1 });
      expect(c).toBeInstanceOf(FileHashCacheBase);
    });

    it("constructor sets readonly properties", () => {
      const fp16 = new Uint8Array(16);
      fp16.fill(0x42);
      const c = new FileHashCache(FIXTURE_DIR, cachePath("props"), {
        version: 42,
        fingerprint: fp16,
      });
      expect(c.filePath).toContain("props");
      expect(c.version).toBe(42);
      expect(c.position).toBe(0);
    });

    it("version is treated as u32", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: -1 });
      expect(c.version).toBe(0xffffffff);
    });
  });

  //  - Constants

  describe("constants", () => {
    it("MAGIC is 0x00485346", () => {
      expect(MAGIC).toBe(0x00485346);
    });

    it("HEADER_SIZE is 64", () => {
      expect(HEADER_SIZE).toBe(64);
    });

    it("ENTRY_STRIDE is 48", () => {
      expect(ENTRY_STRIDE).toBe(48);
    });

    it("header slot indices are correct", () => {
      expect(H_MAGIC).toBe(0);
      expect(H_VERSION).toBe(1);
      expect(H_USER).toBe(2);
      expect(H_FILE_COUNT).toBe(6);
      expect(H_FINGERPRINT_BYTE).toBe(28);
      expect(H_PATHS_LEN).toBe(11);
    });
  });

  //  - setFiles / currentFiles

  describe("setFiles / currentFiles", () => {
    it("returns empty array before setFiles", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(c.currentFiles).toEqual([]);
    });

    it("setFiles sorts and deduplicates", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles(["z.ts", "a.ts", "m.ts", "a.ts"]);
      expect(c.currentFiles).toEqual(["a.ts", "m.ts", "z.ts"]);
    });

    it("setFiles accepts iterables", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles(new Set(["b", "a", "c"]));
      expect(c.currentFiles).toEqual(["a", "b", "c"]);
    });

    it("currentFiles() result is cached — returns same array reference on repeated calls", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles(["z.ts", "a.ts", "m.ts"]);
      const first = c.currentFiles;
      const second = c.currentFiles;
      expect(first).toBe(second);
    });

    it("currentFiles() lazily decodes paths after loading from cache without prior setFiles", async () => {
      const cp = cachePath("gf-lazy");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Re-open and validate WITHOUT calling setFiles — paths come from the cache file.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        await c.validate();
        // currentFiles() must lazily decode from the loaded _pathsBuf.
        expect(c.currentFiles).toEqual(["a.txt", "b.txt", "c.txt"]);
        // Second call must return the same cached reference.
        const first = c.currentFiles;
        const second = c.currentFiles;
        expect(first).toBe(second);
      }
    });
  });

  //  - fileCount

  describe("fileCount", () => {
    it("is 0 before setFiles", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(c.fileCount).toBe(0);
    });

    it("equals currentFiles().length after setFiles", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")]);
      expect(c.fileCount).toBe(c.currentFiles.length);
      expect(c.fileCount).toBe(3);
    });

    it("reflects deduplication", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles(["x", "x", "y"]);
      expect(c.fileCount).toBe(2);
    });

    it("matches number of valid getFileHash indices after completion", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      c.setFiles(files);
      await c.complete();
      expect(c.fileCount).toBe(2);
      expect(c.getFileHash(0)).not.toBeNull();
      expect(c.getFileHash(1)).not.toBeNull();
      expect(c.getFileHash(c.fileCount)).toBeNull(); // one past end
    });

    it("is available after loading from cache without setFiles", async () => {
      const cp = cachePath("fc-noset");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        await c.validate();
        expect(c.fileCount).toBe(files.length);
      }
    });
  });

  //  - getFileCount

  describe("getFileCount", () => {
    it("returns 0 before setFiles", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(c.getFileCount()).toBe(0);
    });

    it("matches fileCount getter after setFiles", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt")]);
      expect(c.getFileCount()).toBe(c.fileCount);
      expect(c.getFileCount()).toBe(2);
    });

    it("reflects deduplication (same as getter)", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles(["x", "x", "y"]);
      expect(c.getFileCount()).toBe(2);
    });

    it("returns 0 when not loaded and stays consistent with fileCount", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(c.getFileCount()).toBe(0);
      expect(c.getFileCount()).toBe(c.fileCount);
    });

    it("is available after loading from cache without setFiles", async () => {
      const cp = cachePath("gfc-noset");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        await c.validate();
        expect(c.getFileCount()).toBe(files.length);
        expect(c.getFileCount()).toBe(c.fileCount);
      }
    });
  });

  //  - userValue0-3

  describe("userValue0-3", () => {
    it("starts as all zeros", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(c.userValue0).toBe(0);
      expect(c.userValue1).toBe(0);
      expect(c.userValue2).toBe(0);
      expect(c.userValue3).toBe(0);
    });
  });
});
