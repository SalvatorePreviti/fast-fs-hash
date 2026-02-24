import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache, FileHashCacheWasm, XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENTRY_STRIDE,
  H_FILE_COUNT,
  H_PATHS_LEN,
  HEADER_SIZE,
} from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-base";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-io-edge");
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
  //  - readv / writev

  describe("readv / writev", () => {
    it("writev writes multiple buffers and readv reads them back", async () => {
      const cp = cachePath("rv-wv");
      const files = [fixtureFile("a.txt")];
      const buf1 = Buffer.from("chunk-one");
      const buf2 = Buffer.from("chunk-two");
      const buf3 = Buffer.from("chunk-three");

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
        const pos = c.position;
        await c.writev([buf1, buf2, buf3], pos);
        c.position = pos + buf1.length + buf2.length + buf3.length;
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        const r1 = Buffer.alloc(buf1.length);
        const r2 = Buffer.alloc(buf2.length);
        const r3 = Buffer.alloc(buf3.length);
        const totalRead = await c.readv([r1, r2, r3]);
        expect(totalRead).toBe(buf1.length + buf2.length + buf3.length);
        expect(r1.toString()).toBe("chunk-one");
        expect(r2.toString()).toBe("chunk-two");
        expect(r3.toString()).toBe("chunk-three");
      }
    });

    it("readv returns 0 when no file is open", async () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([]);
      const buf = Buffer.alloc(16);
      expect(await c.readv([buf])).toBe(0);
      await c.dispose();
    });

    it("writev throws without prior serialize", async () => {
      const c = new FileHashCache(FIXTURE_DIR, cachePath(), { version: 1 });
      c.setFiles([]);
      await c.validate();
      await expect(c.writev([Buffer.from("x")])).rejects.toThrow("serialize");
      await c.dispose();
    });

    it("readv with empty array returns 0", async () => {
      const cp = cachePath("rv-empty");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        expect(await c.readv([])).toBe(0);
      }
    });

    it("writev with empty array is a no-op", async () => {
      const cp = cachePath("wv-empty");
      const files = [fixtureFile("a.txt")];

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
      // Should not throw.
      await c.writev([]);
    });
  });

  //  - Validate without setFiles (reads file list from cache)

  describe("validate without setFiles", () => {
    it("returns false when no cache exists", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath("no-sf-nocache"), { version: 1 });
      expect(await c.validate()).toBe(false);
      expect(c.currentFiles).toEqual([]);
    });

    it("reads file list from existing cache and validates unchanged", async () => {
      const cp = cachePath("no-sf-valid");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate without setFiles — reads file list from cache file.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(true);
        expect(c.currentFiles).toEqual(["a.txt", "b.txt"]);
      }
    });

    it("reads file list from cache and detects changes", async () => {
      const cp = cachePath("no-sf-changed");
      const mutable = fixtureFile("no-sf-mut.txt");
      writeFileSync(mutable, "original");
      const files = [fixtureFile("a.txt"), mutable];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      await sleep(50);
      writeFileSync(mutable, "changed!");

      // Validate without setFiles — should detect the change.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(false);
        expect(c.currentFiles).toEqual(["a.txt", "no-sf-mut.txt"]);
      }
    });

    it("populates user values from cache when valid", async () => {
      const cp = cachePath("no-sf-uv");
      const files = [fixtureFile("a.txt")];

      // Seed with user values.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        c.userValue0 = 100;
        c.userValue1 = 200;
        c.userValue2 = 300;
        c.userValue3 = 400;
        await c.serialize();
      }

      // Validate without setFiles — user values should be populated.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(true);
        expect(c.userValue0).toBe(100);
        expect(c.userValue1).toBe(200);
        expect(c.userValue2).toBe(300);
        expect(c.userValue3).toBe(400);
      }
    });

    it("read() works after validate without setFiles", async () => {
      const cp = cachePath("no-sf-read");
      const files = [fixtureFile("a.txt")];
      const userData = Buffer.from("hello user data");

      // Seed with user data.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
        const pos = c.position;
        await c.write(userData, pos);
        c.position = pos + userData.length;
      }

      // Read back without setFiles.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(true);
        const buf = Buffer.alloc(userData.length);
        const n = await c.read(buf);
        expect(n).toBe(userData.length);
        expect(buf.toString()).toBe("hello user data");
      }
    });

    it("getChangedFiles works after validate-without-setFiles", async () => {
      const cp = cachePath("no-sf-gc");
      const mutable = fixtureFile("no-sf-gc-mut.txt");
      writeFileSync(mutable, "seed content");
      const files = [fixtureFile("a.txt"), mutable];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      await sleep(50);
      writeFileSync(mutable, "new content!");

      // Validate without setFiles, then complete(), then getChangedFiles.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(false);
        // Not ready until complete().
        expect(c.getChangedFiles()).toEqual([]);
        await c.complete();
        const changed = c.getChangedFiles();
        expect(changed).toContain("no-sf-gc-mut.txt");
        expect(changed).not.toContain("a.txt");
      }
    });

    it("setFiles after validate-without-setFiles remaps entries", async () => {
      const cp = cachePath("no-sf-remap");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate without setFiles (all unchanged), then setFiles with subset.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(true);

        // Now narrow file list.
        c.setFiles([fixtureFile("a.txt"), fixtureFile("c.txt")]);
        await c.complete();
        const changed = c.getChangedFiles();
        // a.txt and c.txt should be unchanged (remapped from validation state).
        expect(changed).toEqual([]);
      }
    });

    it("serialize after validate-without-setFiles produces valid cache", async () => {
      const cp = cachePath("no-sf-ser");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed the cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate without setFiles, then serialize.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(true);
        await c.serialize();
      }

      // Re-validate to confirm the cache is still valid.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });
  });

  //  - Edge cases

  describe("edge cases", () => {
    it("non-existent file in file list", async () => {
      const cp = cachePath("nofile");
      const files = [fixtureFile("no-such-file.txt")];

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      expect(await c.validate()).toBe(false);
      // Should not throw.
      await c.serialize();
    });

    it("corrupted cache file (bad magic)", async () => {
      const cp = cachePath("corrupt");
      writeFileSync(cp, Buffer.alloc(64, 0xff));

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      expect(await c.validate()).toBe(false);
    });

    it("truncated cache file (too short for header)", async () => {
      const cp = cachePath("trunc");
      writeFileSync(cp, Buffer.alloc(32));

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      expect(await c.validate()).toBe(false);
    });

    it("cache with fewer encoded paths than header file count is invalid", async () => {
      const cp = cachePath("bad-path-count");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, HEADER_SIZE / 4);
      const fileCount = u32[H_FILE_COUNT];
      const pathsStart = HEADER_SIZE + fileCount * ENTRY_STRIDE;
      const pathsLen = u32[H_PATHS_LEN];
      const paths = data.subarray(pathsStart, pathsStart + pathsLen);
      const firstPathLen = paths.indexOf(0) + 1;
      u32[H_PATHS_LEN] = firstPathLen;
      writeFileSync(cp, data.subarray(0, pathsStart + firstPathLen));

      // validate() without setFiles reads file list from cache paths section.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(false);
      }

      {
        await using c = new FileHashCacheWasm(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(false);
      }
    });

    it("empty cache file (0 bytes)", async () => {
      const cp = cachePath("empty-file");
      writeFileSync(cp, Buffer.alloc(0));

      await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      expect(await c.validate()).toBe(false);
    });

    it("rapid validate+serialize cycles detect deterministic file mutation", async () => {
      const cpNative = cachePath("rapid-cycle-native");
      const cpWasm = cachePath("rapid-cycle-wasm");

      const mutPath = fixtureFile("rapid-cycle.txt");
      writeFileSync(mutPath, "A".repeat(100));
      const files = [mutPath, fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        await using c = new FileHashCache(FIXTURE_DIR, cpNative, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        expect(await c.serialize()).toBe("written");
      }

      {
        await using c = new FileHashCacheWasm(FIXTURE_DIR, cpWasm, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        expect(await c.serialize()).toBe("written");
      }

      for (let i = 0; i < 6; i++) {
        const body = Buffer.alloc(100, 0x78);
        body[0] = String.fromCharCode(0x41 + ((i + 1) % 26)).charCodeAt(0);
        body[1] = 0x30 + ((i + 1) % 10);
        writeFileSync(mutPath, body);
        const t = new Date(1700001000000 + i * 1000);
        utimesSync(mutPath, t, t);

        {
          await using c = new FileHashCache(FIXTURE_DIR, cpNative, { version: 1 });
          c.setFiles(files);
          expect(await c.validate()).toBe(false);
          expect(await c.serialize()).toBe("written");
        }

        {
          await using c = new FileHashCacheWasm(FIXTURE_DIR, cpWasm, { version: 1 });
          c.setFiles(files);
          expect(await c.validate()).toBe(false);
          expect(await c.serialize()).toBe("written");
        }
      }
    });

    it("setFiles with same list after complete preserves _completed", async () => {
      const cp = cachePath("same-list-complete");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate -> getChangedFiles -> setFiles(same) -> getChangedFiles should still work.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        await c.complete();

        const beforeReset = c.getChangedFiles();
        expect(beforeReset).toEqual([]);

        // setFiles with identical list — _completed must be preserved.
        c.setFiles(files);
        const afterReset = c.getChangedFiles();
        expect(afterReset).toEqual([]);
      }
    });

    it("setFiles with same list after validate (no complete) preserves state", async () => {
      const cp = cachePath("same-list-nocompl");
      const files = [fixtureFile("a.txt")];

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Validate -> setFiles(same) -> getChangedFiles.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        c.setFiles(files); // same list
        expect(c.getChangedFiles()).toEqual([]);
      }
    });

    it("validate-without-setFiles -> false -> serialize rewrites cache", async () => {
      const cp = cachePath("no-sf-rewrite");
      const mutable = fixtureFile("edge-rewrite-mut.txt");
      writeFileSync(mutable, "original");
      const files = [fixtureFile("a.txt"), mutable];

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Mutate a tracked file.
      await sleep(50);
      writeFileSync(mutable, "modified!");

      // Validate without setFiles (detects change), then serialize.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        expect(await c.validate()).toBe(false);
        await c.serialize();
      }

      // The updated cache should now validate cleanly.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("serialize without setFiles or validate deletes cache", async () => {
      const cp = cachePath("cold-delete");
      const files = [fixtureFile("a.txt")];

      // Seed a valid cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        await c.serialize();
      }

      // Open without setting files or validating -> serialize deletes.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        const result = await c.serialize();
        expect(result).toBe("deleted");
      }

      // Cache file is gone — validate fails.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });

    it("validate(true) -> serialize produces valid cache", async () => {
      const cp = cachePath("valid-reserialize");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        c.userValue0 = 42;
        await c.serialize();
      }

      // validate returns true, but user serializes anyway.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        c.userValue0 = 99; // change user value
        await c.serialize();
      }

      // Cache should be valid with the new user value.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        expect(c.userValue0).toBe(99);
      }
    });
  });
});
