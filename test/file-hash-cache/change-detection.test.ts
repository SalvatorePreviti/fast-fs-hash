/**
 * Tests: FileHashCache change detection — ported from V1 lifecycle.test.ts.
 *
 * Covers version mismatch, file content/size/metadata changes, deleted files,
 * file list add/remove.
 */

import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileHashCacheSession } from "fast-fs-hash";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

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

/** Write file with an explicit mtime so stat changes are guaranteed without sleeping. */
let epochCounter = 1700000000;
function writeWithMtime(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  const t = new Date(++epochCounter * 1000);
  utimesSync(filePath, t, t);
}

async function withCache<T>(
  cp: string,
  files: Iterable<string> | null,
  opts: { rootPath?: string; version?: number; fingerprint?: Uint8Array | null },
  run: (session: FileHashCacheSession, cache: FileHashCache) => Promise<T> | T
): Promise<T> {
  const cache = new FileHashCache({
    cachePath: cp,
    files,
    rootPath: opts.rootPath ?? FIXTURE_DIR,
    version: opts.version ?? 1,
    fingerprint: opts.fingerprint,
  });
  using session = await cache.open();
  return await run(session, cache);
}

//  - Tests

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  writeWithMtime(fixtureFile("a.txt"), "hello world\n");
  writeWithMtime(fixtureFile("b.txt"), "goodbye world\n");
  writeWithMtime(fixtureFile("c.txt"), "third file\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileHashCache change detection [native]", () => {
  //  - Version / fingerprint

  describe("version and fingerprint", () => {
    it("detects version mismatch", async () => {
      const cp = cachePath("ver");
      const files = [fixtureFile("a.txt")];

      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        expect(ctx1.needsWrite).toBe(true);
        await ctx1.write();
      });

      const status = await withCache(cp, files, { version: 2 }, (ctx2) => {
        expect(ctx2.needsWrite).toBe(true);
        return ctx2.status;
      });
      expect(status).toBe("stale");
    });

    it("same fingerprint is upToDate", async () => {
      const cp = cachePath("fp-same");
      const files = [fixtureFile("a.txt")];
      const fp = new Uint8Array(16).fill(0xab);

      await withCache(cp, files, { version: 1, fingerprint: fp }, async (ctx1) => {
        await ctx1.write();
      });

      const status = await withCache(cp, files, { version: 1, fingerprint: fp }, (ctx2) => {
        expect(ctx2.needsWrite).toBe(false);
        return ctx2.status;
      });
      expect(status).toBe("upToDate");
    });

    it("different fingerprint is stale", async () => {
      const cp = cachePath("fp-diff");
      const files = [fixtureFile("a.txt")];
      const fp1 = new Uint8Array(16).fill(0x11);
      const fp2 = new Uint8Array(16).fill(0x22);

      await withCache(cp, files, { version: 1, fingerprint: fp1 }, async (ctx1) => {
        await ctx1.write();
      });

      const status = await withCache(cp, files, { version: 1, fingerprint: fp2 }, (ctx2) => {
        expect(ctx2.needsWrite).toBe(true);
        return ctx2.status;
      });
      expect(status).toBe("stale");
    });
  });

  //  - File content / metadata changes

  describe("file changes", () => {
    it("detects file content change", async () => {
      const cp = cachePath("content");
      const mutable = fixtureFile("mut-content.txt");
      writeWithMtime(mutable, "original content");
      const files = [mutable];

      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      writeWithMtime(mutable, "modified content");

      const status = await withCache(cp, files, { version: 1 }, (ctx2) => {
        expect(ctx2.needsWrite).toBe(true);
        return ctx2.status;
      });
      expect(status).toBe("changed");
    });

    it("detects file size change", async () => {
      const cp = cachePath("size");
      const mutable = fixtureFile("mut-size.txt");
      writeWithMtime(mutable, "short");
      const files = [mutable];

      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      writeWithMtime(mutable, "much longer content here!!!");

      const status = await withCache(cp, files, { version: 1 }, (ctx2) => ctx2.status);
      expect(status).toBe("changed");
    });

    it("same content after metadata change round-trips correctly", async () => {
      const cp = cachePath("meta");
      const mutable = fixtureFile("mut-meta.txt");
      writeWithMtime(mutable, "stable content here");
      const files = [mutable];

      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      // Rewrite with identical content — metadata changes via writeWithMtime, hash same.
      writeWithMtime(mutable, "stable content here");

      // Native does stat+size+rehash optimization -> "statsDirty" (stat changed, content same).
      // Stat change detected -> "changed".
      // Either is acceptable — the important thing is no error and a valid cache.
      const status = await withCache(cp, files, { version: 1 }, async (ctx2) => {
        expect(["statsDirty", "changed"]).toContain(ctx2.status);
        if (ctx2.status !== "upToDate") {
          await ctx2.write();
        }
        return ctx2.status;
      });
      expect(["statsDirty", "changed"]).toContain(status);

      // After update, re-checking should be upToDate (stat hash now matches)
      const status2 = await withCache(cp, files, { version: 1 }, (ctx3) => ctx3.status);
      expect(status2).toBe("upToDate");
    });

    it("detects deleted file", async () => {
      const cp = cachePath("del");
      const mutable = fixtureFile("will-delete.txt");
      writeWithMtime(mutable, "soon to be gone");
      const files = [mutable];

      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      rmSync(mutable, { force: true });

      const status = await withCache(cp, files, { version: 1 }, (ctx2) => ctx2.status);
      expect(status).toBe("changed");
    });

    it("non-existent file in file list does not throw", async () => {
      const cp = cachePath("nofile");
      const files = [fixtureFile("no-such-file.txt")];

      const status = await withCache(cp, files, { version: 1 }, (ctx) => ctx.status);
      expect(status).not.toBe("upToDate");
    });
  });

  //  - File list changes

  describe("file list changes", () => {
    it("detects added file", async () => {
      const cp = cachePath("add");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await withCache(cp, files1, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      const status = await withCache(cp, files2, { version: 1 }, (ctx2) => ctx2.status);
      expect(status).not.toBe("upToDate");
    });

    it("detects removed file via changed file list in write", async () => {
      const cp = cachePath("rm");
      const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const files2 = [fixtureFile("a.txt")];

      await withCache(cp, files1, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      // Write changes file list from 2 files to 1
      await withCache(cp, files1, { version: 1 }, async (ctx2, cache2) => {
        cache2.configure({ files: files2, rootPath: FIXTURE_DIR });
        await ctx2.write();
      });

      // Verify the updated cache only has 1 file
      const status1 = await withCache(cp, files2, { version: 1 }, (ctx3) => ctx3.status);
      expect(status1).toBe("upToDate");
      // files1 should no longer match
      const status2 = await withCache(cp, files1, { version: 1 }, (ctx4) => ctx4.status);
      expect(status2).not.toBe("upToDate");
    });

    it("write can change file list and produce valid cache", async () => {
      const cp = cachePath("cb-files");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      await withCache(cp, files1, { version: 1 }, async (ctx1, cache1) => {
        cache1.configure({ files: files2, rootPath: FIXTURE_DIR });
        await ctx1.write();
      });

      // Verify expanded file list
      const status = await withCache(cp, files2, { version: 1 }, (ctx2) => ctx2.status);
      expect(status).toBe("upToDate");
    });

    it("write can shrink file list and produce valid cache", async () => {
      const cp = cachePath("cb-shrink");
      const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      const files2 = [fixtureFile("a.txt")];

      await withCache(cp, files1, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      await withCache(cp, files1, { version: 1 }, async (ctx2, cache2) => {
        cache2.configure({ files: files2, rootPath: FIXTURE_DIR });
        await ctx2.write();
      });

      const status = await withCache(cp, files2, { version: 1 }, (ctx3) => ctx3.status);
      expect(status).toBe("upToDate");
    });

    it("truncates cache file on disk when file list shrinks", async () => {
      const { statSync } = await import("node:fs");
      const cp = cachePath("trunc-shrink");
      const files3 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      const files1 = [fixtureFile("a.txt")];

      // Write with 3 files
      await withCache(cp, files3, { version: 1 }, async (ctx) => {
        await ctx.write();
      });
      const sizeWith3 = statSync(cp).size;

      // Overwrite with 1 file — must truncate
      await withCache(cp, files3, { version: 1 }, async (ctx, cacheInst) => {
        cacheInst.configure({ files: files1, rootPath: FIXTURE_DIR });
        await ctx.write();
      });
      const sizeWith1 = statSync(cp).size;

      expect(sizeWith1).toBeLessThan(sizeWith3);

      // Verify the smaller file is still valid
      const status = await withCache(cp, files1, { version: 1 }, (ctx) => ctx.status);
      expect(status).toBe("upToDate");
    });

    it("handles 3 files round-trip", async () => {
      const cp = cachePath("multi");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      const status = await withCache(cp, files, { version: 1 }, (ctx2) => ctx2.status);
      expect(status).toBe("upToDate");
    });

    it("empty file list round-trip", async () => {
      const cp = cachePath("empty");

      await withCache(cp, [], { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      const ctx2Status = await withCache(cp, [], { version: 1 }, (ctx2) => ctx2.status);
      // Empty file list behavior varies by backend — all non-error statuses are valid
      expect(["upToDate", "missing", "changed"]).toContain(ctx2Status);
    });
  });

  //  - Edge cases

  describe("edge cases", () => {
    it("corrupted cache file (bad magic)", async () => {
      const cp = cachePath("corrupt");
      writeFileSync(cp, Buffer.alloc(64, 0xff));

      const status = await withCache(cp, [fixtureFile("a.txt")], { version: 1 }, (ctx) => {
        expect(ctx.needsWrite).toBe(true);
        return ctx.status;
      });
      expect(status).not.toBe("upToDate");
    });

    it("truncated cache file", async () => {
      const cp = cachePath("trunc");
      writeFileSync(cp, Buffer.alloc(32));

      const status = await withCache(cp, [fixtureFile("a.txt")], { version: 1 }, (ctx) => ctx.status);
      expect(status).not.toBe("upToDate");
    });

    it("empty cache file (0 bytes)", async () => {
      const cp = cachePath("empty-file");
      writeFileSync(cp, Buffer.alloc(0));

      const status = await withCache(cp, [fixtureFile("a.txt")], { version: 1 }, (ctx) => ctx.status);
      expect(status).not.toBe("upToDate");
    });

    it("rapid update cycles detect deterministic file mutation", async () => {
      const cp = cachePath("rapid");
      const mutPath = fixtureFile("rapid-cycle.txt");
      writeWithMtime(mutPath, "A".repeat(100));
      const files = [mutPath, fixtureFile("a.txt"), fixtureFile("b.txt")];

      await withCache(cp, files, { version: 1 }, async (ctx0) => {
        expect(ctx0.status).not.toBe("upToDate");
        await ctx0.write();
      });

      for (let i = 0; i < 6; i++) {
        const body = Buffer.alloc(100, 0x78);
        body[0] = String.fromCharCode(0x41 + ((i + 1) % 26)).charCodeAt(0);
        body[1] = 0x30 + ((i + 1) % 10);
        writeFileSync(mutPath, body);
        const t = new Date(1700001000000 + i * 1000);
        utimesSync(mutPath, t, t);

        await withCache(cp, files, { version: 1 }, async (ctx) => {
          expect(ctx.status).not.toBe("upToDate");
          await ctx.write();
        });
      }
    });
  });

  //  - needsWrite getter

  describe("needsWrite getter", () => {
    it("returns false for upToDate", async () => {
      const cp = cachePath("nw-utd");
      const files = [fixtureFile("a.txt")];
      await withCache(cp, files, { version: 1 }, async (ctx) => {
        await ctx.write();
      });
      await withCache(cp, files, { version: 1 }, (ctx) => {
        expect(ctx.status).toBe("upToDate");
        expect(ctx.needsWrite).toBe(false);
      });
    });

    it("returns true for missing (no cache file)", async () => {
      const cp = cachePath("nw-miss");
      const files = [fixtureFile("a.txt")];
      await withCache(cp, files, { version: 1 }, (ctx) => {
        expect(ctx.status).toBe("missing");
        expect(ctx.needsWrite).toBe(true);
      });
    });

    it("returns true for changed", async () => {
      const cp = cachePath("nw-chg");
      const mutable = fixtureFile("nw-chg.txt");
      writeWithMtime(mutable, "before");
      const files = [mutable];
      await withCache(cp, files, { version: 1 }, async (ctx) => {
        await ctx.write();
      });
      writeWithMtime(mutable, "after-changed");
      await withCache(cp, files, { version: 1 }, (ctx) => {
        expect(ctx.status).toBe("changed");
        expect(ctx.needsWrite).toBe(true);
      });
    });

    it("returns true for stale", async () => {
      const cp = cachePath("nw-stale");
      const files = [fixtureFile("a.txt")];
      await withCache(cp, files, { version: 1 }, async (ctx) => {
        await ctx.write();
      });
      await withCache(cp, files, { version: 99 }, (ctx) => {
        expect(ctx.status).toBe("stale");
        expect(ctx.needsWrite).toBe(true);
      });
    });

    it("returns false after close()", async () => {
      const cp = cachePath("nw-closed");
      const files = [fixtureFile("a.txt")];
      const cache = new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 });
      const ctx = await cache.open();
      expect(ctx.needsWrite).toBe(true); // missing
      ctx.close();
      expect(ctx.needsWrite).toBe(false);
    });

    it("returns false after write()", async () => {
      const cp = cachePath("nw-written");
      const files = [fixtureFile("a.txt")];
      const cache = new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 });
      const ctx = await cache.open();
      expect(ctx.needsWrite).toBe(true);
      await ctx.write();
      expect(ctx.needsWrite).toBe(false);
      expect(ctx.disposed).toBe(true);
    });
  });

  //  - Scattered multi-file changes

  describe("scattered multi-file changes", () => {
    it("open+write correctly hashes all changed files (not just first detected)", async () => {
      // Create 20 files — changes scattered across the sorted list
      // so parallel stat workers detect changes at different positions.
      const fileNames = Array.from({ length: 20 }, (_, i) => `scattered-${String(i).padStart(3, "0")}.txt`);
      for (const name of fileNames) {
        writeWithMtime(fixtureFile(name), `original-${name}`);
      }
      const files = fileNames.map(fixtureFile);

      // Write initial cache
      const cp = cachePath("scattered");
      await withCache(cp, files, { version: 1 }, async (ctx1) => {
        await ctx1.write();
      });

      // Verify up-to-date
      const statusCheck = await withCache(cp, files, { version: 1 }, (ctxCheck) => ctxCheck.status);
      expect(statusCheck).toBe("upToDate");

      // Mutate files at scattered positions (indices 2, 7, 13, 18) with explicit
      // timestamps so stat changes are guaranteed even on coarse-granularity fs.
      const changedIndices = [2, 7, 13, 18];
      for (const i of changedIndices) {
        writeWithMtime(fixtureFile(fileNames[i]), `modified-${fileNames[i]}-${Date.now()}`);
      }

      // open+write should update ALL changed entries
      await withCache(cp, files, { version: 1 }, async (ctx2) => {
        expect(ctx2.status).not.toBe("upToDate");
        await ctx2.write();
      });

      // Critical check: a subsequent open with no changes must be upToDate.
      // If the cache has stale entries (from incomplete processing), this fails.
      const status = await withCache(cp, files, { version: 1 }, (ctx3) => ctx3.status);
      expect(status).toBe("upToDate");

      // Clean up
      for (const name of fileNames) {
        rmSync(fixtureFile(name), { force: true });
      }
    });
  });
});
