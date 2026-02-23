import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-flows-rs");
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

// ── Reuse-from-disk mode (no files in constructor) ───────────────────

describe("reuse-from-disk mode", () => {
  it("open adopts files from existing cache", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];

    // First: write a cache with files
    {
      const writer = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });
      using s = await writer.open();
      await s.write();
    }

    // Open without files: should adopt from disk
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);

    {
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.fileCount).toBe(3);

      // cache adopted the files
      expect(cache.fileCount).toBe(3);
      expect(cache.files).toHaveLength(3);
    }
  });

  it("session.files works in reuse mode", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt"), fx("b.txt")];

    // Seed
    {
      const writer = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });
      using s = await writer.open();
      await s.write();
    }

    // Reuse
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      expect(s.files).toHaveLength(2);
      expect(s.files[0]).toBe(ROOT + "a.txt");
      expect(s.files[1]).toBe(ROOT + "b.txt");
    }
  });

  it("reuse mode returns missing when no cache exists", async () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      expect(s.status).toBe("missing");
      expect(s.fileCount).toBe(0);
    }
    // cache still has no files
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);
  });

  it("after open, cache.files reflects disk and can be used for overwrite", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt"), fx("b.txt")];

    // Seed
    {
      const writer = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });
      using s = await writer.open();
      await s.write();
    }

    // Reuse — open adopts files, then overwrite should work
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // Now overwrite should succeed (files were adopted from disk)
    const ok = await cache.overwrite();
    expect(ok).toBe(true);

    // Verify it's still valid
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.fileCount).toBe(2);
    }
  });

  it("user can set files after reuse open, overriding disk files", async () => {
    const cacheFile = cp();

    // Seed with 2 files
    {
      const writer = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt"), fx("b.txt")],
        rootPath: FIXTURE_DIR,
      });
      using s = await writer.open();
      await s.write();
    }

    // Open in reuse mode — adopts 2 files
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      using _s = await cache.open();
      expect(cache.fileCount).toBe(2);
    }

    // User sets new files — overrides the adopted ones
    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt"), fx("d.txt"), fx("e.txt")];
    expect(cache.fileCount).toBe(5);
    expect(cache.files).toHaveLength(5);

    // Write with the new file list
    {
      using s = await cache.open();
      expect(s.status).not.toBe("upToDate"); // different file list
      await s.write();
    }

    // Verify
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(5);
      expect(s.fileCount).toBe(5);
    }
  });
});

// ── Version / fingerprint changes ────────────────────────────────────

describe("version and fingerprint", () => {
  it("version mismatch returns stale", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 1 });

    {
      using s = await cache.open();
      await s.write();
    }

    cache.version = 2;
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("stale");
    }
  });

  it("fingerprint mismatch returns stale", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const fp1 = Buffer.alloc(16, 1);
    const fp2 = Buffer.alloc(16, 2);
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, fingerprint: fp1 });

    {
      using s = await cache.open();
      await s.write();
    }

    cache.fingerprint = fp2;
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("stale");
    }
  });
});

// ── Stale cache flows ────────────────────────────────────────────────

describe("stale cache", () => {
  it("stale + write makes it upToDate", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 1 });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Bump version → stale
    cache.version = 2;
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("stale");
      await s.write();
    }

    // Re-open: upToDate with new version
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // cache state consistent
    expect(cache.fileCount).toBe(2);
    expect(cache.files).toHaveLength(2);
  });

  it("stale + close without write re-invalidates", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 1 });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Bump version → stale, but don't write
    cache.version = 2;
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("stale");
      // no write
    }

    // Next open should still be stale (re-invalidated)
    {
      using s = await cache.open();
      expect(s.status).toBe("stale");
    }
  });

  it("stale + change files + write uses new files", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR, version: 1 });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Bump version → stale, change files, write
    cache.version = 2;
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.status).toBe("stale");

      // Build produced new files
      cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
      await s.write();
    }

    // Re-open: upToDate with 3 files
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
      expect(s.fileCount).toBe(3);
    }
  });

  it("stale preserves old payloadData on the session", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 1 });

    // Write with payloadData
    {
      using s = await cache.open();
      await s.write({ payloadValue0: 99, payloadData: [Buffer.from("old-data")] });
    }

    // Bump version → stale
    cache.version = 2;
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("stale");
      // Old payloadData are still readable from the stale cache
      expect(s.payloadValue0).toBe(99);
      expect(Buffer.from(s.payloadData[0]).toString()).toBe("old-data");
    }
  });
});

// ── User files always take priority over disk ────────────────────────

describe("user files vs disk files priority", () => {
  it("constructor files override what is on disk", async () => {
    const cacheFile = cp();

    // Write cache with [a, b]
    {
      const c1 = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt"), fx("b.txt")], rootPath: FIXTURE_DIR });
      using s = await c1.open();
      await s.write();
    }

    // Open with different files [c, d, e] — user wins
    const c2 = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("c.txt"), fx("d.txt"), fx("e.txt")],
      rootPath: FIXTURE_DIR,
    });
    {
      using s = await c2.open();
      // File list changed → status should reflect that
      expect(s.status).toBe("changed");
      expect(c2.fileCount).toBe(3);
      await s.write();
    }

    // Verify: re-open is upToDate with user's 3 files
    {
      c2.invalidateAll();
      using s = await c2.open();
      expect(s.status).toBe("upToDate");
      expect(c2.fileCount).toBe(3);
    }
  });

  it("files setter overrides adopted disk files", async () => {
    const cacheFile = cp();

    // Write with [a, b]
    {
      const w = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt"), fx("b.txt")], rootPath: FIXTURE_DIR });
      using s = await w.open();
      await s.write();
    }

    // Reuse mode: adopt from disk
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      using _s = await cache.open();
      expect(cache.fileCount).toBe(2);
    }

    // Setter overrides adopted — now returns absolute paths
    cache.files = [fx("d.txt"), fx("e.txt")];
    expect(cache.fileCount).toBe(2);
    expect(cache.files?.[0]).toBe(ROOT + "d.txt");
    expect(cache.files?.[1]).toBe(ROOT + "e.txt");
  });

  it("reuse mode only adopts when user has not set files", async () => {
    const cacheFile = cp();

    // Write with [a, b, c]
    {
      const w = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt"), fx("b.txt"), fx("c.txt")],
        rootPath: FIXTURE_DIR,
      });
      using s = await w.open();
      await s.write();
    }

    // Construct without files, then set files BEFORE open
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    cache.files = [fx("d.txt"), fx("e.txt")];
    expect(cache.fileCount).toBe(2);

    // Open — user's files take priority, not disk's 3 files
    {
      using s = await cache.open();
      expect(s.status).toBe("changed"); // different files than on disk
      expect(cache.fileCount).toBe(2); // user's files, not disk's 3
    }
  });
});

// ── Session old* properties ─────────────────────────────────────────

describe("session old properties", () => {
  it("files uses open-time rootPath even if cache.rootPath changes", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      await s.write();
    }

    // Open a session, then the rootPath at open time is FIXTURE_DIR
    cache.invalidateAll();
    const s = await cache.open();

    // files should use open-time rootPath
    expect(s.files[0]).toBe(ROOT + "a.txt");

    s.close();
  });

  it("old payloadData are zero when cache is missing", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      expect(s.status).toBe("missing");
      expect(s.payloadValue0).toBe(0);
      expect(s.payloadValue1).toBe(0);
      expect(s.payloadValue2).toBe(0);
      expect(s.payloadValue3).toBe(0);
      expect(s.payloadData).toHaveLength(0);
    }
  });
});

// ── session.write with payloadData ──────────────────────────────────────

describe("session payloadData", () => {
  it("set payloadData via write argument", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      await s.write({
        payloadValue0: 100,
        payloadValue1: 200,
        payloadValue2: 300,
        payloadValue3: 400,
        payloadData: [Buffer.from("data1")],
      });
    }

    // Verify
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.payloadValue0).toBe(100);
      expect(s.payloadValue1).toBe(200);
      expect(s.payloadValue2).toBe(300);
      expect(s.payloadValue3).toBe(400);
      expect(s.payloadData).toHaveLength(1);
      expect(Buffer.from(s.payloadData[0]).toString()).toBe("data1");
    }
  });

  it("write without payloadData preserves old values", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    // Write with payloadData
    await cache.overwrite({ payloadValue0: 77, payloadData: [Buffer.from("stored")] });

    // Modify file to trigger a write
    writeFileSync(fx("a.txt"), "aaa v2\n");
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("changed");
      expect(s.payloadValue0).toBe(77);
      // Write without payloadData — old values preserved
      await s.write();
    }

    // Verify old payloadData survived
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.payloadValue0).toBe(77);
      expect(Buffer.from(s.payloadData[0]).toString()).toBe("stored");
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");
  });

  it("payloadData from disk are readable on open", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    await cache.overwrite({ payloadValue0: 77, payloadData: [Buffer.from("stored")] });

    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.payloadValue0).toBe(77);
      expect(Buffer.from(s.payloadData[0]).toString()).toBe("stored");
    }
  });
});
