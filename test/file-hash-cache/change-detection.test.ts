/**
 * Tests: FileHashCache change detection — ported from V1 lifecycle.test.ts.
 *
 * Covers version mismatch, file content/size/metadata changes, deleted files,
 * file list add/remove.
 */

import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ─── Fixture setup ────────────────────────────────────────────────────

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-change");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("FileHashCache change detection [native]", () => {
  // ── Version / fingerprint ─────────────────────────────────────────

  describe("version and fingerprint", () => {
    it("detects version mismatch", async () => {
      const cp = cachePath("ver");
      const files = [fixtureFile("a.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 2);
      expect(ctx2.status).toBe("stale");
    });

    it("same fingerprint is upToDate", async () => {
      const cp = cachePath("fp-same");
      const files = [fixtureFile("a.txt")];
      const fp = new Uint8Array(16).fill(0xab);

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1, fp);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1, fp);
      expect(ctx2.status).toBe("upToDate");
    });

    it("different fingerprint is stale", async () => {
      const cp = cachePath("fp-diff");
      const files = [fixtureFile("a.txt")];
      const fp1 = new Uint8Array(16).fill(0x11);
      const fp2 = new Uint8Array(16).fill(0x22);

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1, fp1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1, fp2);
      expect(ctx2.status).toBe("stale");
    });
  });

  // ── File content / metadata changes ───────────────────────────────

  describe("file changes", () => {
    it("detects file content change", async () => {
      const cp = cachePath("content");
      const mutable = fixtureFile("mut-content.txt");
      writeFileSync(mutable, "original content");
      const files = [mutable];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      await sleep(50);
      writeFileSync(mutable, "modified content");

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).toBe("changed");
    });

    it("detects file size change", async () => {
      const cp = cachePath("size");
      const mutable = fixtureFile("mut-size.txt");
      writeFileSync(mutable, "short");
      const files = [mutable];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      await sleep(50);
      writeFileSync(mutable, "much longer content here!!!");

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).toBe("changed");
    });

    it("same content after metadata change round-trips correctly", async () => {
      const cp = cachePath("meta");
      const mutable = fixtureFile("mut-meta.txt");
      writeFileSync(mutable, "stable content here");
      const files = [mutable];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      // Rewrite with identical content — metadata changes, hash same.
      await sleep(50);
      writeFileSync(mutable, "stable content here");

      // Native does stat+size+rehash optimization -> "statsDirty" (stat changed, content same).
      // Stat change detected -> "changed".
      // Either is acceptable — the important thing is no error and a valid cache.
      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(["statsDirty", "changed"]).toContain(ctx2.status);
      if (ctx2.status !== "upToDate") {
        await ctx2.write();
      }

      // After update, re-checking should be upToDate (stat hash now matches)
      const ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx3.status).toBe("upToDate");
    });

    it("detects deleted file", async () => {
      const cp = cachePath("del");
      const mutable = fixtureFile("will-delete.txt");
      writeFileSync(mutable, "soon to be gone");
      const files = [mutable];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      rmSync(mutable, { force: true });

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).toBe("changed");
    });

    it("non-existent file in file list does not throw", async () => {
      const cp = cachePath("nofile");
      const files = [fixtureFile("no-such-file.txt")];

      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx.status).not.toBe("upToDate");
    });
  });

  // ── File list changes ─────────────────────────────────────────────

  describe("file list changes", () => {
    it("detects added file", async () => {
      const cp = cachePath("add");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files2, 1);
      expect(ctx2.status).not.toBe("upToDate");
    });

    it("detects removed file via changed file list in write", async () => {
      const cp = cachePath("rm");
      const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const files2 = [fixtureFile("a.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      await ctx1.write();

      // Write changes file list from 2 files to 1
      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      await ctx2.write({ files: files2, rootPath: FIXTURE_DIR });

      // Verify the updated cache only has 1 file
      const ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files2, 1);
      expect(ctx3.status).toBe("upToDate");
      // files1 should no longer match
      const ctx4 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      expect(ctx4.status).not.toBe("upToDate");
    });

    it("write can change file list and produce valid cache", async () => {
      const cp = cachePath("cb-files");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      await ctx1.write({ files: files2, rootPath: FIXTURE_DIR });

      // Verify expanded file list
      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files2, 1);
      expect(ctx2.status).toBe("upToDate");
    });

    it("write can shrink file list and produce valid cache", async () => {
      const cp = cachePath("cb-shrink");
      const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      const files2 = [fixtureFile("a.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
      await ctx2.write({ files: files2, rootPath: FIXTURE_DIR });

      const ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files2, 1);
      expect(ctx3.status).toBe("upToDate");
    });

    it("handles 3 files round-trip", async () => {
      const cp = cachePath("multi");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).toBe("upToDate");
    });

    it("empty file list round-trip", async () => {
      const cp = cachePath("empty");

      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, [], 1);
      await ctx1.write();

      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, [], 1);
      // Empty file list behavior varies by backend — all non-error statuses are valid
      expect(["upToDate", "missing", "changed"]).toContain(ctx2.status);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("corrupted cache file (bad magic)", async () => {
      const cp = cachePath("corrupt");
      writeFileSync(cp, Buffer.alloc(64, 0xff));

      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, [fixtureFile("a.txt")], 1);
      expect(ctx.status).not.toBe("upToDate");
    });

    it("truncated cache file", async () => {
      const cp = cachePath("trunc");
      writeFileSync(cp, Buffer.alloc(32));

      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, [fixtureFile("a.txt")], 1);
      expect(ctx.status).not.toBe("upToDate");
    });

    it("empty cache file (0 bytes)", async () => {
      const cp = cachePath("empty-file");
      writeFileSync(cp, Buffer.alloc(0));

      const ctx = await FileHashCache.open(cp, FIXTURE_DIR, [fixtureFile("a.txt")], 1);
      expect(ctx.status).not.toBe("upToDate");
    });

    it("rapid update cycles detect deterministic file mutation", async () => {
      const cp = cachePath("rapid");
      const mutPath = fixtureFile("rapid-cycle.txt");
      writeFileSync(mutPath, "A".repeat(100));
      const files = [mutPath, fixtureFile("a.txt"), fixtureFile("b.txt")];

      const ctx0 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx0.status).not.toBe("upToDate");
      await ctx0.write();

      for (let i = 0; i < 6; i++) {
        const body = Buffer.alloc(100, 0x78);
        body[0] = String.fromCharCode(0x41 + ((i + 1) % 26)).charCodeAt(0);
        body[1] = 0x30 + ((i + 1) % 10);
        writeFileSync(mutPath, body);
        const t = new Date(1700001000000 + i * 1000);
        utimesSync(mutPath, t, t);

        const ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
        expect(ctx.status).not.toBe("upToDate");
        await ctx.write();
      }
    });
  });

  // ── Scattered multi-file changes ──────────────────────────────────

  describe("scattered multi-file changes", () => {
    it("open+write correctly hashes all changed files (not just first detected)", async () => {
      // Create 20 files — changes scattered across the sorted list
      // so parallel stat workers detect changes at different positions.
      const fileNames = Array.from({ length: 20 }, (_, i) => `scattered-${String(i).padStart(3, "0")}.txt`);
      for (const name of fileNames) {
        writeFileSync(fixtureFile(name), `original-${name}`);
      }
      const files = fileNames.map(fixtureFile);

      // Write initial cache
      const cp = cachePath("scattered");
      const ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx1.write();

      // Verify up-to-date
      const ctxCheck = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctxCheck.status).toBe("upToDate");

      // Mutate files at scattered positions (indices 2, 7, 13, 18) with explicit
      // timestamps so stat changes are guaranteed even on coarse-granularity fs.
      const changedIndices = [2, 7, 13, 18];
      await sleep(50);
      for (const i of changedIndices) {
        writeFileSync(fixtureFile(fileNames[i]), `modified-${fileNames[i]}-${Date.now()}`);
        const t = new Date(1700002000000 + i * 1000);
        utimesSync(fixtureFile(fileNames[i]), t, t);
      }

      // open+write should update ALL changed entries
      const ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx2.status).not.toBe("upToDate");
      await ctx2.write();

      // Critical check: a subsequent open with no changes must be upToDate.
      // If the cache has stale entries (from incomplete processing), this fails.
      const ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx3.status).toBe("upToDate");

      // Clean up
      for (const name of fileNames) {
        rmSync(fixtureFile(name), { force: true });
      }
    });
  });
});
