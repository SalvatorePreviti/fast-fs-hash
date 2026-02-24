import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache, XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-lifecycle");
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
  //  - validate without prior setFiles

  describe("validate (no existing cache)", () => {
    it("returns false without setFiles and no cache", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath());
      expect(await c.validate()).toBe(false);
    });

    it("returns false for non-existent cache file", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      expect(await c.validate()).toBe(false);
    });

    it("returns changed=false with empty file list", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([]);
      expect(await c.validate()).toBe(true);
    });
  });

  //  - validate sets completion state

  describe("validate sets completion state", () => {
    it("getChangedFiles() after successful validate returns [] without triggering complete()", async () => {
      const cp = cachePath("val-complete");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate (unchanged) then getChangedFiles — must return same reference each time.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        const first = c.getChangedFiles();
        const second = c.getChangedFiles();
        expect(first).toEqual([]);
        expect(first).toBe(second); // cached reference
      }
    });

    it("getFileHash() returns populated data after successful validate without calling complete()", async () => {
      const cp = cachePath("val-hash");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        // Hashes loaded from cache — no complete() needed.
        expect(c.getFileHash(0)).not.toBeNull();
        expect(c.getFileHash(0)?.some((b) => b !== 0)).toBe(true);
        expect(c.getFileHash(1)).not.toBeNull();
        expect(c.getFileHash(1)?.some((b) => b !== 0)).toBe(true);
      }
    });

    it("getChangedFiles() returns [] after failed validate until complete() is called", async () => {
      const cp = cachePath("val-changed");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed with one set of files.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([fixtureFile("a.txt")]);
        await c.serialize();
      }

      // Validate with different file list — returns false.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        // Before complete(): returns [] (not ready).
        expect(c.getChangedFiles()).toEqual([]);
        // After complete(): returns actual changed files.
        await c.complete();
        const changed = c.getChangedFiles();
        expect(Array.isArray(changed)).toBe(true);
        expect(changed.length).toBeGreaterThan(0);
      }
    });
  });

  //  - write + validate round-trip

  describe("serialize -> close -> validate round-trip", () => {
    it("basic round-trip: serialize then validate unchanged", async () => {
      const cp = cachePath("rt");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Write cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        await c.serialize();
      }

      // Validate (should be unchanged).
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("stores and retrieves user data", async () => {
      const cp = cachePath("userdata");
      const userData = Buffer.from("custom payload 12345");
      const files = [fixtureFile("a.txt")];

      // Write with user data.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
        await c.write(userData);
        c.position += userData.length;
      }

      // Read user data back.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);

        const buf = Buffer.alloc(userData.length);
        const bytesRead = await c.read(buf);
        expect(bytesRead).toBe(userData.length);
        expect(buf.toString()).toBe("custom payload 12345");
      }
    });

    it("stores and reads userValue0-3", async () => {
      const cp = cachePath("uv");
      const files = [fixtureFile("a.txt")];

      // Write with user values.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        c.userValue0 = 111;
        c.userValue1 = 222;
        c.userValue2 = 333;
        c.userValue3 = 444;
        await c.serialize();
      }

      // Read user values.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        expect(c.userValue0).toBe(111);
        expect(c.userValue1).toBe(222);
        expect(c.userValue2).toBe(333);
        expect(c.userValue3).toBe(444);
      }
    });

    it("empty file list round-trip", async () => {
      const cp = cachePath("empty");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([]);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([]);
        expect(await c.validate()).toBe(true);
      }
    });
  });

  //  - Change detection

  describe("change detection", () => {
    it("detects version mismatch", async () => {
      const cp = cachePath("ver");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 2 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });

    it("detects file list change (added file)", async () => {
      const cp = cachePath("add");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files1);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files2);
        expect(await c.validate()).toBe(false);
      }
    });

    it("detects file list change (removed file)", async () => {
      const cp = cachePath("rm");
      const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const files2 = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files1);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files2);
        expect(await c.validate()).toBe(false);
      }
    });

    it("detects file content change", async () => {
      const cp = cachePath("content");
      const mutable = fixtureFile("mutable.txt");
      writeFileSync(mutable, "original content");
      const files = [mutable];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Modify the file (same size -> triggers rehash path).
      await sleep(50);
      writeFileSync(mutable, "modified content");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });

    it("detects file size change", async () => {
      const cp = cachePath("size");
      const mutable = fixtureFile("size-change.txt");
      writeFileSync(mutable, "short");
      const files = [mutable];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      await sleep(50);
      writeFileSync(mutable, "much longer content here!!!");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });

    it("same content after metadata change -> not changed", async () => {
      const cp = cachePath("meta");
      const mutable = fixtureFile("meta-change.txt");
      writeFileSync(mutable, "stable content here");
      const files = [mutable];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Rewrite with identical content — metadata changes, hash same.
      await sleep(50);
      writeFileSync(mutable, "stable content here");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("detects deleted file", async () => {
      const cp = cachePath("del");
      const mutable = fixtureFile("will-delete.txt");
      writeFileSync(mutable, "soon to be gone");
      const files = [mutable];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      rmSync(mutable, { force: true });

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });
  });

  //  - Serialize with validation state

  describe("serialize uses validation state", () => {
    it("serialize after unchanged validate re-creates the cache", async () => {
      const cp = cachePath("ser-unchanged");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Initial write.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Re-open, validate (unchanged), then serialize again.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        await c.serialize();
      }

      // Validate once more — should still be valid.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("serialize after changed validate writes valid cache", async () => {
      const cp = cachePath("ser-changed");
      const mutable = fixtureFile("ser-mut.txt");
      writeFileSync(mutable, "initial");
      const files = [fixtureFile("a.txt"), mutable];

      // Initial write.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Modify file.
      await sleep(50);
      writeFileSync(mutable, "changed!!!");

      // Serialize after change.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        await c.serialize();
      }

      // Final validate — should be valid now.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });
  });

  //  - Serialize without validate

  describe("serialize without validate", () => {
    it("cold write — hashes all files from scratch", async () => {
      const cp = cachePath("no-val");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // serialize without calling validate first
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate the resulting cache — should be unchanged (all correct).
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("cold write produces same cache as validate+serialize", async () => {
      const cpCold = cachePath("cold-only");
      const cpWarm = cachePath("warm-compare");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      // Cold: serialize without validate
      {
        await using c = new FileHashCache(FIXTURE_DIR, cpCold, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Warm: validate then serialize
      {
        await using c = new FileHashCache(FIXTURE_DIR, cpWarm, { version: 1 });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Both should validate identically.
      {
        await using c1 = new FileHashCache(FIXTURE_DIR, cpCold, { version: 1 });
        c1.setFiles(files);
        expect(await c1.validate()).toBe(true);

        await using c2 = new FileHashCache(FIXTURE_DIR, cpWarm, { version: 1 });
        c2.setFiles(files);
        expect(await c2.validate()).toBe(true);
      }
    });

    it("cold write with 3 files round-trip", async () => {
      const cp = cachePath("no-val-multi");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        expect(c.currentFiles.length).toBe(3);
      }
    });

    it("cold write with empty file list", async () => {
      const cp = cachePath("no-val-empty");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([]);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([]);
        expect(await c.validate()).toBe(true);
        expect(c.currentFiles.length).toBe(0);
      }
    });

    it("cold write preserves userValue0-1", async () => {
      const cp = cachePath("no-val-uv");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        c.userValue0 = 42;
        c.userValue1 = 100;
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        expect(c.userValue0).toBe(42);
        expect(c.userValue1).toBe(100);
      }
    });

    it("cold write + write user data round-trip", async () => {
      const cp = cachePath("no-val-wd");
      const files = [fixtureFile("a.txt")];
      const payload = Buffer.from("cold-payload");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
        await c.write(payload);
        c.position += payload.length;
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        const buf = Buffer.alloc(64);
        const n = await c.read(buf);
        expect(buf.subarray(0, n).toString()).toBe("cold-payload");
      }
    });

    it("cold write detects subsequent file change", async () => {
      const cp = cachePath("no-val-detect");
      const mutable = fixtureFile("no-val-mut.txt");
      writeFileSync(mutable, "before");
      const files = [fixtureFile("a.txt"), mutable];

      // Cold write without validate.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Modify the file.
      await sleep(50);
      writeFileSync(mutable, "after");

      // Now validate — should detect the change.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });
  });
});
