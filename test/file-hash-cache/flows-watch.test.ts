import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-flows-watch");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cp(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fx(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

/** Write file with an explicit mtime so stat changes are guaranteed on Windows (timer resolution ~15.6ms). */
let epochCounter = 1700200000;
function writeWithMtime(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  const t = new Date(++epochCounter * 1000);
  utimesSync(filePath, t, t);
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

// - needsOpen / checkCacheFile

describe("needsOpen", () => {
  it("true before first open", () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    expect(cache.needsOpen).toBe(true);
  });

  it("false after upToDate open", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      await s.write();
    }
    // After write, second open should be upToDate
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);
  });

  it("true after invalidateAll", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.invalidateAll();
    expect(cache.needsOpen).toBe(true);
  });

  it("true after invalidate with paths", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.invalidate([fx("a.txt")]);
    expect(cache.needsOpen).toBe(true);
  });

  it("true after version change", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR, version: 1 });
    {
      using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }
    expect(cache.needsOpen).toBe(false);

    cache.version = 2;
    expect(cache.needsOpen).toBe(true);
  });

  it("true after files setter", async () => {
    const cache = new FileHashCache({ cachePath: cp(), files: [fx("a.txt")], rootPath: FIXTURE_DIR });
    {
      using s = await cache.open();
      await s.write();
    }
    {
      cache.invalidateAll();
      using s = await cache.open();
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

// - Multiple open/write cycles (watch mode simulation)

describe("watch mode simulation", () => {
  it("invalidate with absolute paths, re-open, write cycle", async () => {
    const files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Simulate file change
    writeWithMtime(fx("b.txt"), "bbb modified\n");

    // Invalidate with absolute path
    cache.invalidate([fx("b.txt")]);
    {
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // No changes — should be upToDate without invalidateAll
    {
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
    }

    // Restore
    writeWithMtime(fx("b.txt"), "bbb\n");
    cache.invalidate([fx("b.txt")]);
    {
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });

  it("invalidate also works with relative paths", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Modify and invalidate with relative path
    writeWithMtime(fx("a.txt"), "aaa watch\n");
    cache.invalidate(["a.txt"]);
    {
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }

    // Restore
    writeWithMtime(fx("a.txt"), "aaa\n");
    cache.invalidate(["a.txt"]);
    {
      using s = await cache.open();
      expect(s.status).toBe("changed");
      await s.write();
    }
  });

  it("build step changes file list each cycle", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    // Cycle 1: a.txt
    {
      using s = await cache.open();
      await s.write();
    }

    // Cycle 2: build produces a.txt + b.txt
    cache.files = [fx("a.txt"), fx("b.txt")];
    {
      using s = await cache.open();
      expect(s.status).not.toBe("upToDate");
      await s.write();
    }

    // Cycle 3: still a.txt + b.txt, no changes
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
    }

    // Cycle 4: build removes b.txt, adds c.txt
    cache.files = [fx("a.txt"), fx("c.txt")];
    {
      using s = await cache.open();
      expect(s.status).not.toBe("upToDate");
      await s.write();
    }

    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
    }
  });
});

// - write({ files }) on a kept-alive cache instance

describe("write({ files }) updates same cache instance", () => {
  it("write({ files }) changes file list and subsequent open sees it", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt")];
    const filesV2 = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed with v1 files
    {
      using s = await cache.open();
      expect(s.status).toBe("missing");
      await s.write();
    }

    // Open — upToDate with v1, then write with new files via options
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(1);

      // Pass new files through configure (not cache.files setter)
      cache.configure({ files: filesV2, rootPath: FIXTURE_DIR });
      await s.write();
    }

    // Re-open same cache instance — should see v2 files
    {
      cache.invalidateAll();
      using s = await cache.open();
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
      using s = await cache.open();
      await s.write();
    }

    // Open and shrink via write options
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.status).toBe("upToDate");
      cache.configure({ files: filesV2, rootPath: FIXTURE_DIR });
      await s.write();
    }

    // Re-open — should be upToDate with 1 file
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(1);
      expect(s.fileCount).toBe(1);
    }
  });

  it("write({ files, payloadValue0, compressedPayloads }) all together on same instance", async () => {
    const cacheFile = cp();
    const filesV1 = [fx("a.txt")];
    const filesV2 = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cacheFile, files: filesV1, rootPath: FIXTURE_DIR });

    // Seed
    {
      using s = await cache.open();
      await s.write({ payloadValue0: 10, compressedPayloads: [Buffer.from("initial")] });
    }

    // Write with new files + new user values via options
    {
      cache.invalidateAll();
      const s = await cache.open();
      expect(s.payloadValue0).toBe(10);
      expect(s.compressedPayloads[0].toString()).toBe("initial");
      cache.configure({ files: filesV2, rootPath: FIXTURE_DIR });
      await s.write({
        payloadValue0: 99,
        compressedPayloads: [Buffer.from("updated")],
      });
    }

    // Re-open same instance — verify everything
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(cache.fileCount).toBe(2);
      expect(s.fileCount).toBe(2);
      expect(s.payloadValue0).toBe(99);
      expect(s.compressedPayloads.length).toBe(1);
      expect(s.compressedPayloads[0].toString()).toBe("updated");
    }
  });

  it("multiple write({ files }) cycles on same instance", async () => {
    const cacheFile = cp();
    const cache = new FileHashCache({ cachePath: cacheFile, files: [fx("a.txt")], rootPath: FIXTURE_DIR });

    // Cycle 1: seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Cycle 2: expand to 3 files via configure
    {
      cache.invalidateAll();
      const s = await cache.open();
      cache.configure({ files: [fx("a.txt"), fx("b.txt"), fx("c.txt")], rootPath: FIXTURE_DIR });
      await s.write();
    }
    expect(cache.fileCount).toBe(3);

    // Cycle 3: verify upToDate
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.fileCount).toBe(3);
    }

    // Cycle 4: shrink to 2 files via configure
    {
      cache.invalidateAll();
      const s = await cache.open();
      cache.configure({ files: [fx("a.txt"), fx("c.txt")], rootPath: FIXTURE_DIR });
      await s.write();
    }
    expect(cache.fileCount).toBe(2);

    // Cycle 5: verify upToDate with 2 files
    {
      cache.invalidateAll();
      using s = await cache.open();
      expect(s.status).toBe("upToDate");
      expect(s.fileCount).toBe(2);
    }
  });
});
