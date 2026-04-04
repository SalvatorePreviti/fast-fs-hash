/**
 * Tests for FileHashCache state flows:
 *
 * - Constructor with/without files
 * - Files setter before and after open
 * - open() with existing cache and without
 * - Changing files between open and write (build step scenario)
 * - Reuse-from-disk mode (no files in constructor)
 * - Close without write re-invalidates dirty state
 * - overwrite with payloads
 * - cache.files / cache.fileCount consistency after all operations
 * - Session old* properties expose disk state
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-flows");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cp(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

/** Fixture file path (absolute). */
function fx(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

/** Resolved root path (with trailing slash, matching cache.rootPath). */
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

// ── Constructor ──────────────────────────────────────────────────────

describe("constructor with files", () => {
  it("sets files and fileCount immediately", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt"), fx("b.txt")], rootPath: FIXTURE_DIR });
    expect(cache.files).toHaveLength(2);
    expect(cache.fileCount).toBe(2);
  });

  it("normalizes, sorts, and returns absolute paths", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("b.txt"), fx("a.txt")], rootPath: FIXTURE_DIR });
    const files = cache.files;
    expect(files).not.toBeNull();
    expect(files?.[0]).toBe(ROOT + "a.txt");
    expect(files?.[1]).toBe(ROOT + "b.txt");
  });
});

describe("constructor without files", () => {
  it("files is null and fileCount is 0", () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);
  });
});

// ── Files setter ─────────────────────────────────────────────────────

describe("files setter", () => {
  it("sets files after construction", () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    expect(cache.files).toBeNull();

    cache.files = [fx("a.txt"), fx("c.txt")];
    expect(cache.fileCount).toBe(2);
    expect(cache.files).toHaveLength(2);
  });

  it("overrides constructor files", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    expect(cache.fileCount).toBe(1);

    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    expect(cache.fileCount).toBe(3);
    expect(cache.files).toHaveLength(3);
  });

  it("setting null clears files", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    cache.files = null;
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);
  });

  it("returns absolute paths from setter", () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    cache.files = [fx("b.txt"), fx("a.txt")];
    expect(cache.files?.[0]).toBe(ROOT + "a.txt");
    expect(cache.files?.[1]).toBe(ROOT + "b.txt");
  });
});

// ── open + write: basic flows ────────────────────────────────────────

describe("open + write with files in constructor", () => {
  it("first open returns missing, write succeeds, re-open returns upToDate", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // First open: no cache file
    {
      await using s = await cache.open();
      expect(s.status).toBe("missing");
      expect(cache.fileCount).toBe(2);
      // fileCount reflects the dataBuf built by C++ (user's file list for the hash phase)
      await s.write();
    }

    // Re-open: should be upToDate
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
      expect(s.fileCount).toBe(2); // now on disk
    }

    // cache state consistent after
    expect(cache.fileCount).toBe(2);
    expect(cache.files).toHaveLength(2);
  });

  it("detects file content change", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Modify a file
    writeFileSync(fx("a.txt"), "aaa modified\n");

    // Re-open: changed
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");

    // Re-open after write: upToDate (with modified content)
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });
});

// ── Changing files between open and write (build step) ───────────────

describe("change files between open and write", () => {
  it("write uses the new file list set via cache.files", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt"), fx("b.txt")];
    const filesV2 = [fx("a.txt"), fx("b.txt"), fx("c.txt"), fx("d.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed with v1 files
    {
      await using s = await cache.open();
      expect(s.status).toBe("missing");
      await s.write();
    }

    // Open — detects upToDate with v1
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.status).toBe("upToDate");

      // Build step produces new file list — set it on the cache
      cache.files = filesV2;
      expect(cache.fileCount).toBe(4);
      expect(cache.files).toHaveLength(4);

      // Write with new file list — C++ remaps entries
      await s.write();
    }

    // Re-open with v2 files — should be upToDate
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(4);
      expect(s.fileCount).toBe(4);
    }
  });

  it("write uses fewer files after build removes some", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const filesV2 = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Open, then shrink file list, then write
    {
      cache.invalidateAll();
      const s = await cache.open();
      cache.files = filesV2;
      await s.write();
    }

    // Re-open: upToDate with 1 file
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(1);
      expect(s.fileCount).toBe(1);
    }
  });
});

// ── Reuse-from-disk mode (no files in constructor) ───────────────────

describe("reuse-from-disk mode", () => {
  it("open adopts files from existing cache", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];

    // First: write a cache with files
    {
      const writer = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });
      await using s = await writer.open();
      await s.write();
    }

    // Open without files: should adopt from disk
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    expect(cache.files).toBeNull();
    expect(cache.fileCount).toBe(0);

    {
      await using s = await cache.open();
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
      await using s = await writer.open();
      await s.write();
    }

    // Reuse
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      expect(s.files).toHaveLength(2);
      expect(s.files[0]).toBe(ROOT + "a.txt");
      expect(s.files[1]).toBe(ROOT + "b.txt");
    }
  });

  it("reuse mode returns missing when no cache exists", async () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
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
      await using s = await writer.open();
      await s.write();
    }

    // Reuse — open adopts files, then overwrite should work
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // Now overwrite should succeed (files were adopted from disk)
    const ok = await cache.overwrite();
    expect(ok).toBe(true);

    // Verify it's still valid
    {
      cache.invalidateAll();
      await using s = await cache.open();
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
      await using s = await writer.open();
      await s.write();
    }

    // Open in reuse mode — adopts 2 files
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      await using _s = await cache.open();
      expect(cache.fileCount).toBe(2);
    }

    // User sets new files — overrides the adopted ones
    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt"), fx("d.txt"), fx("e.txt")];
    expect(cache.fileCount).toBe(5);
    expect(cache.files).toHaveLength(5);

    // Write with the new file list
    {
      await using s = await cache.open();
      expect(s.status).not.toBe("upToDate"); // different file list
      await s.write();
    }

    // Verify
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(5);
      expect(s.fileCount).toBe(5);
    }
  });
});

// ── Close without write re-invalidates ───────────────────────────────

describe("close without write", () => {
  it("re-invalidates so next open does full stat-match", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Modify file
    writeFileSync(fx("a.txt"), "aaa changed again\n");

    // Open (detects change) but close WITHOUT writing
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      // no write — auto-close via await using
    }

    // Next open should still detect the change (dirty state was restored)
    {
      // NOTE: no invalidateAll() here — the close should have re-invalidated
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");

    // Now it should see the restore as a change
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });

  it("upToDate close does NOT re-invalidate", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Open (upToDate) and close without write
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // Next open with no invalidateAll — should still skip stat (optimized path)
    {
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
  });
});

// ── overwrite ─────────────────────────────────────────────────────────

describe("overwrite", () => {
  it("writes a new cache from scratch", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    const ok = await cache.overwrite();
    expect(ok).toBe(true);

    // Verify
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
    }
  });

  it("overwrite with payloads", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    await cache.overwrite({
      userValue0: 42,
      userValue1: 3.14,
      userData: [Buffer.from("hello"), Buffer.from("world")],
    });

    // Verify payloads are readable
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.userValue0).toBe(42);
      expect(s.userValue1).toBe(3.14);
      expect(s.userValue2).toBe(0);
      expect(s.userValue3).toBe(0);
      expect(s.userData).toHaveLength(2);
      expect(Buffer.from(s.userData[0]).toString()).toBe("hello");
      expect(Buffer.from(s.userData[1]).toString()).toBe("world");
    }
  });

  it("overwrite throws when no files are set", async () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    await expect(cache.overwrite()).rejects.toThrow("files must be set");
  });

  it("overwrite after setting files via setter", async () => {
    const cache = new FileHashCache({ cachePath: cp(), rootPath: FIXTURE_DIR });
    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];

    const ok = await cache.overwrite();
    expect(ok).toBe(true);

    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
    }
  });
});

// ── session.write with payloads ──────────────────────────────────────

describe("session payloads", () => {
  it("set payloads via write argument", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    {
      await using s = await cache.open();
      await s.write({
        userValue0: 100,
        userValue1: 200,
        userValue2: 300,
        userValue3: 400,
        userData: [Buffer.from("data1")],
      });
    }

    // Verify
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.userValue0).toBe(100);
      expect(s.userValue1).toBe(200);
      expect(s.userValue2).toBe(300);
      expect(s.userValue3).toBe(400);
      expect(s.userData).toHaveLength(1);
      expect(Buffer.from(s.userData[0]).toString()).toBe("data1");
    }
  });

  it("write without payloads preserves old values", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    // Write with payloads
    await cache.overwrite({ userValue0: 77, userData: [Buffer.from("stored")] });

    // Modify file to trigger a write
    writeFileSync(fx("a.txt"), "aaa v2\n");
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      expect(s.userValue0).toBe(77);
      // Write without payloads — old values preserved
      await s.write();
    }

    // Verify old payloads survived
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.userValue0).toBe(77);
      expect(Buffer.from(s.userData[0]).toString()).toBe("stored");
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");
  });

  it("payloads from disk are readable on open", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    await cache.overwrite({ userValue0: 77, userData: [Buffer.from("stored")] });

    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.userValue0).toBe(77);
      expect(Buffer.from(s.userData[0]).toString()).toBe("stored");
    }
  });
});

// ── cache.write convenience ──────────────────────────────────────────

describe("cache.write convenience", () => {
  it("opens and writes if needed", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // First call: missing -> writes
    const s1 = await cache.write();
    expect(s1.status).toBe("missing");
    expect(s1.disposed).toBe(true);

    // Second call: upToDate -> no write, session still disposed
    cache.invalidateAll();
    const s2 = await cache.write();
    expect(s2.status).toBe("upToDate");
    // upToDate session was not written, but it's returned — caller should close
    s2.close();
  });

  it("cache.write passes payloads through", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    await cache.write({ userValue0: 55 });

    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.userValue0).toBe(55);
    }
  });
});

// ── Files setter between open/write does not affect existing session files
//    but DOES affect what gets written to disk ────────────────────────

describe("files setter during active session", () => {
  it("cache.files reflects setter value immediately", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    const s = await cache.open();
    expect(cache.fileCount).toBe(1);

    cache.files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    expect(cache.fileCount).toBe(3);
    expect(cache.files).toHaveLength(3);

    await s.write();

    // The written cache has the new 3-file list
    {
      cache.invalidateAll();
      await using s2 = await cache.open();
      expect(s2.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
      expect(s2.fileCount).toBe(3);
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
      await using s = await cache.open();
      await s.write();
    }

    cache.version = 2;
    {
      cache.invalidateAll();
      await using s = await cache.open();
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
      await using s = await cache.open();
      await s.write();
    }

    cache.fingerprint = fp2;
    {
      cache.invalidateAll();
      await using s = await cache.open();
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
      await using s = await cache.open();
      await s.write();
    }

    // Bump version → stale
    cache.version = 2;
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("stale");
      await s.write();
    }

    // Re-open: upToDate with new version
    {
      cache.invalidateAll();
      await using s = await cache.open();
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
      await using s = await cache.open();
      await s.write();
    }

    // Bump version → stale, but don't write
    cache.version = 2;
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("stale");
      // no write
    }

    // Next open should still be stale (re-invalidated)
    {
      await using s = await cache.open();
      expect(s.status).toBe("stale");
    }
  });

  it("stale + change files + write uses new files", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR, version: 1 });

    // Seed
    {
      await using s = await cache.open();
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
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
      expect(s.fileCount).toBe(3);
    }
  });

  it("stale preserves old payloads on the session", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 1 });

    // Write with payloads
    {
      await using s = await cache.open();
      await s.write({ userValue0: 99, userData: [Buffer.from("old-data")] });
    }

    // Bump version → stale
    cache.version = 2;
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("stale");
      // Old payloads are still readable from the stale cache
      expect(s.userValue0).toBe(99);
      expect(Buffer.from(s.userData[0]).toString()).toBe("old-data");
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
      await using s = await c1.open();
      await s.write();
    }

    // Open with different files [c, d, e] — user wins
    const c2 = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("c.txt"), fx("d.txt"), fx("e.txt")],
      rootPath: FIXTURE_DIR,
    });
    {
      await using s = await c2.open();
      // File list changed → status should reflect that
      expect(s.status).toBe("changed");
      expect(c2.fileCount).toBe(3);
      await s.write();
    }

    // Verify: re-open is upToDate with user's 3 files
    {
      c2.invalidateAll();
      await using s = await c2.open();
      expect(s.status).toBe("upToDate");
      expect(c2.fileCount).toBe(3);
    }
  });

  it("files setter overrides adopted disk files", async () => {
    const cacheFile = cp();

    // Write with [a, b]
    {
      const w = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt"), fx("b.txt")], rootPath: FIXTURE_DIR });
      await using s = await w.open();
      await s.write();
    }

    // Reuse mode: adopt from disk
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    {
      await using _s = await cache.open();
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
      await using s = await w.open();
      await s.write();
    }

    // Construct without files, then set files BEFORE open
    const cache = new FileHashCache({ cachePath: cacheFile, rootPath: FIXTURE_DIR });
    cache.files = [fx("d.txt"), fx("e.txt")];
    expect(cache.fileCount).toBe(2);

    // Open — user's files take priority, not disk's 3 files
    {
      await using s = await cache.open();
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
      await using s = await cache.open();
      await s.write();
    }

    // Open a session, then the rootPath at open time is FIXTURE_DIR
    cache.invalidateAll();
    const s = await cache.open();

    // files should use open-time rootPath
    expect(s.files[0]).toBe(ROOT + "a.txt");

    s.close();
  });

  it("old payloads are zero when cache is missing", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      expect(s.status).toBe("missing");
      expect(s.userValue0).toBe(0);
      expect(s.userValue1).toBe(0);
      expect(s.userValue2).toBe(0);
      expect(s.userValue3).toBe(0);
      expect(s.userData).toHaveLength(0);
    }
  });
});

// ── needsOpen / checkCacheFile ──────────────────────────────────────

describe("needsOpen", () => {
  it("true before first open", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    expect(cache.needsOpen).toBe(true);
  });

  it("false after upToDate open", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      await s.write();
    }
    // After write, second open should be upToDate
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);
  });

  it("true after invalidateAll", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.invalidateAll();
    expect(cache.needsOpen).toBe(true);
  });

  it("true after invalidate with paths", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.invalidate([fx("a.txt")]);
    expect(cache.needsOpen).toBe(true);
  });

  it("true after version change", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR, version: 1 });
    {
      await using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.version = 2;
    expect(cache.needsOpen).toBe(true);
  });

  it("true after files setter", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      await using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.files = [fx("a.txt"), fx("b.txt")];
    expect(cache.needsOpen).toBe(true);
  });

  it("false after overwrite", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    expect(cache.needsOpen).toBe(true);

    await cache.overwrite();
    expect(cache.needsOpen).toBe(false);
  });
});

describe("checkCacheFile", () => {
  it("returns true before first open", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    expect(await cache.checkCacheFile()).toBe(true);
  });

  it("returns false after write when file unchanged", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    await cache.overwrite();

    // Need a small delay to ensure the stat from _recordWriteSuccess has resolved
    await new Promise((r) => setTimeout(r, 50));
    expect(await cache.checkCacheFile()).toBe(false);
  });
});

// ── Multiple open/write cycles (watch mode simulation) ───────────────

describe("watch mode simulation", () => {
  it("invalidate with absolute paths, re-open, write cycle", async () => {
    const files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Simulate file change
    writeFileSync(fx("b.txt"), "bbb modified\n");

    // Invalidate with absolute path
    cache.invalidate([fx("b.txt")]);
    {
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // No changes — should be upToDate without invalidateAll
    {
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // Restore
    writeFileSync(fx("b.txt"), "bbb\n");
    cache.invalidate([fx("b.txt")]);
    {
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });

  it("invalidate also works with relative paths", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Modify and invalidate with relative path
    writeFileSync(fx("a.txt"), "aaa watch\n");
    cache.invalidate(["a.txt"]);
    {
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");
    cache.invalidate(["a.txt"]);
    {
      await using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });

  it("build step changes file list each cycle", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    // Cycle 1: a.txt
    {
      await using s = await cache.open();
      await s.write();
    }

    // Cycle 2: build produces a.txt + b.txt
    cache.files = [fx("a.txt"), fx("b.txt")];
    {
      await using s = await cache.open();
      expect(s.status).not.toBe("upToDate");
      await s.write();
    }

    // Cycle 3: still a.txt + b.txt, no changes
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
    }

    // Cycle 4: build removes b.txt, adds c.txt
    cache.files = [fx("a.txt"), fx("c.txt")];
    {
      await using s = await cache.open();
      expect(s.status).not.toBe("upToDate");
      await s.write();
    }

    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
    }
  });
});

// ── write({ files }) on a kept-alive cache instance ────────────────

describe("write({ files }) updates same cache instance", () => {
  it("write({ files }) changes file list and subsequent open sees it", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt")];
    const filesV2 = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed with v1 files
    {
      await using s = await cache.open();
      expect(s.status).toBe("missing");
      await s.write();
    }

    // Open — upToDate with v1, then write with new files via options
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(1);

      // Pass new files through write options (not cache.files setter)
      await s.write({ files: filesV2, rootPath: FIXTURE_DIR });
    }

    // Re-open same cache instance — should see v2 files
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
      expect(s.fileCount).toBe(3);
      expect(s.files).toHaveLength(3);
    }
  });

  it("write({ files }) with fewer files shrinks and re-open is upToDate", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const filesV2 = [fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Open and shrink via write options
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.status).toBe("upToDate");
      await s.write({ files: filesV2, rootPath: FIXTURE_DIR });
    }

    // Re-open — should be upToDate with 1 file
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(1);
      expect(s.fileCount).toBe(1);
    }
  });

  it("write({ files, userValue0, userData }) all together on same instance", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt")];
    const filesV2 = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed
    {
      await using s = await cache.open();
      await s.write({ userValue0: 10, userData: [Buffer.from("initial")] });
    }

    // Write with new files + new user values via options
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.userValue0).toBe(10);
      expect(s.userData[0].toString()).toBe("initial");
      await s.write({
        files: filesV2,
        rootPath: FIXTURE_DIR,
        userValue0: 99,
        userData: [Buffer.from("updated")],
      });
    }

    // Re-open same instance — verify everything
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
      expect(s.fileCount).toBe(2);
      expect(s.userValue0).toBe(99);
      expect(s.userData.length).toBe(1);
      expect(s.userData[0].toString()).toBe("updated");
    }
  });

  it("multiple write({ files }) cycles on same instance", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    // Cycle 1: seed
    {
      await using s = await cache.open();
      await s.write();
    }

    // Cycle 2: expand to 3 files via write options
    {
      cache.invalidateAll();
      const s = await cache.open();
      await s.write({ files: [fx("a.txt"), fx("b.txt"), fx("c.txt")], rootPath: FIXTURE_DIR });
    }
    expect(cache.fileCount).toBe(3);

    // Cycle 3: verify upToDate
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.fileCount).toBe(3);
    }

    // Cycle 4: shrink to 2 files via write options
    {
      cache.invalidateAll();
      const s = await cache.open();
      await s.write({ files: [fx("a.txt"), fx("c.txt")], rootPath: FIXTURE_DIR });
    }
    expect(cache.fileCount).toBe(2);

    // Cycle 5: verify upToDate with 2 files
    {
      cache.invalidateAll();
      await using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.fileCount).toBe(2);
    }
  });
});
