/**
 * Tests: FileHashCache binary format verification.
 *
 * On-disk format is LZ4-compressed: [magic:4][uncompressedSize:4][LZ4 block]
 * Tests verify the on-disk prefix, round-trip correctness, and that the
 * in-memory format exposes correct values via the context.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileHashCacheSession } from "fast-fs-hash";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADER_SIZE, MAGIC } from "../../packages/fast-fs-hash/src/file-hash-cache-format";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-binary-format");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

async function withCache<T>(
  cp: string,
  files: string[],
  opts: { rootPath?: string; version: number; fingerprint?: Uint8Array },
  run: (session: FileHashCacheSession) => Promise<T> | T
): Promise<T> {
  const cache = new FileHashCache({ cachePath: cp, files, rootPath: opts.rootPath ?? FIXTURE_DIR, ...opts });
  await using session = await cache.open();
  return await run(session);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

//  - Tests

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  writeFileSync(fixtureFile("a.txt"), "hello world\n");
  writeFileSync(fixtureFile("b.txt"), "goodbye world\n");
  writeFileSync(fixtureFile("c.txt"), "third file\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileHashCache binary format [native]", () => {
  //  - On-disk format

  describe("on-disk format", () => {
    it("writes correct magic in header", async () => {
      const cp = cachePath("fmt");
      await withCache(cp, [fixtureFile("a.txt")], { version: 99 }, async (session) => {
        await session.write();
      });

      const data = readFileSync(cp);
      // On-disk: [header:80][LZ4 body]
      expect(data.length).toBeGreaterThan(HEADER_SIZE);
      expect(data.readUInt32LE(0)).toBe(MAGIC);
      // Version at byte 4 should be 99
      expect(data.readUInt32LE(4)).toBe(99);
      // File count at byte 8 should be 1
      expect(data.readUInt32LE(8)).toBe(1);
    });

    it("on-disk file has header + LZ4 body", async () => {
      const cp = cachePath("compressed");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });

      const data = readFileSync(cp);
      // File must be larger than just the header (has compressed body)
      expect(data.length).toBeGreaterThan(HEADER_SIZE);
      // But smaller than header + full uncompressed body (LZ4 compresses)
      // Each entry = 48 bytes + 4 byte pathEnd. 3 files ~ 156 bytes body.
      // Compressed should be smaller, so total < 96 + 156 + 16 slack
      expect(data.length).toBeLessThan(HEADER_SIZE + 200);
    });

    it("header size is 96 bytes", () => {
      expect(HEADER_SIZE).toBe(96);
    });
  });

  //  - In-memory format via context

  describe("in-memory format via context", () => {
    it("exposes correct file count for single file", async () => {
      const cp = cachePath("ctx1");
      const fc = await withCache(cp, [fixtureFile("a.txt")], { version: 42 }, async (session) => {
        const n = session.fileCount;
        await session.write();
        return n;
      });
      expect(fc).toBe(1);
    });

    it("exposes correct file count for multiple files", async () => {
      const cp = cachePath("ctx2");
      const fc = await withCache(cp, [fixtureFile("a.txt"), fixtureFile("b.txt")], { version: 1 }, async (session) => {
        const n = session.fileCount;
        await session.write();
        return n;
      });
      expect(fc).toBe(2);
    });

    it("user values round-trip through write and re-read", async () => {
      const cp = cachePath("ctxuv");
      const files = [fixtureFile("a.txt")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write({
          userValue0: 0xdead,
          userValue1: 0xbeef,
          userValue2: 0xcafe,
          userValue3: 0xbabe,
        });
      });

      // Re-open and verify user values survived the round-trip
      const userValues = await withCache(
        cp,
        files,
        { version: 1 },
        (session) => [session.userValue0, session.userValue1, session.userValue2, session.userValue3] as const
      );
      expect(userValues[0]).toBe(0xdead);
      expect(userValues[1]).toBe(0xbeef);
      expect(userValues[2]).toBe(0xcafe);
      expect(userValues[3]).toBe(0xbabe);
    });
  });

  //  - Re-validate with separate opens

  describe("re-validate with separate opens", () => {
    it("can open and re-validate twice", async () => {
      const cp = cachePath("reval");
      const files = [fixtureFile("a.txt")];

      // Create initial cache
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });

      // First re-validate
      const status1 = await withCache(cp, files, { version: 1 }, (session) => session.status);
      expect(status1).toBe("upToDate");

      // Second re-validate
      const status2 = await withCache(cp, files, { version: 1 }, (session) => session.status);
      expect(status2).toBe("upToDate");
    });
  });

  //  - Fingerprint validation

  describe("fingerprint validation", () => {
    it("throws on wrong-length Uint8Array", async () => {
      await expect(
        new FileHashCache({
          cachePath: cachePath(),
          files: [],
          rootPath: FIXTURE_DIR,
          version: 0,
          fingerprint: new Uint8Array(8),
        }).open()
      ).rejects.toThrow();
      await expect(
        new FileHashCache({
          cachePath: cachePath(),
          files: [],
          rootPath: FIXTURE_DIR,
          version: 0,
          fingerprint: new Uint8Array(32),
        }).open()
      ).rejects.toThrow();
    });

    it("omitted fingerprint defaults to zero (round-trips)", async () => {
      const cp = cachePath("fp-zero");
      const files = [fixtureFile("a.txt")];

      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });

      const status = await withCache(cp, files, { version: 1 }, (session) => session.status);
      expect(status).toBe("upToDate");
    });
  });
});
