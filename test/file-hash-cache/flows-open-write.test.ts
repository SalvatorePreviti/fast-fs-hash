import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-flows-ow");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cp(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fx(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

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

// ── open + write: basic flows ────────────────────────────────────────

describe("open + write with files in constructor", () => {
  it("first open returns missing, write succeeds, re-open returns upToDate", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // First open: no cache file
    {
      using s = await cache.open();
      expect(s.status).toBe("missing");
      expect(cache.fileCount).toBe(2);
      // fileCount reflects the dataBuf built by C++ (user's file list for the hash phase)
      await s.write();
    }

    // Re-open: should be upToDate
    {
      cache.invalidateAll();
      using s = await cache.open();
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
      using s = await cache.open();
      await s.write();
    }

    // Modify a file
    writeFileSync(fx("a.txt"), "aaa modified\n");

    // Re-open: changed
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");

    // Re-open after write: upToDate (with modified content)
    {
      cache.invalidateAll();
      using s = await cache.open();
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
      using s = await cache.open();
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
      using s = await cache.open();
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
      using s = await cache.open();
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
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(1);
      expect(s.fileCount).toBe(1);
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
      using s = await cache.open();
      await s.write();
    }

    // Modify file
    writeFileSync(fx("a.txt"), "aaa changed again\n");

    // Open (detects change) but close WITHOUT writing
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("changed");
      // no write — auto-close via using
    }

    // Next open should still detect the change (dirty state was restored)
    {
      // NOTE: no invalidateAll() here — the close should have re-invalidated
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");

    // Now it should see the restore as a change
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });

  it("upToDate close does NOT re-invalidate", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Open (upToDate) and close without write
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // Next open with no invalidateAll — should still skip stat (optimized path)
    {
      using s = await cache.open();
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
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
    }
  });

  it("overwrite with payloadData", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    await cache.overwrite({
      payloadValue0: 42,
      payloadValue1: 3.14,
      payloadData: [Buffer.from("hello"), Buffer.from("world")],
    });

    // Verify payloadData are readable
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.payloadValue0).toBe(42);
      expect(s.payloadValue1).toBe(3.14);
      expect(s.payloadValue2).toBe(0);
      expect(s.payloadValue3).toBe(0);
      expect(s.payloadData).toHaveLength(2);
      expect(Buffer.from(s.payloadData[0]).toString()).toBe("hello");
      expect(Buffer.from(s.payloadData[1]).toString()).toBe("world");
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
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(3);
    }
  });
});

// ── cache.write convenience ──────────────────────────────────────────

describe("open + write + close pattern", () => {
  it("opens, writes if needed, closes", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      expect(s.status).toBe("missing");
      await s.write();
      expect(s.disposed).toBe(true);
    }

    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
  });

  it("write passes payloadData through", async () => {
    const cacheFile = cp();
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      await s.write({ payloadValue0: 55 });
    }

    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.payloadValue0).toBe(55);
    }
  });
});
