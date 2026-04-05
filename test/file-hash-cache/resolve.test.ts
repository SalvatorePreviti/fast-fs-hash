/**
 * Tests: session.resolve() and session.wouldNeedWrite().
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-resolve");
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
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("session.resolve()", () => {
  it("resolves all entries and returns FileHashCacheEntries", async () => {
    const files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    expect(session.status).toBe("missing");

    const entries = await session.resolve();
    expect(entries.length).toBe(3);

    const entry = entries.get(0);
    expect(entry).toBeDefined();
    expect(entry?.size).toBeGreaterThan(0);
    expect(entry?.mtimeMs).toBeGreaterThan(0);
    expect(entry?.contentHashHex).toMatch(/^[0-9a-f]{32}$/);
    expect(entry?.path).toContain("a.txt");
  });

  it("entries are iterable", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    const entries = await session.resolve();

    const paths: string[] = [];
    for (const entry of entries) {
      paths.push(entry.path);
      expect(entry.contentHashHex).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(paths).toHaveLength(2);
  });

  it("returns cached result on second call", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    const e1 = await session.resolve();
    const e2 = await session.resolve();
    expect(e1).toBe(e2);
  });

  it("resolve then write succeeds", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    expect(session.status).toBe("missing");

    const entries = await session.resolve();
    expect(entries.length).toBe(2);

    const ok = await session.write();
    expect(ok).toBe(true);

    {
      cache.invalidateAll();
      using s2 = await cache.open();
      expect(s2.status).toBe("upToDate");
    }
  });

  it("throws after close", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    const session = await cache.open();
    session.close();

    await expect(session.resolve()).rejects.toThrow("already closed");
  });

  it("throws after write", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    const session = await cache.open();
    await session.write();

    await expect(session.resolve()).rejects.toThrow("already closed");
  });

  it("find by path works", async () => {
    const files = [fx("a.txt"), fx("b.txt"), fx("c.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    const entries = await session.resolve();

    const bEntry = entries.find(session.files[1]);
    expect(bEntry).toBeDefined();
    expect(bEntry?.path).toContain("b.txt");
    expect(bEntry?.index).toBe(1);

    expect(entries.find("/nonexistent")).toBeUndefined();
  });

  it("different files produce different hashes", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    const entries = await session.resolve();

    expect(entries.get(0)?.contentHashHex).not.toBe(entries.get(1)?.contentHashHex);
  });

  it("changed flag is true for new files", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    expect(session.status).toBe("missing");

    const entries = await session.resolve();
    // All files are new (no prior cache) → all changed
    for (const entry of entries) {
      expect(entry.changed).toBe(true);
    }
  });

  it("changed flag is false for unchanged files after write", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed the cache
    {
      using s = await cache.open();
      await s.write();
    }

    // Re-open: nothing changed
    cache.invalidateAll();
    using session = await cache.open();
    expect(session.status).toBe("upToDate");

    const entries = await session.resolve();
    for (const entry of entries) {
      expect(entry.changed).toBe(false);
    }
  });

  it("changed flag reflects file content changes", async () => {
    const files = [fx("a.txt"), fx("b.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    // Seed
    {
      using s = await cache.open();
      await s.write();
    }

    // Modify one file
    writeFileSync(fx("a.txt"), "aaa modified for changed test\n");

    cache.invalidateAll();
    using session = await cache.open();
    expect(session.status).toBe("changed");

    const entries = await session.resolve();
    // Find a.txt and b.txt
    const aEntry = entries.find(session.files.find((f) => f.includes("a.txt")) ?? "");
    const bEntry = entries.find(session.files.find((f) => f.includes("b.txt")) ?? "");

    expect(aEntry?.changed).toBe(true);
    expect(bEntry?.changed).toBe(false);

    // Restore
    writeFileSync(fx("a.txt"), "aaa\n");
  });

  it("out-of-range index returns undefined", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    const entries = await session.resolve();

    expect(entries.get(-1)).toBeUndefined();
    expect(entries.get(1)).toBeUndefined();
    expect(entries.get(0.5)).toBeUndefined();
  });

  it("entry fields are eagerly populated", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    const entries = await session.resolve();
    const entry = entries.get(0);
    expect(entry).toBeDefined();

    // All fields are direct properties, not getters
    expect(typeof entry?.size).toBe("number");
    expect(typeof entry?.mtimeMs).toBe("number");
    expect(typeof entry?.contentHashHex).toBe("string");
    expect(typeof entry?.path).toBe("string");
    expect(typeof entry?.index).toBe("number");
  });
});

describe("session.wouldNeedWrite()", () => {
  it("returns true when status is missing", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    using session = await cache.open();
    expect(session.status).toBe("missing");
    expect(session.wouldNeedWrite()).toBe(true);
  });

  it("returns false when status is upToDate and no options", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      await s.write();
    }

    cache.invalidateAll();
    using session = await cache.open();
    expect(session.status).toBe("upToDate");
    expect(session.wouldNeedWrite()).toBe(false);
  });

  it("returns true when status is upToDate but version changes", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR, version: 1 });

    {
      using s = await cache.open();
      await s.write();
    }

    cache.invalidateAll();
    using session = await cache.open();
    expect(session.wouldNeedWrite({ version: 2 })).toBe(true);
    expect(session.wouldNeedWrite({ version: 1 })).toBe(false);
  });

  it("returns false when same files, true when different files", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      await s.write();
    }

    cache.invalidateAll();
    using session = await cache.open();
    expect(session.wouldNeedWrite({ files: [fx("a.txt")] })).toBe(false);
    expect(session.wouldNeedWrite({ files: [fx("a.txt"), fx("b.txt")] })).toBe(true);
    expect(session.wouldNeedWrite({ files: [fx("b.txt")] })).toBe(true);
  });

  it("returns true when status is changed", async () => {
    const files = [fx("a.txt")];
    const cache = new FileHashCache({ cachePath: cp(), files, rootPath: FIXTURE_DIR });

    {
      using s = await cache.open();
      await s.write();
    }

    writeFileSync(fx("a.txt"), "modified\n");
    cache.invalidateAll();
    using session = await cache.open();
    expect(session.status).toBe("changed");
    expect(session.wouldNeedWrite()).toBe(true);

    writeFileSync(fx("a.txt"), "aaa\n");
  });
});
