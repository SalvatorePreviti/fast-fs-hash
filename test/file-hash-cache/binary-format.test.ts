/**
 * Tests: FileHashCache binary format verification.
 *
 * On-disk format is LZ4-compressed: [magic:4][uncompressedSize:4][LZ4 block]
 * Tests verify the on-disk prefix, round-trip correctness, and that the
 * in-memory format exposes correct values via the context.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADER_SIZE, MAGIC } from "../../packages/fast-fs-hash/src/file-hash-cache-format";

// ─── Fixture setup ────────────────────────────────────────────────────

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-binary-format");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

// ─── Tests ────────────────────────────────────────────────────────────

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
  // ── On-disk format ──────────────────────────────────────────────────

  describe("on-disk format", () => {
    it("writes correct magic in header", async () => {
      const cp = cachePath("fmt");
      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, [fixtureFile("a.txt")], 99);
      await ctx.write();

      const data = readFileSync(cp);
      // On-disk: [header:96][LZ4 body]
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
      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx.write();

      const data = readFileSync(cp);
      // File must be larger than just the header (has compressed body)
      expect(data.length).toBeGreaterThan(HEADER_SIZE);
      // But smaller than header + full uncompressed body (LZ4 compresses)
      // Each entry = 48 bytes + 4 byte pathEnd. 3 files ~ 156 bytes body.
      // Compressed should be smaller, so total < 96 + 156 + 16 slack
      expect(data.length).toBeLessThan(HEADER_SIZE + 200);
    });

    it("header size is 80 bytes", () => {
      expect(HEADER_SIZE).toBe(80);
    });
  });

  // ── In-memory format via context ──────────────────────────────────

  describe("in-memory format via context", () => {
    it("exposes correct file count for single file", async () => {
      const cp = cachePath("ctx1");
      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, [fixtureFile("a.txt")], 42);
      expect(ctx.fileCount).toBe(1);
      await ctx.write();
    });

    it("exposes correct file count for multiple files", async () => {
      const cp = cachePath("ctx2");
      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, [fixtureFile("a.txt"), fixtureFile("b.txt")], 1);
      expect(ctx.fileCount).toBe(2);
      await ctx.write();
    });

    it("user values round-trip through write and re-read", async () => {
      const cp = cachePath("ctxuv");
      const files = [fixtureFile("a.txt")];
      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write({
        userValue0: 0xdead,
        userValue1: 0xbeef,
        userValue2: 0xcafe,
        userValue3: 0xbabe,
      });

      // Re-open and verify user values survived the round-trip
      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.userValue0).toBe(0xdead);
      expect(ctx2.userValue1).toBe(0xbeef);
      expect(ctx2.userValue2).toBe(0xcafe);
      expect(ctx2.userValue3).toBe(0xbabe);
    });
  });

  // ── Re-validate with separate opens ────────────────────────────

  describe("re-validate with separate opens", () => {
    it("can open and re-validate twice", async () => {
      const cp = cachePath("reval");
      const files = [fixtureFile("a.txt")];

      // Create initial cache
      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      // First re-validate
      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).toBe("upToDate");

      // Second re-validate
      const ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx3.status).toBe("upToDate");
    });
  });

  // ── Fingerprint validation ─────────────────────────────────────────

  describe("fingerprint validation", () => {
    it("throws on wrong-length Uint8Array", async () => {
      await expect(FileHashCache.open(cachePath(), FIXTURE_DIR, [], 0, new Uint8Array(8))).rejects.toThrow();
      await expect(FileHashCache.open(cachePath(), FIXTURE_DIR, [], 0, new Uint8Array(32))).rejects.toThrow();
    });

    it("omitted fingerprint defaults to zero (round-trips)", async () => {
      const cp = cachePath("fp-zero");
      const files = [fixtureFile("a.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).toBe("upToDate");
    });
  });
});
