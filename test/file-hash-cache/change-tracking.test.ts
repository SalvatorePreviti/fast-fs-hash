import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache, XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-change-tracking");
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

// Small sleep for mtime granularity.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

//  - Tests

describe("FileHashCache", () => {
  //  - getChangedFiles

  describe("getChangedFiles", () => {
    it("returns empty array before complete() or serialize()", async () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      // _completed is false — getChangedFiles() signals "not ready" with []
      expect(c.getChangedFiles()).toEqual([]);
      await c.dispose();
    });

    it("returns all files on cold write (no previous cache)", async () => {
      const cp = cachePath("gc-cold");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
      const changed = c.getChangedFiles();
      expect(changed).toEqual(["a.txt", "b.txt"]);
    });

    it("returns empty array when validate succeeds then serialize", async () => {
      const cp = cachePath("gc-unchanged");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Re-open, validate (unchanged), then serialize.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        await c.serialize();
        const changed = c.getChangedFiles();
        expect(changed).toEqual([]);
      }
    });

    it("returns only the changed file after modification", async () => {
      const cp = cachePath("gc-one-change");
      const mutable = fixtureFile("gc-mut.txt");
      writeFileSync(mutable, "original content");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), mutable];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Modify one file.
      await sleep(50);
      writeFileSync(mutable, "modified content");

      // Validate + serialize — only the modified file should appear.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        await c.serialize();
        const changed = c.getChangedFiles();
        expect(changed).toContain("gc-mut.txt");
        // The other two files should NOT be in the changed list.
        expect(changed).not.toContain("a.txt");
        expect(changed).not.toContain("b.txt");
      }
    });

    it("returns all files when file list changes completely", async () => {
      const cp = cachePath("gc-all-new");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("b.txt"), fixtureFile("c.txt")];

      // Seed with files1.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files1);
        await c.serialize();
      }

      // Serialize with completely different file list.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files2);
        await c.validate();
        await c.serialize();
        const changed = c.getChangedFiles();
        expect(changed).toEqual(["b.txt", "c.txt"]);
      }
    });

    it("returns all files on version mismatch", async () => {
      const cp = cachePath("gc-ver");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 2 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
        const changed = c.getChangedFiles();
        expect(changed).toEqual(["a.txt"]);
      }
    });

    it("works with serialize-without-validate (all changed)", async () => {
      const cp = cachePath("gc-no-val");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
      const changed = c.getChangedFiles();
      expect(changed).toEqual(["a.txt", "b.txt"]);
    });

    it("returns empty array for empty file list", async () => {
      const cp = cachePath("gc-empty");

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles([]);
      await c.serialize();
      expect(c.getChangedFiles()).toEqual([]);
    });

    it("getChangedFiles after complete() but before serialize()", async () => {
      const cp = cachePath("gc-complete");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      await sleep(50);
      writeFileSync(fixtureFile("a.txt"), "modified a!\n"); // different content triggers change

      // Re-open, validate, call complete(), then getChangedFiles before serialize.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);

        // Before complete(): not ready.
        expect(c.getChangedFiles()).toEqual([]);

        await c.complete();
        const changed = c.getChangedFiles();
        expect(changed).toBeDefined();
        expect(Array.isArray(changed)).toBe(true);

        await c.serialize();

        // After serialize: still available, same reference (cached).
        expect(c.getChangedFiles()).toBe(changed);
      }

      // Restore fixture content for other tests.
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("getChangedFiles is idempotent after complete()", async () => {
      const cp = cachePath("gc-idempotent");
      const files = [fixtureFile("a.txt")];

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.complete();
      const changed1 = c.getChangedFiles();
      const changed2 = c.getChangedFiles(); // second call — cached, no work
      expect(changed1).toEqual(changed2);
      expect(changed1).toBe(changed2); // same reference
      await c.serialize();
    });

    it("getChangedFiles returns same array reference on repeated calls (cached)", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt")]);
      await c.complete();
      const first = c.getChangedFiles();
      const second = c.getChangedFiles();
      const third = c.getChangedFiles();
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("getChangedFiles cache resets after setFiles with changed list", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      await c.complete();
      const before = c.getChangedFiles();

      // Change the file list — cache must be invalidated.
      c.setFiles([fixtureFile("b.txt"), fixtureFile("c.txt")]);
      expect(c.getChangedFiles()).toEqual([]); // not ready until complete()
      await c.complete();
      const after = c.getChangedFiles();

      expect(after).not.toBe(before);
      expect(after).toEqual(["b.txt", "c.txt"]);
    });
  });

  //  - getFileHash

  describe("getFileHash", () => {
    it("returns null before setFiles", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(c.getFileHash(0)).toBeNull();
    });

    it("returns null for empty file list (no entriesBuf)", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles([]);
      expect(c.getFileHash(0)).toBeNull();
    });

    it("returns null for out-of-bounds positive index", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      await c.complete(); // ensures _entriesBuf is allocated
      expect(c.getFileHash(0)).not.toBeNull(); // in-bounds
      expect(c.getFileHash(1)).toBeNull();
      expect(c.getFileHash(100)).toBeNull();
    });

    it("returns null for negative index (coerced to large value via >>> 0)", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      await c.complete(); // ensures _entriesBuf is allocated
      expect(c.getFileHash(-1)).toBeNull();
    });

    it("returns null after setFiles on a fresh cache (no prior completion)", () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath());
      c.setFiles([fixtureFile("a.txt")]);
      // _entriesBuf is null until complete()/serialize()/validate() runs.
      expect(c.getFileHash(0)).toBeNull();
    });

    it("returns Uint8Array of length 16 after complete()", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt")]);
      await c.complete();
      const h0 = c.getFileHash(0);
      const h1 = c.getFileHash(1);
      expect(h0).toBeInstanceOf(Uint8Array);
      expect(h0?.length).toBe(16);
      expect(h1).toBeInstanceOf(Uint8Array);
      expect(h1?.length).toBe(16);
    });

    it("bytes are non-zero after complete()", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt")]);
      await c.complete();
      expect(c.getFileHash(0)?.some((b) => b !== 0)).toBe(true);
      expect(c.getFileHash(1)?.some((b) => b !== 0)).toBe(true);
    });

    it("hash matches XXHash128.hashFile result after complete()", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt")]);
      await c.complete();
      const sortedFiles = c.currentFiles;
      for (let i = 0; i < sortedFiles.length; i++) {
        const expected = await XXHash128.hashFile(path.join(FIXTURE_DIR, sortedFiles[i]));
        const actual = c.getFileHash(i);
        expect(actual).not.toBeNull();
        expect(Buffer.from(actual || new Uint8Array(0)).equals(expected as Buffer)).toBe(true);
      }
    });

    it("different files have different hashes after serialize", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")]);
      await c.serialize();
      const h0 = Buffer.from(c.getFileHash(0) || new Uint8Array(0));
      const h1 = Buffer.from(c.getFileHash(1) || new Uint8Array(0));
      const h2 = Buffer.from(c.getFileHash(2) || new Uint8Array(0));
      expect(h0.equals(h1)).toBe(false);
      expect(h0.equals(h2)).toBe(false);
      expect(h1.equals(h2)).toBe(false);
    });

    it("returns view into same underlying buffer on repeated calls (reference stability)", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      await c.complete();
      const h1 = c.getFileHash(0) || new Uint8Array(0);
      const h2 = c.getFileHash(0) || new Uint8Array(0);
      expect(h1).not.toBeNull();
      expect(h1.buffer).toBe(h2.buffer);
      expect(h1.byteOffset).toBe(h2.byteOffset);
    });

    it("hash is stable across round-trip validate (unchanged file)", async () => {
      const cp = cachePath("fh-rt");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      let hashAfterWrite: Buffer;

      // Seed and capture hash for first file.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
        hashAfterWrite = Buffer.from(c.getFileHash(0) || new Uint8Array(0));
        expect(hashAfterWrite.some((b) => b !== 0)).toBe(true);
      }

      // Re-open, validate unchanged — hash at index 0 must match.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        const hashAfterValidate = Buffer.from(c.getFileHash(0) || new Uint8Array(0));
        expect(hashAfterValidate.equals(hashAfterWrite)).toBe(true);
      }
    });
  });

  //  - setFiles after validate (remap)

  describe("setFiles after validate reuses hashes", () => {
    it("remaps unchanged files when file list changes after validate", async () => {
      const cp = cachePath("remap-change");
      const a = fixtureFile("a.txt");
      const b = fixtureFile("b.txt");
      const c_file = fixtureFile("c.txt");
      const originalFiles = [a, b, c_file];

      // Seed the cache with [a, b, c].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(originalFiles);
        await c.serialize();
      }

      // Re-open, validate (all match), then setFiles with a different list.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(originalFiles);
        expect(await c.validate()).toBe(true);

        // Change file list: drop c, keep a and b.
        c.setFiles([a, b]);

        await c.complete();
        const changed = c.getChangedFiles();

        // a and b were F_DONE from validate, remapped as F_HAS_OLD,
        // re-stat should match -> F_DONE -> not changed.
        expect(changed).toEqual([]);
      }
    });

    it("marks new files as changed after remap", async () => {
      const cp = cachePath("remap-new");
      const a = fixtureFile("a.txt");
      const b = fixtureFile("b.txt");
      const c_file = fixtureFile("c.txt");

      // Seed with [a, b].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        await c.serialize();
      }

      // Re-open, validate, then add c.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        expect(await c.validate()).toBe(true);

        // Expand file list: add c.
        c.setFiles([a, b, c_file]);

        await c.complete();
        const changed = c.getChangedFiles();

        // c is new -> changed. a and b should be unchanged.
        expect(changed).toEqual(["c.txt"]);
      }
    });

    it("getChangedFiles resets after setFiles with expanded list", async () => {
      const cp = cachePath("remap-gc-reset");
      const a = fixtureFile("a.txt");
      const b = fixtureFile("b.txt");
      const c_file = fixtureFile("c.txt");

      // Seed with [a, b].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        await c.serialize();
      }

      // Validate -> getChangedFiles (empty) -> setFiles(expanded) -> getChangedFiles (new file).
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        expect(await c.validate()).toBe(true);
        await c.complete();

        // First getChangedFiles — validate(true) sets _completed, result immediately available.
        const changed1 = c.getChangedFiles();
        expect(changed1).toEqual([]);

        // Expand file list: add c. Completion resets.
        c.setFiles([a, b, c_file]);
        // Before complete(): not ready.
        expect(c.getChangedFiles()).toEqual([]);

        // Second getChangedFiles after complete() — c is new, should appear as changed.
        await c.complete();
        const changed2 = c.getChangedFiles();
        expect(changed2).toEqual(["c.txt"]);
        // a and b should NOT be changed (remapped from prior validation).
        expect(changed2).not.toContain("a.txt");
        expect(changed2).not.toContain("b.txt");

        await c.serialize();
      }

      // Verify the cache is valid with the expanded list.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b, c_file]);
        expect(await c.validate()).toBe(true);
      }
    });

    it("setFiles with same files is a no-op", async () => {
      const cp = cachePath("remap-same");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate, then setFiles with identical list -> state preserved.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        await c.complete();

        c.setFiles(files); // same list

        expect(c.getChangedFiles()).toEqual([]);
        await c.serialize();
      }
    });

    it("remap + serialize produces a valid cache", async () => {
      const cp = cachePath("remap-roundtrip");
      const a = fixtureFile("a.txt");
      const b = fixtureFile("b.txt");
      const c_file = fixtureFile("c.txt");

      // Seed with [a, b, c].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b, c_file]);
        await c.serialize();
      }

      // Validate [a, b, c], then remap to [a, c] and serialize.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b, c_file]);
        expect(await c.validate()).toBe(true);
        c.setFiles([a, c_file]);
        await c.serialize();
      }

      // Re-open with [a, c] — should validate successfully.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, c_file]);
        expect(await c.validate()).toBe(true);
      }
    });
  });
});
