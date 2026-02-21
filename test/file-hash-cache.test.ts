/**
 * Tests for FileHashCacheManager + FileHashCache.
 *
 * Manager holds immutable config (version, seed).
 * Cache lifecycle: open() → validate() → readRawData/readGzipData → write() → close().
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileHashCache, FileHashCacheManager, XXHash128 } from "../packages/fast-fs-hash/src/index";

// ── Test fixtures ────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures-fhc");
const CACHE_DIR = path.resolve(import.meta.dirname, "tmp-fhc-cache");

const fileA = () => path.join(FIXTURES_DIR, "a.txt");
const fileB = () => path.join(FIXTURES_DIR, "b.txt");
const fileC = () => path.join(FIXTURES_DIR, "c.txt");

let cacheCounter = 0;
/** Generate a unique cache file path per test to avoid collisions. */
function nextCache(): string {
  return path.join(CACHE_DIR, `cache-${++cacheCounter}.fsh`);
}

beforeAll(async () => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
  rmSync(CACHE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  writeFileSync(fileA(), "hello world\n");
  writeFileSync(fileB(), "goodbye world\n");
  writeFileSync(fileC(), "third file\n");

  await XXHash128.init();
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Manager Tests ────────────────────────────────────────────────────────

describe("FileHashCacheManager", () => {
  it("constructor defaults to version=0, seed=0", () => {
    const mgr = new FileHashCacheManager();
    expect(mgr.version).toBe(0);
    expect(mgr.seedLow).toBe(0);
    expect(mgr.seedHigh).toBe(0);
  });

  it("constructor stores provided options", () => {
    const mgr = new FileHashCacheManager({ version: 42, seedLow: 10, seedHigh: 20 });
    expect(mgr.version).toBe(42);
    expect(mgr.seedLow).toBe(10);
    expect(mgr.seedHigh).toBe(20);
  });

  it("constructor masks version to 24 bits", () => {
    const mgr = new FileHashCacheManager({ version: 0x1ffffff });
    expect(mgr.version).toBe(0xffffff);
  });
});

// ── Reader Tests ─────────────────────────────────────────────────────────

describe("FileHashCache", () => {
  // ── First validate (no previous cache) ─────────────────────────────

  it("first validate returns changed=true", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate([fileA(), fileB()]);
    expect(result.changed).toBe(true);
    expect(result.digest).toBeInstanceOf(Buffer);
    expect(result.digest.length).toBe(16);
    expect(result.rehashed).toBe(2);
  });

  // ── Re-validate with cache on disk ─────────────────────────────────

  it("re-validate with unchanged files returns changed=false", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA(), fileB()]);
      expect(r1.changed).toBe(true);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
    }
  });

  // ── Omit files → re-check files from cache ────────────────────────

  it("validate with no files re-checks files from cache file", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate(); // no files → use cache
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
    }
  });

  it("validate with no files detects modification", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write();
    }

    await sleep(50);
    writeFileSync(fileA(), "no-arg modified\n");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate();
      expect(r2.changed).toBe(true);
      expect(r2.rehashed).toBeGreaterThanOrEqual(1);
    }

    await sleep(50);
    writeFileSync(fileA(), "hello world\n");
  });

  it("validate with no files and no cache returns empty digest", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate();
    expect(result.changed).toBe(true);
    expect(result.rehashed).toBe(0);
    expect(result.digest.length).toBe(16);
  });

  // ── File modification detection ────────────────────────────────────

  it("detects file content change", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    let oldDigest: string;

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA(), fileB()]);
      oldDigest = r1.digest.toString("hex");
      await reader.write();
    }

    await sleep(50);
    writeFileSync(fileA(), "modified content\n");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(true);
      expect(r2.rehashed).toBeGreaterThanOrEqual(1);
      expect(r2.digest.toString("hex")).not.toBe(oldDigest);
    }

    await sleep(50);
    writeFileSync(fileA(), "hello world\n");
  });

  it("returns same digest if content restored to original", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    let originalDigest: string;

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA()]);
      originalDigest = r1.digest.toString("hex");
      await reader.write();
    }

    await sleep(50);
    writeFileSync(fileA(), "temporary change\n");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA()]);
      expect(r2.changed).toBe(true);
      await reader.write();
    }

    await sleep(50);
    writeFileSync(fileA(), "hello world\n");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r3 = await reader.validate([fileA()]);
      expect(r3.digest.toString("hex")).toBe(originalDigest);
    }

    writeFileSync(fileA(), "hello world\n");
  });

  // ── File addition / removal ────────────────────────────────────────

  it("detects file addition", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(true);
      expect(r2.rehashed).toBe(1);
    }
  });

  it("detects file removal", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA()]);
      expect(r2.changed).toBe(true);
      expect(r2.rehashed).toBe(0);
    }
  });

  // ── Order sensitivity ──────────────────────────────────────────────

  it("different file order produces different digest", async () => {
    const mgr = new FileHashCacheManager();
    const fp1 = nextCache();
    const fp2 = nextCache();

    let d1: string;
    let d2: string;
    {
      await using reader = new FileHashCache(mgr, fp1);
      await reader.open();
      const r1 = await reader.validate([fileA(), fileB()]);
      d1 = r1.digest.toString("hex");
    }
    {
      await using reader = new FileHashCache(mgr, fp2);
      await reader.open();
      const r2 = await reader.validate([fileB(), fileA()]);
      d2 = r2.digest.toString("hex");
    }
    expect(d1).not.toBe(d2);
  });

  // ── Aggregate matches hashFilesBulk ────────────────────────────────

  it("digest matches hashFilesBulk for same file order", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate([fileA(), fileB()]);
    const direct = await XXHash128.hashFilesBulk({ files: [fileA(), fileB()] });
    expect(result.digest.toString("hex")).toBe(direct.toString("hex"));
  });

  it("seeded digest matches seeded hashFilesBulk", async () => {
    const mgr = new FileHashCacheManager({ seedLow: 42, seedHigh: 99 });
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate([fileA(), fileB()]);
    const direct = await XXHash128.hashFilesBulk({
      files: [fileA(), fileB()],
      seedLow: 42,
      seedHigh: 99,
    });
    expect(result.digest.toString("hex")).toBe(direct.toString("hex"));
  });

  // ── Seed support ───────────────────────────────────────────────────

  it("different seed produces different aggregate", async () => {
    const mgr0 = new FileHashCacheManager();
    const mgr42 = new FileHashCacheManager({ seedLow: 42 });
    const fp0 = nextCache();
    const fp42 = nextCache();

    let d0: string;
    let d42: string;
    {
      await using reader = new FileHashCache(mgr0, fp0);
      await reader.open();
      const r = await reader.validate([fileA(), fileB()]);
      d0 = r.digest.toString("hex");
    }
    {
      await using reader = new FileHashCache(mgr42, fp42);
      await reader.open();
      const r = await reader.validate([fileA(), fileB()]);
      d42 = r.digest.toString("hex");
    }
    expect(d0).not.toBe(d42);
  });

  it("same manager gives consistent results across calls", async () => {
    const mgr = new FileHashCacheManager({ seedLow: 10, seedHigh: 20 });
    const fp = nextCache();

    let d1: string;
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA()]);
      d1 = r1.digest.toString("hex");
      await reader.write();
    }
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA()]);
      expect(r2.changed).toBe(false);
      expect(r2.digest.toString("hex")).toBe(d1);
    }
  });

  it("different seed on new manager rejects old cache", async () => {
    const mgr1 = new FileHashCacheManager({ seedLow: 10 });
    const mgr2 = new FileHashCacheManager({ seedLow: 99 });
    const fp = nextCache();

    let d1: string;
    {
      await using reader = new FileHashCache(mgr1, fp);
      await reader.open();
      const r1 = await reader.validate([fileA()]);
      d1 = r1.digest.toString("hex");
      await reader.write();
    }
    {
      await using reader = new FileHashCache(mgr2, fp);
      await reader.open();
      // Seed doesn't affect version/fingerprint fast-reject — entries are
      // loaded but the aggregate digest will differ because the seed is different.
      const r2 = await reader.validate([fileA()]);
      expect(r2.changed).toBe(true);
      expect(r2.digest.toString("hex")).not.toBe(d1);
    }
  });

  // ── Missing files ──────────────────────────────────────────────────

  it("missing file produces zero hash matching hashFilesBulk", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate([fileA(), "/no/such/file.txt"]);
    const direct = await XXHash128.hashFilesBulk({ files: [fileA(), "/no/such/file.txt"] });
    expect(result.digest.toString("hex")).toBe(direct.toString("hex"));
  });

  // ── Empty file list ────────────────────────────────────────────────

  it("empty file list returns deterministic digest", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const r1 = await reader.validate([]);
    expect(r1.changed).toBe(true);
    expect(r1.digest.length).toBe(16);
    expect(r1.rehashed).toBe(0);
  });

  it("second empty validate with cache returns changed=false", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([]);
      await reader.write();
    }
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([]);
      expect(r2.changed).toBe(false);
    }
  });

  // ── Header info ────────────────────────────────────────────────────

  it("header returns null before open", () => {
    const mgr = new FileHashCacheManager();
    const reader = new FileHashCache(mgr, nextCache());
    expect(reader.header).toBeNull();
  });

  it("header returns null when file does not exist", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    expect(reader.header).toBeNull();
  });

  it("header returns info after open on valid cache", async () => {
    const mgr = new FileHashCacheManager({ version: 7 });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp, "header-test");
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp, "header-test");
      await reader.open();
      const hdr = reader.header;
      if (hdr === null) {
        throw new Error("Expected header to be non-null");
      }
      expect(hdr.version).toBe(7);
      expect(hdr.entryCount).toBe(1);
      expect(hdr.digest.length).toBe(16);
      expect(hdr.fingerprint.equals(reader.fingerprint)).toBe(true);
    }
  });

  it("header returns null for garbage file", async () => {
    const fp = nextCache();
    writeFileSync(fp, "not a cache file");
    const mgr = new FileHashCacheManager();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    expect(reader.header).toBeNull();
  });

  // ── Version fast-reject ────────────────────────────────────────────

  it("version mismatch causes fast reject (changed=true, all rehashed)", async () => {
    const mgr1 = new FileHashCacheManager({ version: 1 });
    const mgr2 = new FileHashCacheManager({ version: 2 });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr1, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write();
    }
    {
      // Confirm same version is fine
      await using reader = new FileHashCache(mgr1, fp);
      await reader.open();
      expect(reader.headerValid).toBe(true);
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
    }
    {
      // Different version → fast reject
      await using reader = new FileHashCache(mgr2, fp);
      await reader.open();
      expect(reader.headerValid).toBe(false);
      const r3 = await reader.validate([fileA(), fileB()]);
      expect(r3.changed).toBe(true);
      expect(r3.rehashed).toBe(2);
    }
  });

  it("version change does not affect digest computation for same seed", async () => {
    const mgr1 = new FileHashCacheManager({ version: 1 });
    const mgr2 = new FileHashCacheManager({ version: 2 });
    const fp1 = nextCache();
    const fp2 = nextCache();

    let d1: string;
    let d2: string;
    {
      await using reader = new FileHashCache(mgr1, fp1);
      await reader.open();
      const r = await reader.validate([fileA()]);
      d1 = r.digest.toString("hex");
    }
    {
      await using reader = new FileHashCache(mgr2, fp2);
      await reader.open();
      const r = await reader.validate([fileA()]);
      d2 = r.digest.toString("hex");
    }
    expect(d1).toBe(d2);
  });

  // ── Fingerprint fast-reject ────────────────────────────────────────

  it("fingerprint mismatch causes fast reject (changed=true, all rehashed)", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp, "config-A");
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write();
    }
    {
      // Same fingerprint → OK
      await using reader = new FileHashCache(mgr, fp, "config-A");
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
    }
    {
      // Different fingerprint → fast reject
      await using reader = new FileHashCache(mgr, fp, "config-B");
      await reader.open();
      expect(reader.headerValid).toBe(false);
      const r3 = await reader.validate([fileA(), fileB()]);
      expect(r3.changed).toBe(true);
      expect(r3.rehashed).toBe(2);
    }
  });

  it("fingerprint does not affect digest computation", async () => {
    const mgr = new FileHashCacheManager();
    const fpX = nextCache();
    const fpY = nextCache();

    let dX: string;
    let dY: string;
    {
      await using reader = new FileHashCache(mgr, fpX, "config-X");
      await reader.open();
      const r = await reader.validate([fileA()]);
      dX = r.digest.toString("hex");
    }
    {
      await using reader = new FileHashCache(mgr, fpY, "config-Y");
      await reader.open();
      const r = await reader.validate([fileA()]);
      dY = r.digest.toString("hex");
    }
    expect(dX).toBe(dY);
  });

  it("fingerprint + version combined fast-reject", async () => {
    const mgr1 = new FileHashCacheManager({ version: 1 });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr1, fp, "A");
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }
    {
      // Fingerprint mismatch
      const mgr2 = new FileHashCacheManager({ version: 1 });
      await using reader = new FileHashCache(mgr2, fp, "B");
      await reader.open();
      const r = await reader.validate([fileA()]);
      expect(r.changed).toBe(true);
      expect(r.rehashed).toBe(1);
    }
    {
      // Version mismatch
      const mgr3 = new FileHashCacheManager({ version: 2 });
      await using reader = new FileHashCache(mgr3, fp, "A");
      await reader.open();
      const r = await reader.validate([fileA()]);
      expect(r.changed).toBe(true);
      expect(r.rehashed).toBe(1);
    }
    {
      // Both match → OK
      await using reader = new FileHashCache(mgr1, fp, "A");
      await reader.open();
      const r = await reader.validate([fileA()]);
      expect(r.changed).toBe(false);
      expect(r.rehashed).toBe(0);
    }
  });

  // ── readFiles ──────────────────────────────────────────────────────

  it("readFiles returns validated paths after validate", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    await reader.validate([fileB(), fileA()]);
    expect(reader.readFiles()).toEqual([fileB(), fileA()]);
  });

  it("readFiles returns paths from cache after open (before validate)", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileB(), fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      expect(reader.readFiles()).toEqual([fileB(), fileA()]);
    }
  });

  it("readFiles returns empty for empty cache", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    await reader.validate([]);
    expect(reader.readFiles()).toEqual([]);
  });

  // ── Cache round-trip ───────────────────────────────────────────────

  it("cache preserves entries across write+read cycles", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA(), fileB()]);
      expect(r1.changed).toBe(true);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
    }
  });

  it("cache detects file change across write+read cycles", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write();
    }

    await sleep(50);
    writeFileSync(fileA(), "changed after serialize\n");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(true);
      expect(r2.rehashed).toBeGreaterThanOrEqual(1);
    }

    await sleep(50);
    writeFileSync(fileA(), "hello world\n");
  });

  // ── Error handling ─────────────────────────────────────────────────

  it("open on nonexistent file proceeds without error", async () => {
    const mgr = new FileHashCacheManager();
    await using reader = new FileHashCache(mgr, "/no/such/file.fsh");
    await reader.open();
    expect(reader.header).toBeNull();
    expect(reader.headerValid).toBe(false);
  });

  it("validate works after open on nonexistent file", async () => {
    const mgr = new FileHashCacheManager();
    await using reader = new FileHashCache(mgr, "/no/such/file.fsh");
    await reader.open();
    const result = await reader.validate([fileA()]);
    expect(result.changed).toBe(true);
    expect(result.rehashed).toBe(1);
  });

  it("write requires validate to have been called", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    await expect(reader.write()).rejects.toThrow(/validate/i);
  });

  // ── Multiple validate cycles ───────────────────────────────────────

  it("handles multiple validate cycles correctly", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    // Cycle 1: 2 files
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA(), fileB()]);
      expect(r1.changed).toBe(true);
      expect(r1.rehashed).toBe(2);
      await reader.write();
    }

    // Cycle 2: same 2 files → unchanged
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
      await reader.write();
    }

    // Cycle 3: add third file
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r3 = await reader.validate([fileA(), fileB(), fileC()]);
      expect(r3.changed).toBe(true);
      expect(r3.rehashed).toBe(1);
      await reader.write();
    }

    // Cycle 4: same 3 files → unchanged
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r4 = await reader.validate([fileA(), fileB(), fileC()]);
      expect(r4.changed).toBe(false);
      expect(r4.rehashed).toBe(0);
      await reader.write();
    }

    // Cycle 5: remove one file
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r5 = await reader.validate([fileA(), fileC()]);
      expect(r5.changed).toBe(true);
      expect(r5.rehashed).toBe(0);
    }
  });

  // ── Three files ────────────────────────────────────────────────────

  it("three-file digest matches hashFilesBulk", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const files = [fileA(), fileB(), fileC()];
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate(files);
    const direct = await XXHash128.hashFilesBulk({ files });
    expect(result.digest.toString("hex")).toBe(direct.toString("hex"));
  });

  // ── Iterable input ─────────────────────────────────────────────────

  it("accepts Set as Iterable<string>", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    const result = await reader.validate(new Set([fileA(), fileB()]));
    expect(result.changed).toBe(true);
    expect(reader.readFiles()).toHaveLength(2);
  });

  it("accepts generator as Iterable<string>", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    function* gen() {
      yield fileA();
      yield fileB();
    }
    const result = await reader.validate(gen());
    expect(result.changed).toBe(true);
    expect(reader.readFiles()).toHaveLength(2);
  });

  // ── Raw data round-trips ───────────────────────────────────────────

  it("raw data round-trips binary items as Buffer", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const item1 = new Uint8Array([10, 20, 30, 40, 50]);
    const item2 = new Uint8Array([0xff]);
    const item3 = new Uint8Array(0);

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ raw: [item1, item2, item3] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readRawData();
      expect(items).toHaveLength(3);
      expect(items[0]).toBeInstanceOf(Buffer);
      expect(Buffer.from(items[0] as Uint8Array).toString("hex")).toBe(Buffer.from(item1).toString("hex"));
      expect(Buffer.from(items[1] as Uint8Array).toString("hex")).toBe(Buffer.from(item2).toString("hex"));
      expect(items[2] as Uint8Array).toHaveLength(0);
    }
  });

  it("raw data round-trips string items", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ raw: ["hello world", "", "unicode: ñ 日本語"] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readRawData();
      expect(items).toHaveLength(3);
      expect(items[0]).toBe("hello world");
      expect(items[1]).toBe("");
      expect(items[2]).toBe("unicode: ñ 日本語");
    }
  });

  it("raw data round-trips JSON items", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const obj = { exportNames: ["foo", "bar"], version: 3 };
    const arr = [1, "two", null, true];

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ raw: [obj, arr, 42, true] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readRawData();
      expect(items).toHaveLength(4);
      expect(items[0]).toEqual({ exportNames: ["foo", "bar"], version: 3 });
      expect(items[1]).toEqual([1, "two", null, true]);
      expect(items[2]).toBe(42);
      expect(items[3]).toBe(true);
    }
  });

  it("raw data round-trips null and undefined natively", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ raw: [null, undefined, null, undefined] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readRawData();
      expect(items).toHaveLength(4);
      expect(items[0]).toBe(null);
      expect(items[1]).toBe(undefined);
      expect(items[2]).toBe(null);
      expect(items[3]).toBe(undefined);
    }
  });

  it("raw data round-trips mixed types", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const str = "compiled code here";
    const meta = { name: "test", deps: ["a", "b"] };

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ raw: [meta, str, binary, 0, false, null, undefined] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readRawData();
      expect(items).toHaveLength(7);
      expect(items[0]).toEqual({ name: "test", deps: ["a", "b"] });
      expect(items[1]).toBe("compiled code here");
      expect(items[2]).toBeInstanceOf(Buffer);
      expect(Buffer.from(items[2] as Uint8Array).toString("hex")).toBe("deadbeef");
      expect(items[3]).toBe(0);
      expect(items[4]).toBe(false);
      expect(items[5]).toBe(null);
      expect(items[6]).toBe(undefined);
    }
  });

  it("readRawData returns empty array when no raw data", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      expect(await reader.readRawData()).toEqual([]);
    }
  });

  it("readGzipData returns empty array when no gzip data", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      expect(await reader.readGzipData()).toEqual([]);
    }
  });

  it("large raw data item round-trips correctly", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const big = new Uint8Array(100_000);
    for (let i = 0; i < big.length; i++) {
      big[i] = i & 0xff;
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ raw: [big] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readRawData();
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(Buffer);
      expect(items[0] as Uint8Array).toHaveLength(100_000);
      expect(Buffer.from(items[0] as Uint8Array).equals(Buffer.from(big))).toBe(true);
    }
  });

  // ── Gzip data round-trips ─────────────────────────────────────────

  it("gzip data compresses and decompresses correctly", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const big = new Uint8Array(10_000);
    big.fill(0x42);

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ gzip: [big], gzipLevel: 1 });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const items = await reader.readGzipData();
      expect(items).toHaveLength(1);
      expect(items[0]).toBeInstanceOf(Buffer);
      expect(items[0] as Uint8Array).toHaveLength(10_000);
      expect((items[0] as Uint8Array).every((b: number) => b === 0x42)).toBe(true);
    }
  });

  it("gzip level 6 compresses and decompresses correctly", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const inputItems = [new Uint8Array([1, 2, 3]), new Uint8Array(5000).fill(0xaa), new Uint8Array(0)];

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ gzip: inputItems, gzipLevel: 6 });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const restored = await reader.readGzipData();
      expect(restored).toHaveLength(3);
      expect(Buffer.from(restored[0] as Uint8Array).toString("hex")).toBe("010203");
      expect(restored[1] as Uint8Array).toHaveLength(5000);
      expect((restored[1] as Uint8Array).every((b: number) => b === 0xaa)).toBe(true);
      expect(restored[2] as Uint8Array).toHaveLength(0);
    }
  });

  it("gzip level out of range throws RangeError", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    await using reader = new FileHashCache(mgr, fp);
    await reader.open();
    await reader.validate([fileA()]);
    await expect(reader.write({ gzip: [new Uint8Array(1)], gzipLevel: 0 })).rejects.toThrow(RangeError);
    await expect(reader.write({ gzip: [new Uint8Array(1)], gzipLevel: 10 })).rejects.toThrow(RangeError);
  });

  it("validate ignores data sections in cache file", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write({ raw: [new Uint8Array([1, 2, 3])] });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(false);
      expect(r2.rehashed).toBe(0);
    }
  });

  // ── Combined raw + gzip data ───────────────────────────────────────

  it("raw and gzip data coexist independently", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const rawPayload = { exportNames: ["foo", "bar"] };
    const gzipPayload = "a long source code string".repeat(100);

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({
        raw: [rawPayload],
        gzip: [gzipPayload],
        gzipLevel: 3,
      });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();

      const rawItems = await reader.readRawData();
      expect(rawItems).toHaveLength(1);
      expect(rawItems[0]).toEqual({ exportNames: ["foo", "bar"] });

      const gzipItems = await reader.readGzipData();
      expect(gzipItems).toHaveLength(1);
      expect(gzipItems[0]).toBe("a long source code string".repeat(100));
    }
  });

  it("mixed raw + gzip with multiple types round-trip", async () => {
    const mgr = new FileHashCacheManager({
      seedLow: 7,
      seedHigh: 13,
      version: 100,
    });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB(), fileC()]);
      await reader.write({
        raw: [{ key: "value", nested: [1, 2] }, 42],
        gzip: ["hello sidecar", new Uint8Array(1000).fill(0xbb)],
        gzipLevel: 4,
      });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();

      // Header info
      const hdr = reader.header;
      if (hdr === null) {
        throw new Error("Expected header to be non-null");
      }
      expect(hdr.version).toBe(100);

      // Cache entries still work
      const r2 = await reader.validate();
      expect(r2.changed).toBe(false);
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();

      // Raw items recovered
      const rawItems = await reader.readRawData();
      expect(rawItems).toHaveLength(2);
      expect(rawItems[0]).toEqual({ key: "value", nested: [1, 2] });
      expect(rawItems[1]).toBe(42);

      // Gzip items recovered
      const gzipItems = await reader.readGzipData();
      expect(gzipItems).toHaveLength(2);
      expect(gzipItems[0]).toBe("hello sidecar");
      expect(gzipItems[1]).toBeInstanceOf(Buffer);
      expect(gzipItems[1] as Uint8Array).toHaveLength(1000);
    }
  });

  it("gzip data round-trips typed data correctly", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const big = new Uint8Array(50_000);
    for (let i = 0; i < big.length; i++) {
      big[i] = i % 7;
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({
        gzip: [
          { metadata: true, count: 42 },
          "a long source code string".repeat(100),
          big,
          ["array", "of", "strings"],
          null,
          undefined,
        ],
        gzipLevel: 3,
      });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const restored = await reader.readGzipData();
      expect(restored).toHaveLength(6);
      expect(restored[0]).toEqual({ metadata: true, count: 42 });
      expect(restored[1]).toBe("a long source code string".repeat(100));
      expect(restored[2]).toBeInstanceOf(Buffer);
      expect(Buffer.from(restored[2] as Uint8Array).equals(Buffer.from(big))).toBe(true);
      expect(restored[3]).toEqual(["array", "of", "strings"]);
      expect(restored[4]).toBe(null);
      expect(restored[5]).toBe(undefined);
    }
  });

  // ── Version + data combined ────────────────────────────────────────

  it("version and typed data work together", async () => {
    const mgr = new FileHashCacheManager({ version: 7 });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({
        raw: [{ schema: 1 }],
        gzip: ["bundle code"],
      });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const hdr = reader.header;
      if (hdr === null) {
        throw new Error("Expected header to be non-null");
      }
      expect(hdr.version).toBe(7);

      const r2 = await reader.validate([fileA()]);
      expect(r2.changed).toBe(false);

      const rawData = await reader.readRawData();
      expect(rawData).toHaveLength(1);
      expect(rawData[0]).toEqual({ schema: 1 });

      const gzipData = await reader.readGzipData();
      expect(gzipData).toHaveLength(1);
      expect(gzipData[0]).toBe("bundle code");
    }

    {
      // Version mismatch → fast reject; data from old cache not used
      const mgr8 = new FileHashCacheManager({ version: 8 });
      await using reader = new FileHashCache(mgr8, fp);
      await reader.open();
      expect(reader.headerValid).toBe(false);
      const r3 = await reader.validate([fileA()]);
      expect(r3.changed).toBe(true);
      expect(r3.rehashed).toBe(1);
    }
  });

  // ── Write creates parent directories ───────────────────────────────

  it("write creates parent directories", async () => {
    const mgr = new FileHashCacheManager();
    const fp = path.join(CACHE_DIR, "deep", "nested", "dir", "cache.fsh");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      expect(reader.header).not.toBeNull();
    }
  });

  // ── Write to different path ────────────────────────────────────────

  it("write to filePath option writes to different location", async () => {
    const mgr = new FileHashCacheManager();
    const fp1 = nextCache();
    const fp2 = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp1);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({ filePath: fp2 });
    }

    // fp2 should have the cache
    {
      await using reader = new FileHashCache(mgr, fp2);
      await reader.open();
      expect(reader.header).not.toBeNull();
      const r = await reader.validate([fileA()]);
      expect(r.changed).toBe(false);
    }
  });

  // ── Header section lengths ─────────────────────────────────────────

  it("header encodes correct section lengths", async () => {
    const mgr = new FileHashCacheManager({ version: 1 });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA(), fileB()]);
      await reader.write({
        raw: [new Uint8Array([1, 2, 3])],
        gzip: [new Uint8Array(1000).fill(0xdd)],
        gzipLevel: 1,
      });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const hdr = reader.header;
      if (hdr === null) {
        throw new Error("Expected header to be non-null");
      }
      expect(hdr.entryCount).toBe(2);
      expect(hdr.pathsLen).toBeGreaterThan(0);
      expect(hdr.rawDataLen).toBeGreaterThan(0);
      expect(hdr.rawItemCount).toBe(1);
      expect(hdr.gzipDataLen).toBeGreaterThan(0);
      expect(hdr.gzipItemCount).toBe(1);
      expect(hdr.gzipUncompressedLen).toBeGreaterThan(0);

      // Total file = header + entries + paths + raw + gzip
      const diskBuf = readFileSync(fp);
      expect(diskBuf.length).toBe(64 + hdr.entryCount * 40 + hdr.pathsLen + hdr.rawDataLen + hdr.gzipDataLen);
    }
  });

  it("empty data sections have zero lengths in header", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const hdr = reader.header;
      if (hdr === null) {
        throw new Error("Expected header to be non-null");
      }
      expect(hdr.rawDataLen).toBe(0);
      expect(hdr.rawItemCount).toBe(0);
      expect(hdr.gzipDataLen).toBe(0);
      expect(hdr.gzipItemCount).toBe(0);
      expect(hdr.gzipUncompressedLen).toBe(0);
    }
  });

  // ── Close + dispose ────────────────────────────────────────────────

  it("close can be called multiple times safely", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();
    const reader = new FileHashCache(mgr, fp);
    await reader.open();
    await reader.close();
    await reader.close();
    await reader.close();
  });

  it("async dispose works via await using", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write();
    }
    // Implicitly disposed — should not leak file handle

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA()]);
      expect(r2.changed).toBe(false);
    }
  });

  // ── Write reuses validated hashes ──────────────────────────────────

  it("write reuses cached hashes for unchanged files", async () => {
    const mgr = new FileHashCacheManager();
    const fp = nextCache();

    // Cycle 1: hash all files
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r1 = await reader.validate([fileA(), fileB()]);
      expect(r1.rehashed).toBe(2);
      await reader.write();
    }

    // Cycle 2: modify one file — only that file rehashed
    await sleep(50);
    writeFileSync(fileB(), "modified B\n");

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r2 = await reader.validate([fileA(), fileB()]);
      expect(r2.changed).toBe(true);
      expect(r2.rehashed).toBe(1); // only fileB
      await reader.write(); // write with cached fileA hash + new fileB hash
    }

    // Cycle 3: nothing changed — all reused
    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      const r3 = await reader.validate([fileA(), fileB()]);
      expect(r3.changed).toBe(false);
      expect(r3.rehashed).toBe(0);
    }

    await sleep(50);
    writeFileSync(fileB(), "goodbye world\n");
  });

  // ── readRawData / readGzipData on nonexistent file ─────────────────

  it("readRawData returns empty for nonexistent file", async () => {
    const mgr = new FileHashCacheManager();
    await using reader = new FileHashCache(mgr, "/no/such/file.fsh");
    await reader.open();
    expect(await reader.readRawData()).toEqual([]);
  });

  it("readGzipData returns empty for nonexistent file", async () => {
    const mgr = new FileHashCacheManager();
    await using reader = new FileHashCache(mgr, "/no/such/file.fsh");
    await reader.open();
    expect(await reader.readGzipData()).toEqual([]);
  });

  // ── Data can be read in any order ──────────────────────────────────

  it("data can be read in any order (gzip then raw)", async () => {
    const mgr = new FileHashCacheManager({ version: 1 });
    const fp = nextCache();

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();
      await reader.validate([fileA()]);
      await reader.write({
        raw: ["raw-first"],
        gzip: ["gzip-second"],
      });
    }

    {
      await using reader = new FileHashCache(mgr, fp);
      await reader.open();

      // Read gzip before raw
      const gz = await reader.readGzipData();
      expect(gz[0]).toBe("gzip-second");

      const raw = await reader.readRawData();
      expect(raw[0]).toBe("raw-first");
    }
  });
});
