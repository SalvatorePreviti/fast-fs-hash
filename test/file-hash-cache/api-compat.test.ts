import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileHashCache } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache";
import {
  ENTRY_STRIDE,
  H_FILE_COUNT,
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

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-api-compat");
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
  //  - Error handling

  describe("error handling", () => {
    it("serialize throws if not writable", async () => {
      const c = new FileHashCache(cachePath(), { version: 1 });
      c.setFiles([]);
      await c.validate();
      await expect(c.serialize()).rejects.toThrow("writable");
    });

    it("serialize without validate returns 'deleted' for empty files", async () => {
      const c = new FileHashCache(cachePath(), { version: 1, writable: true });
      c.setFiles([]);
      const result = await c.serialize();
      expect(result).toBe("deleted");
      await c.dispose();
    });

    it("write throws without prior serialize", async () => {
      const c = new FileHashCache(cachePath(), { version: 1, writable: true });
      c.setFiles([]);
      await c.validate();
      await expect(c.write(Buffer.from("data"))).rejects.toThrow("serialize");
    });

    it("read returns 0 when no file is open", async () => {
      const c = new FileHashCache(cachePath());
      c.setFiles([]);
      const buf = Buffer.alloc(16);
      const n = await c.read(buf);
      expect(n).toBe(0);
    });
  });

  //  - dispose behavior

  describe("dispose", () => {
    it("dispose is safe to call multiple times", async () => {
      const c = new FileHashCache(cachePath());
      await c.dispose();
      await c.dispose();
      await c.dispose();
    });

    it("getFiles still works after dispose", async () => {
      const c = new FileHashCache(cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      await c.dispose();
      expect(c.getFiles()).toEqual([fixtureFile("a.txt")]);
    });

    it("Symbol.asyncDispose calls dispose", async () => {
      const cp = cachePath("dispose");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // File should exist after dispose (rename happened).
      const data = readFileSync(cp);
      expect(data.length).toBeGreaterThanOrEqual(HEADER_SIZE);
    });

    it("validate throws after dispose", async () => {
      const c = new FileHashCache(cachePath(), { version: 1 });
      c.setFiles([fixtureFile("a.txt")]);
      await c.dispose();
      await expect(c.validate()).rejects.toThrow("disposed");
    });

    it("serialize throws after dispose", async () => {
      const c = new FileHashCache(cachePath(), { version: 1, writable: true });
      c.setFiles([fixtureFile("a.txt")]);
      await c.dispose();
      await expect(c.serialize()).rejects.toThrow("disposed");
    });

    it("validate throws if already validated", async () => {
      const cp = cachePath("double-validate");
      const files = [fixtureFile("a.txt")];

      // Create a valid cache first.
      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.serialize();
      }

      const c = new FileHashCache(cp, { version: 1 });
      c.setFiles(files);
      await c.validate();
      await expect(c.validate()).rejects.toThrow("single-use");
      await c.dispose();
    });
  });

  //  - Binary format verification

  describe("binary format", () => {
    it("writes correct header magic and version", async () => {
      const cp = cachePath("fmt");
      {
        await using c = new FileHashCache(cp, { version: 99, writable: true });
        c.setFiles([fixtureFile("a.txt")]);
        await c.validate();
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, 16);
      expect(u32[H_MAGIC]).toBe(MAGIC);
      expect(u32[H_VERSION]).toBe(99);
    });

    it("writes correct file count with backend wasm bit", async () => {
      const cp = cachePath("fmtfc");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      let expectedWasmBit = 0;

      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        expectedWasmBit = c.libraryStatus === "wasm" ? 1 : 0;
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, 16);
      const rawFC = u32[H_FILE_COUNT];
      expect(rawFC >>> 1).toBe(2);
      expect(rawFC & 1).toBe(expectedWasmBit);
    });

    it("writes correct file count with wasm bit = 1 for wasm", async () => {
      const cp = cachePath("fmtwasm");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCacheWasm(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, 16);
      const rawFC = u32[H_FILE_COUNT];
      expect(rawFC >>> 1).toBe(1);
      expect(rawFC & 1).toBe(1); // wasm
    });

    it("header size is exactly 64 bytes", async () => {
      const cp = cachePath("fmthdr");
      const files = [fixtureFile("a.txt")];
      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, 16);
      const pathsLen = u32[H_PATHS_LEN];
      // Total size = header + 1 entry + paths.
      expect(data.length).toBe(HEADER_SIZE + ENTRY_STRIDE + pathsLen);
      // Header occupies exactly the first 64 bytes.
      expect(HEADER_SIZE).toBe(64);
    });

    it("file size matches expected layout", async () => {
      const cp = cachePath("fmtsize");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, 16);
      const fileCount = u32[H_FILE_COUNT] >>> 1;
      const pathsLen = u32[H_PATHS_LEN];
      const expectedSize = HEADER_SIZE + fileCount * ENTRY_STRIDE + pathsLen;
      expect(data.length).toBe(expectedSize);
    });

    it("user values are written to correct header slots", async () => {
      const cp = cachePath("fmtuv");
      const files = [fixtureFile("a.txt")];
      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        c.userValue0 = 0xdead;
        c.userValue1 = 0xbeef;
        c.userValue2 = 0xcafe;
        c.userValue3 = 0xbabe;
        await c.serialize();
      }

      const data = readFileSync(cp);
      const u32 = new Uint32Array(data.buffer, data.byteOffset, 16);
      expect(u32[H_USER + 0]).toBe(0xdead);
      expect(u32[H_USER + 1]).toBe(0xbeef);
      expect(u32[H_USER + 2]).toBe(0xcafe);
      expect(u32[H_USER + 3]).toBe(0xbabe);
    });
  });

  //  - Re-validate with separate instances

  describe("re-validate with separate instances", () => {
    it("can create a new instance and re-validate", async () => {
      const cp = cachePath("reval");
      const files = [fixtureFile("a.txt")];

      // Create initial cache.
      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Re-validate with a fresh instance.
      {
        await using c = new FileHashCache(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }

      // And again.
      {
        await using c = new FileHashCache(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });
  });

  //  - Multiple files

  describe("multiple files", () => {
    it("handles 3 files round-trip", async () => {
      const cp = cachePath("multi");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
        expect(c.getFiles().length).toBe(3);
      }
    });

    it("detects change in one of many files", async () => {
      const cp = cachePath("multi-change");
      const mutable = fixtureFile("multi-mut.txt");
      writeFileSync(mutable, "original");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), mutable];

      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      await sleep(50);
      writeFileSync(mutable, "changed!");

      {
        await using c = new FileHashCache(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });
  });

  //  - Fingerprint

  describe("fingerprint", () => {
    it("same fingerprint -> not changed", async () => {
      const cp = cachePath("fp-same");
      const files = [fixtureFile("a.txt")];
      const fp = new Uint8Array(16);
      fp.fill(0xab);

      {
        await using c = new FileHashCache(cp, {
          version: 1,
          writable: true,
          fingerprint: fp,
        });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(cp, {
          version: 1,
          fingerprint: fp,
        });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("different fingerprint -> changed", async () => {
      const cp = cachePath("fp-diff");
      const files = [fixtureFile("a.txt")];
      const fp1 = new Uint8Array(16);
      fp1.fill(0x11);
      const fp2 = new Uint8Array(16);
      fp2.fill(0x22);

      {
        await using c = new FileHashCache(cp, {
          version: 1,
          writable: true,
          fingerprint: fp1,
        });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(cp, {
          version: 1,
          fingerprint: fp2,
        });
        c.setFiles(files);
        expect(await c.validate()).toBe(false);
      }
    });

    it("omitted fingerprint defaults to zero", async () => {
      const cp = cachePath("fp-zero");
      const files = [fixtureFile("a.txt")];

      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      {
        await using c = new FileHashCache(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });

    it("throws on string fingerprint", () => {
      expect(() => {
        new FileHashCache(cachePath(), { fingerprint: "hello" as never });
      }).toThrow(TypeError);
    });

    it("throws on wrong-length Uint8Array", () => {
      expect(() => {
        new FileHashCache(cachePath(), { fingerprint: new Uint8Array(8) });
      }).toThrow(TypeError);
      expect(() => {
        new FileHashCache(cachePath(), { fingerprint: new Uint8Array(32) });
      }).toThrow(TypeError);
    });
  });

  //  - FileHashCacheWasm

  describe("FileHashCacheWasm", () => {
    it("full round-trip with wasm backend", async () => {
      const cp = cachePath("wasm-rt");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const userData = Buffer.from("wasm-payload");

      {
        await using c = new FileHashCacheWasm(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
        await c.write(userData);
        c.position += userData.length;
      }

      {
        await using c = new FileHashCacheWasm(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);

        const buf = Buffer.alloc(userData.length);
        await c.read(buf);
        expect(buf.toString()).toBe("wasm-payload");
      }
    });

    it("native and wasm backends produce interchangeable caches", async () => {
      const cp = cachePath("cross-backend");
      const files = [fixtureFile("a.txt")];

      // Write with native.
      {
        await using c = new FileHashCache(cp, { version: 1, writable: true });
        c.setFiles(files);
        await c.validate();
        await c.serialize();
      }

      // Validate with wasm (wasm bit differs but hashes are identical).
      {
        await using c = new FileHashCacheWasm(cp, { version: 1 });
        c.setFiles(files);
        expect(await c.validate()).toBe(true);
      }
    });
  });
});
