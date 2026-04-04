import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-basics");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

function makeCache(
  cp: string,
  files: Iterable<string> | null,
  options?: { rootPath?: string; version?: number; fingerprint?: Uint8Array | null }
): FileHashCache {
  return new FileHashCache({
    cachePath: cp,
    files,
    rootPath: options?.rootPath ?? FIXTURE_DIR,
    version: options?.version ?? 1,
    fingerprint: options?.fingerprint,
  });
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

describe("FileHashCache [native]", () => {
  //  - check (open without write = validate only)

  describe("check (no write)", () => {
    it("returns 'missing' when no cache file exists", async () => {
      const cp = cachePath("no-exist");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);
      using session = await cache.open();
      expect(session.status).toBe("missing");
    });

    it("returns 'upToDate' after update with no changes", async () => {
      const cp = cachePath("val-true");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      // Seed the cache via open + write
      {
        using s1 = await cache.open();
        expect(s1.status).not.toBe("upToDate");
        await s1.write();
      }

      // Check should return 'upToDate'
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });

    it("returns 'changed' after a file changes", async () => {
      const cp = cachePath("val-change");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      // Seed
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Modify a file
      writeFileSync(fixtureFile("a.txt"), "modified content\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Check should return 'changed'
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("changed");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("returns 'stale' with version mismatch", async () => {
      const cp = cachePath("val-ver");
      const files = [fixtureFile("a.txt")];

      {
        const cache1 = makeCache(cp, files);
        using s1 = await cache1.open();
        await s1.write();
      }

      {
        const cache2 = makeCache(cp, files, { version: 2 });
        using s2 = await cache2.open();
        expect(s2.status).toBe("stale");
      }
    });

    it("returns a valid status with empty file list and no cache", async () => {
      const cache = makeCache(cachePath("val-empty"), []);
      using session = await cache.open();
      // Empty file list: returns 'upToDate' (nothing to invalidate)
      expect(["upToDate", "missing"]).toContain(session.status);
    });
  });

  //  - update

  describe("update", () => {
    it("writes cache file on first run", async () => {
      const cp = cachePath("upd-first");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      using session = await cache.open();
      expect(session.status).not.toBe("upToDate");
      await session.write();
    });

    it("reports status='upToDate' when nothing changed", async () => {
      const cp = cachePath("upd-nochange");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      // Seed
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Second update — nothing changed
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });

    it("detects changed files", async () => {
      const cp = cachePath("upd-detect");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      const cache = makeCache(cp, files);

      // Seed
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Modify
      writeFileSync(fixtureFile("b.txt"), "changed content\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("b.txt"), t, t);

      // Open — detect change, write
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("changed");
        await s2.write();
      }

      // Restore
      writeFileSync(fixtureFile("b.txt"), "goodbye world\n");
    });

    it("write can set user values", async () => {
      const cp = cachePath("upd-uval");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Write with user values
      {
        using s1 = await cache.open();
        await s1.write({
          userValue0: 42,
          userValue1: 100,
          userValue2: 200,
          userValue3: 300,
        });
      }

      // Read them back
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userValue0).toBe(42);
        expect(s2.userValue1).toBe(100);
        expect(s2.userValue2).toBe(200);
        expect(s2.userValue3).toBe(300);
      }
    });

    it("write can set single user data item", async () => {
      const cp = cachePath("upd-udata");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Write user data
      const testData = Buffer.from("test user data payload");
      {
        using s1 = await cache.open();
        await s1.write({ userData: [testData] });
      }

      // Read user data back
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(1);
        const totalSize = s2.userData.reduce((s, item) => s + item.byteLength, 0);
        expect(totalSize).toBe(testData.length);
        const item0 = s2.userData[0];
        expect(item0.byteLength).toBe(testData.length);
        expect(Buffer.from(item0).equals(testData)).toBe(true);
      }
    });

    it("skips write when nothing changed", async () => {
      const cp = cachePath("upd-skip");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Second open — nothing changed
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });
  });

  //  - options

  describe("options", () => {
    it("version is treated as u32", async () => {
      const cache = makeCache(cachePath("ver-u32"), [], { version: -1 });
      using session = await cache.open();
      expect(session.version).toBe(0xffffffff);
    });

    it("fingerprint must be 16 bytes", async () => {
      const cache = makeCache(cachePath(), [], { version: 0, fingerprint: new Uint8Array(8) });
      await expect(cache.open()).rejects.toThrow("16 bytes");
    });

    it("fingerprint rejects cache", async () => {
      const cp = cachePath("fp-reject");
      const files = [fixtureFile("a.txt")];

      const fp1 = new Uint8Array(16).fill(1);
      const fp2 = new Uint8Array(16).fill(2);

      {
        const cache1 = makeCache(cp, files, { fingerprint: fp1 });
        using s1 = await cache1.open();
        await s1.write();
      }

      {
        const cache2 = makeCache(cp, files, { fingerprint: fp2 });
        using s2 = await cache2.open();
        expect(s2.status).toBe("stale");
      }
    });

    it("different fingerprint per open", async () => {
      const cp = cachePath("fp-mut");
      const files = [fixtureFile("a.txt")];

      const fp1 = new Uint8Array(16).fill(1);
      const fp2 = new Uint8Array(16).fill(2);

      // Write with fp1
      {
        const cache1 = makeCache(cp, files, { fingerprint: fp1 });
        using s1 = await cache1.open();
        await s1.write();
      }

      // Read with fp1 — should be upToDate
      {
        const cache2 = makeCache(cp, files, { fingerprint: fp1 });
        using s2 = await cache2.open();
        expect(s2.status).toBe("upToDate");
      }

      // Read with fp2 — should be stale
      {
        const cache3 = makeCache(cp, files, { fingerprint: fp2 });
        using s3 = await cache3.open();
        expect(s3.status).toBe("stale");
      }
    });
  });

  //  - userData (indexed array)

  describe("userData", () => {
    it("writes multiple items and reads each back by index", async () => {
      const cp = cachePath("ud-multi");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      const items = [Buffer.from("first item"), Buffer.from("second item data"), Buffer.from("third")];

      {
        using s1 = await cache.open();
        await s1.write({ userData: items });
      }

      // Read back
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(3);
        const totalSize = s2.userData.reduce((s, item) => s + item.byteLength, 0);
        expect(totalSize).toBe(10 + 16 + 5);

        for (let i = 0; i < 3; i++) {
          const item = items[i] ?? Buffer.alloc(0);
          const readItem = s2.userData[i];
          expect(Buffer.from(readItem).equals(item)).toBe(true);
        }
      }
    });

    it("empty array produces zero userData items", async () => {
      const cp = cachePath("ud-empty");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write({ userData: [] });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(0);
      }
    });

    it("null clears user data", async () => {
      const cp = cachePath("ud-null");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Write user data
      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.from("some data")] });
      }

      // Modify to trigger write, clear userData
      writeFileSync(fixtureFile("a.txt"), "modified for ud-null\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        await s2.write({ userData: null });
      }

      // Read back — should have no data
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.userData.length).toBe(0);
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("can read old data and write new data", async () => {
      const cp = cachePath("ud-readwrite");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed with user data
      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.from("original")] });
      }

      // Modify file to trigger changed status
      writeFileSync(fixtureFile("a.txt"), "modified for ud-rw\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Read old data from session and write new data
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(1);
        const old = s2.userData[0];
        await s2.write({
          userData: [Buffer.from("prefix:"), old],
        });
      }

      // Read back
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.userData.length).toBe(2);
        const item0 = s3.userData[0];
        const item1 = s3.userData[1];
        expect(item0.toString()).toBe("prefix:");
        expect(item1.toString()).toBe("original");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("no old cache means empty userData", async () => {
      const cp = cachePath("ud-noold");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      using session = await cache.open();
      expect(session.userData.length).toBe(0);
    });
  });

  //  - userData buffer tests

  describe("userData buffer items", () => {
    it("writes and reads a single buffer item", async () => {
      const cp = cachePath("ud-str-single");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.from("hello world")] });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(1);
        expect(Buffer.isBuffer(s2.userData[0])).toBe(true);
        expect(s2.userData[0].toString("utf8")).toBe("hello world");
      }
    });

    it("writes and reads multiple buffer items", async () => {
      const cp = cachePath("ud-str-multi");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      const bufs = [Buffer.from("first"), Buffer.from("second item"), Buffer.from("third")];
      {
        using s1 = await cache.open();
        await s1.write({ userData: bufs });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(3);
        for (let i = 0; i < bufs.length; i++) {
          expect(Buffer.isBuffer(s2.userData[i])).toBe(true);
          expect(s2.userData[i].toString("utf8")).toBe(bufs[i].toString("utf8"));
        }
      }
    });

    it("writes and reads mixed content buffer items", async () => {
      const cp = cachePath("ud-str-mixed");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      const items: Uint8Array[] = [
        Buffer.from("binary data"),
        Buffer.from("string item"),
        Buffer.from([0x00, 0xff, 0x42]),
        Buffer.from("another string"),
      ];
      {
        using s1 = await cache.open();
        await s1.write({ userData: items });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(4);

        expect(Buffer.isBuffer(s2.userData[0])).toBe(true);
        expect(s2.userData[0].toString()).toBe("binary data");

        expect(Buffer.isBuffer(s2.userData[1])).toBe(true);
        expect(s2.userData[1].toString()).toBe("string item");

        expect(Buffer.isBuffer(s2.userData[2])).toBe(true);
        expect(Buffer.from(s2.userData[2]).equals(Buffer.from([0x00, 0xff, 0x42]))).toBe(true);

        expect(Buffer.isBuffer(s2.userData[3])).toBe(true);
        expect(s2.userData[3].toString()).toBe("another string");
      }
    });

    it("handles empty buffer item", async () => {
      const cp = cachePath("ud-str-empty");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.alloc(0), Buffer.from("non-empty"), Buffer.alloc(0)] });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(3);
        expect(s2.userData[0].length).toBe(0);
        expect(s2.userData[1].toString()).toBe("non-empty");
        expect(s2.userData[2].length).toBe(0);
      }
    });

    it("handles UTF-8 multi-byte content", async () => {
      const cp = cachePath("ud-str-utf8");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      const utf8Str = "日本語テスト 🚀 émojis";
      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.from(utf8Str)] });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userData.length).toBe(1);
        expect(Buffer.isBuffer(s2.userData[0])).toBe(true);
        expect(s2.userData[0].toString("utf8")).toBe(utf8Str);
      }
    });

    it("buffer item round-trips correctly", async () => {
      const cp = cachePath("ud-str-readbuf");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.from("test data")] });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        const item = s2.userData[0];
        expect(Buffer.isBuffer(item)).toBe(true);
        expect(item.toString("utf8")).toBe("test data");
      }
    });

    it("userData survives preserve (write without userData)", async () => {
      const cp = cachePath("ud-str-preserve");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write({
          userData: [Buffer.from("preserved first"), Buffer.from("preserved second")],
        });
      }

      writeFileSync(fixtureFile("a.txt"), "modified for str-preserve\n");
      const t = new Date(Date.now() + 3000);
      utimesSync(fixtureFile("a.txt"), t, t);

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        await s2.write({ userValue0: 99 });
      }

      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.userValue0).toBe(99);
        expect(s3.userData.length).toBe(2);
        expect(Buffer.isBuffer(s3.userData[0])).toBe(true);
        expect(s3.userData[0].toString()).toBe("preserved first");
        expect(Buffer.isBuffer(s3.userData[1])).toBe(true);
        expect(s3.userData[1].toString()).toBe("preserved second");
      }

      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("userData with changing files in write", async () => {
      const cp = cachePath("ud-str-chgfiles");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      {
        const cache1 = makeCache(cp, files1);
        using s1 = await cache1.open();
        await s1.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          userData: [Buffer.from("data for new files")],
        });
      }

      {
        const cache2 = makeCache(cp, files2);
        using s2 = await cache2.open();
        expect(s2.status).toBe("upToDate");
        expect(s2.userData.length).toBe(1);
        expect(Buffer.isBuffer(s2.userData[0])).toBe(true);
        expect(s2.userData[0].toString()).toBe("data for new files");
      }
    });

    it("userData total size is correct with multiple items", async () => {
      const cp = cachePath("ud-str-totalsize");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      const items: Uint8Array[] = [Buffer.from("abc"), Buffer.from("defgh"), Buffer.from("日本")];
      const expectedSize = items.reduce((s, b) => s + b.byteLength, 0);

      {
        using s1 = await cache.open();
        await s1.write({ userData: items });
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        const totalSize = s2.userData.reduce((s, item) => s + item.byteLength, 0);
        expect(totalSize).toBe(expectedSize);
      }
    });

    it("null userData clears user data", async () => {
      const cp = cachePath("ud-str-clear");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write({ userData: [Buffer.from("will be cleared")] });
      }

      writeFileSync(fixtureFile("a.txt"), "modified for str-clear\n");
      const t = new Date(Date.now() + 4000);
      utimesSync(fixtureFile("a.txt"), t, t);
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        await s2.write({ userData: null });
      }

      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.userData.length).toBe(0);
      }

      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - write with new files

  describe("write with new files", () => {
    it("can change file list during write", async () => {
      const cp = cachePath("setfiles");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      {
        const cache1 = makeCache(cp, files1);
        using s1 = await cache1.open();
        await s1.write({ files: files2, rootPath: FIXTURE_DIR });
      }

      // Verify the cache was written with the updated file list
      {
        const cache2 = makeCache(cp, files2);
        using s2 = await cache2.open();
        expect(s2.status).toBe("upToDate");
      }
    });
  });

  //  - write preserves old user data

  describe("write preserves old user data", () => {
    it("writes cache and preserves old user data when no userData in write options", async () => {
      const cp = cachePath("cb-true");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed with user data
      {
        using s1 = await cache.open();
        await s1.write({
          userData: [Buffer.from("preserved data")],
          userValue0: 42,
        });
      }

      // Modify file to trigger changed status
      writeFileSync(fixtureFile("a.txt"), "modified for cb-true\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Open and write without specifying userData — should preserve old
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("changed");
        await s2.write();
      }

      // Verify old user data was preserved
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userValue0).toBe(42);
        expect(s3.userData.length).toBe(1);
        const item = s3.userData[0];
        expect(item.toString()).toBe("preserved data");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("write on first run (no old cache) creates a valid cache", async () => {
      const cp = cachePath("cb-true-first");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        expect(s1.status).toBe("missing");
        await s1.write();
      }

      // Verify cache was written
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });
  });

  //  - no write (validate only, no write)

  describe("no write", () => {
    it("does not write cache when write() is never called", async () => {
      const cp = cachePath("cb-false");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Open but don't write
      {
        using s1 = await cache.open();
        expect(s1.status).toBe("missing");
      }

      // Cache should not exist
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("missing");
      }
    });

    it("does not overwrite existing cache when write() is not called", async () => {
      const cp = cachePath("cb-false-existing");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Modify file
      writeFileSync(fixtureFile("a.txt"), "modified for cb-false\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Open but don't write
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("changed");
      }

      // Cache should still report changed (old data not updated)
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.status).toBe("changed");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - reuse mode (files=null, reuse old file list)

  describe("reuse mode (files=null)", () => {
    it("reuses file list from old cache on disk", async () => {
      const cp = cachePath("reuse-null");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed
      {
        const cache1 = makeCache(cp, files);
        using s1 = await cache1.open();
        await s1.write();
      }

      // Reuse: files=null
      {
        const cache2 = makeCache(cp, null, { rootPath: FIXTURE_DIR });
        using s2 = await cache2.open();
        expect(s2.status).toBe("upToDate");
      }
    });

    it("reuses file list and reads user data", async () => {
      const cp = cachePath("reuse-cb");
      const files = [fixtureFile("a.txt")];

      // Seed with user data
      {
        const cache1 = makeCache(cp, files);
        using s1 = await cache1.open();
        await s1.write({
          userData: [Buffer.from("reuse data")],
          userValue0: 99,
        });
      }

      // Reuse
      {
        const cache2 = makeCache(cp, null, { rootPath: FIXTURE_DIR });
        using s2 = await cache2.open();
        expect(s2.status).toBe("upToDate");
        expect(s2.userValue0).toBe(99);
        expect(s2.userData.length).toBe(1);
      }
    });

    it("returns missing when no old cache exists", async () => {
      const cp = cachePath("reuse-noold");

      const cache = makeCache(cp, null, { rootPath: FIXTURE_DIR });
      using session = await cache.open();
      expect(session.status).toBe("missing");
    });

    it("detects changes when files on disk have changed", async () => {
      const cp = cachePath("reuse-changed");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed
      {
        const cache1 = makeCache(cp, files);
        using s1 = await cache1.open();
        await s1.write();
      }

      // Modify file
      writeFileSync(fixtureFile("a.txt"), "modified for reuse\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Reuse — should detect change and re-write
      {
        const cache2 = makeCache(cp, null, { rootPath: FIXTURE_DIR });
        using s2 = await cache2.open();
        expect(["changed", "stale"]).toContain(s2.status);
        await s2.write();
      }

      // After re-write, should be up to date
      {
        const cache3 = makeCache(cp, null, { rootPath: FIXTURE_DIR });
        using s3 = await cache3.open();
        expect(s3.status).toBe("upToDate");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - user data preservation (undefined = keep old)

  describe("user data preservation", () => {
    it("undefined userData keeps old user data", async () => {
      const cp = cachePath("ud-preserve");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed with user data
      {
        using s1 = await cache.open();
        await s1.write({
          userData: [Buffer.from("keep me"), Buffer.from("and me")],
          userValue0: 7,
        });
      }

      // Modify to trigger write
      writeFileSync(fixtureFile("a.txt"), "modified for ud-preserve\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Write with changed userValue but userData: undefined → preserve old
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        await s2.write({ userValue0: 77 });
      }

      // Verify both new userValue and old user data preserved
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.userValue0).toBe(77);
        expect(s3.userData.length).toBe(2);
        const item0 = s3.userData[0];
        expect(item0.toString()).toBe("keep me");
        const item1 = s3.userData[1];
        expect(item1.toString()).toBe("and me");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - context status property

  describe("session status property", () => {
    it("status is 'missing' for missing cache", async () => {
      const cp = cachePath("ctx-status-missing");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      using session = await cache.open();
      expect(session.status).toBe("missing");
    });

    it("status is 'upToDate' when nothing changed", async () => {
      const cp = cachePath("ctx-status-uptodate");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write();
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });

    it("status is 'stale' on version mismatch", async () => {
      const cp = cachePath("ctx-status-stale");
      const files = [fixtureFile("a.txt")];

      {
        const cache1 = makeCache(cp, files);
        using s1 = await cache1.open();
        await s1.write();
      }

      {
        const cache2 = makeCache(cp, files, { version: 2 });
        using s2 = await cache2.open();
        expect(s2.status).toBe("stale");
      }
    });

    it("userValue0 is accessible on session", async () => {
      const cp = cachePath("ctx-uv");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed with a user value
      {
        using s1 = await cache.open();
        await s1.write({ userValue0: 42 });
      }

      // Read back
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.userValue0).toBe(42);
      }
    });
  });

  //  - reusability

  describe("reusability", () => {
    it("multiple open calls yield consistent results", async () => {
      const cp = cachePath("reuse");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Seed
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Multiple opens on same cache should all be upToDate
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.status).toBe("upToDate");
      }
    });
  });

  //  - concurrent open calls

  describe("concurrency", () => {
    it("sequential open+write calls on same path complete without error", async () => {
      const cp = cachePath("concurrent");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // Sequential open+write calls
      for (let i = 0; i < 3; i++) {
        cache.invalidateAll();
        using session = await cache.open();
        if (session.status !== "upToDate") {
          await session.write();
        }
      }

      // Verify final state
      {
        cache.invalidateAll();
        using session = await cache.open();
        expect(session.status).toBe("upToDate");
      }
    });
  });

  //  - write with default options writes cache

  describe("write with default options", () => {
    it("write() with no options writes the cache", async () => {
      const cp = cachePath("undef-write");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      // First call — should create the cache
      {
        using s1 = await cache.open();
        expect(s1.status).toBe("missing");
        await s1.write();
      }

      // Cache should exist now
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });
  });

  //  - write with options

  describe("write with options", () => {
    it("write({ userValue0: 123 }) sets user value", async () => {
      const cp = cachePath("sync-cb");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        expect(s1.status).toBe("missing");
        await s1.write({ userValue0: 123 });
      }

      // Verify it was written
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
        expect(s2.userValue0).toBe(123);
      }
    });

    it("write() creates a valid cache", async () => {
      const cp = cachePath("sync-cb-true");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write();
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });
  });

  //  - session file accessors

  describe("session file accessors", () => {
    it("session.files returns file paths from cache", async () => {
      const cp = cachePath("ctx-files");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      {
        using s1 = await cache.open();
        await s1.write();
      }

      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.fileCount).toBe(2);
        expect(s2.files).toHaveLength(2);
        // Files are root-relative, sorted
        for (const f of s2.files) {
          expect(typeof f).toBe("string");
          expect(f.length).toBeGreaterThan(0);
        }
      }
    });

    it("session shows provided files even for missing cache", async () => {
      const cp = cachePath("ctx-files-missing");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);

      using session = await cache.open();
      expect(session.status).toBe("missing");
      // fileCount reflects the files being tracked, even for a missing cache
      expect(session.fileCount).toBe(1);
      expect(session.files).toHaveLength(1);
    });
  });

  //  - fingerprint update from write options

  describe("fingerprint update from write options", () => {
    it("updates fingerprint when write options specify one", async () => {
      const cp = cachePath("fp-update");
      const files = [fixtureFile("a.txt")];
      const fp1 = new Uint8Array(16).fill(0x11);
      const fp2 = new Uint8Array(16).fill(0x22);

      {
        const cache1 = makeCache(cp, files, { fingerprint: fp1 });
        using s1 = await cache1.open();
        await s1.write({ fingerprint: fp2 });
      }

      // Cache should be readable with fp2
      {
        const cache2 = makeCache(cp, files, { fingerprint: fp2 });
        using s2 = await cache2.open();
        expect(s2.status).toBe("upToDate");
      }

      // fp1 should be stale
      {
        const cache3 = makeCache(cp, files, { fingerprint: fp1 });
        using s3 = await cache3.open();
        expect(s3.status).toBe("stale");
      }
    });
  });

  //  - update file list preserves user data

  describe("update file list preserves user data", () => {
    it("changing files in write preserves user data when userData is undefined", async () => {
      const cp = cachePath("files-preserve-ud");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files1);

      // Seed with user data
      {
        using s1 = await cache.open();
        await s1.write({
          userData: [Buffer.from("keep this")],
          userValue0: 42,
        });
      }

      // Update file list, don't set userData → should preserve
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        await s2.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          // userData not set → preserve old
        });
      }

      // Verify both new files and old user data are present
      {
        const cache2 = makeCache(cp, files2);
        using s3 = await cache2.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userValue0).toBe(42);
        expect(s3.userData.length).toBe(1);
        const item = s3.userData[0];
        expect(item.toString()).toBe("keep this");
      }
    });

    it("changing files + userValues writes new user values", async () => {
      const cp = cachePath("files-uv");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files1);

      // Seed with userValue0=10
      {
        using s1 = await cache.open();
        await s1.write({ userValue0: 10, userValue1: 20 });
      }

      // Change files and userValues in write
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        await s2.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          userValue0: 99,
          userValue2: 77,
        });
      }

      // Verify new values written
      {
        const cache2 = makeCache(cp, files2);
        using s3 = await cache2.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userValue0).toBe(99);
        // userValue1 should be preserved from old cache (20)
        expect(s3.userValue1).toBe(20);
        expect(s3.userValue2).toBe(77);
        expect(s3.userValue3).toBe(0);
      }
    });

    it("changing files + fingerprint writes new fingerprint", async () => {
      const cp = cachePath("files-fp");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("b.txt")];
      const fp1 = new Uint8Array(16).fill(0xaa);
      const fp2 = new Uint8Array(16).fill(0xbb);

      // Seed with fp1
      {
        const cache1 = makeCache(cp, files1, { fingerprint: fp1 });
        using s1 = await cache1.open();
        await s1.write();
      }

      // Change files and fingerprint in write
      {
        const cache2 = makeCache(cp, files1, { fingerprint: fp1 });
        using s2 = await cache2.open();
        await s2.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          fingerprint: fp2,
        });
      }

      // fp2 should be up to date
      {
        const cache3 = makeCache(cp, files2, { fingerprint: fp2 });
        using s3 = await cache3.open();
        expect(s3.status).toBe("upToDate");
      }

      // fp1 should be stale
      {
        const cache4 = makeCache(cp, files2, { fingerprint: fp1 });
        using s4 = await cache4.open();
        expect(s4.status).toBe("stale");
      }
    });

    it("changing files + userData replaces user data", async () => {
      const cp = cachePath("files-ud-replace");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed with old user data
      {
        const cache1 = makeCache(cp, files1);
        using s1 = await cache1.open();
        await s1.write({ userData: [Buffer.from("old data")] });
      }

      // Change files and replace user data
      {
        const cache2 = makeCache(cp, files1);
        using s2 = await cache2.open();
        await s2.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          userData: [Buffer.from("new item 1"), Buffer.from("new item 2")],
        });
      }

      // Verify new user data written
      {
        const cache3 = makeCache(cp, files2);
        using s3 = await cache3.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userData.length).toBe(2);
        const item0 = s3.userData[0];
        expect(item0.toString()).toBe("new item 1");
        const item1 = s3.userData[1];
        expect(item1.toString()).toBe("new item 2");
      }
    });

    it("changing files + null userData clears user data", async () => {
      const cp = cachePath("files-ud-clear");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("b.txt")];

      // Seed with user data
      {
        const cache1 = makeCache(cp, files1);
        using s1 = await cache1.open();
        await s1.write({
          userData: [Buffer.from("remove me")],
          userValue0: 55,
        });
      }

      // Change files and clear user data
      {
        const cache2 = makeCache(cp, files1);
        using s2 = await cache2.open();
        await s2.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          userData: null,
        });
      }

      // Verify user data cleared but userValue preserved
      {
        const cache3 = makeCache(cp, files2);
        using s3 = await cache3.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userData.length).toBe(0);
        expect(s3.userValue0).toBe(55);
      }
    });

    it("changing files + userValues + userData + fingerprint all together", async () => {
      const cp = cachePath("files-all");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const fp1 = new Uint8Array(16).fill(0x11);
      const fp2 = new Uint8Array(16).fill(0x22);

      // Seed
      {
        const cache1 = makeCache(cp, files1, { fingerprint: fp1 });
        using s1 = await cache1.open();
        await s1.write({
          userData: [Buffer.from("old")],
          userValue0: 1,
          userValue1: 2,
        });
      }

      // Change everything at once
      {
        const cache2 = makeCache(cp, files1, { fingerprint: fp1 });
        using s2 = await cache2.open();
        await s2.write({
          files: files2,
          rootPath: FIXTURE_DIR,
          fingerprint: fp2,
          userValue0: 100,
          userValue3: 300,
          userData: [Buffer.from("alpha"), Buffer.from("beta")],
        });
      }

      // Verify all changes
      {
        const cache3 = makeCache(cp, files2, { fingerprint: fp2 });
        using s3 = await cache3.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userValue0).toBe(100);
        // userValue1 preserved from old
        expect(s3.userValue1).toBe(2);
        expect(s3.userValue2).toBe(0);
        expect(s3.userValue3).toBe(300);
        expect(s3.userData.length).toBe(2);
        const item0 = s3.userData[0];
        expect(item0.toString()).toBe("alpha");
        const item1 = s3.userData[1];
        expect(item1.toString()).toBe("beta");
      }

      // fp1 should be stale
      {
        const cache4 = makeCache(cp, files2, { fingerprint: fp1 });
        using s4 = await cache4.open();
        expect(s4.status).toBe("stale");
      }
    });
  });

  //  - Regression: stat-match results preserved through write

  describe("stat-match preservation", () => {
    it("write with same files does not re-stat entries already validated by open", async () => {
      const cp = cachePath("stat-preserve");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      // First: create cache
      {
        using s1 = await cache.open();
        expect(s1.status).toBe("missing");
        await s1.write();
      }

      // Second: open → upToDate (stat-match done), then write with same files
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
        await s2.write({ userValue0: 42 });
      }

      // Third: verify the write didn't corrupt anything
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.status).toBe("upToDate");
        expect(s3.userValue0).toBe(42);
        expect(s3.fileCount).toBe(2);
      }
    });

    it("write after open with changed file correctly hashes only changed entries", async () => {
      const cp = cachePath("stat-preserve-changed");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);

      // Create cache
      {
        using s1 = await cache.open();
        await s1.write();
      }

      // Modify one file
      writeFileSync(fixtureFile("a.txt"), "modified content\n");
      const t = new Date(Date.now() + 5000);
      utimesSync(fixtureFile("a.txt"), t, t);

      // Open detects change, write should hash only the changed file
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("changed");
        await s2.write();
      }

      // Verify cache is valid
      {
        cache.invalidateAll();
        using s3 = await cache.open();
        expect(s3.status).toBe("upToDate");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - lifecycle: disposed, close, write-closes-lock

  describe("lifecycle", () => {
    it("disposed is false after open, true after close", async () => {
      const cp = cachePath("disposed");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);
      const session = await cache.open();
      expect(session.disposed).toBe(false);
      session.close();
      expect(session.disposed).toBe(true);
    });

    it("close is idempotent — multiple calls are safe", async () => {
      const cp = cachePath("close-idem");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);
      const session = await cache.open();
      session.close();
      session.close();
      session.close();
      expect(session.disposed).toBe(true);
    });

    it("write() releases the lock and marks disposed", async () => {
      const cp = cachePath("write-closes");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);
      const session = await cache.open();
      expect(session.disposed).toBe(false);
      const ok = await session.write();
      expect(ok).toBe(true);
      expect(session.disposed).toBe(true);
    });

    it("write() throws on already-closed session", async () => {
      const cp = cachePath("write-after-close");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);
      const session = await cache.open();
      session.close();
      await expect(session.write()).rejects.toThrow("already closed");
    });

    it("write() followed by another write() throws", async () => {
      const cp = cachePath("double-write");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);
      const session = await cache.open();
      await session.write();
      await expect(session.write()).rejects.toThrow("already closed");
    });

    it("using releases the lock after write", async () => {
      const cp = cachePath("await-using-write");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);
      {
        using session = await cache.open();
        await session.write();
        // write() already released — using close() is a no-op
      }
      // Verify cache is readable
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("upToDate");
      }
    });

    it("using releases the lock without write", async () => {
      const cp = cachePath("await-using-nowrite");
      const files = [fixtureFile("a.txt")];
      const cache = makeCache(cp, files);
      {
        using session = await cache.open();
        expect(session.status).toBe("missing");
        // no write — using should still release the lock
      }
      // Verify the lock is released: can open again
      {
        cache.invalidateAll();
        using s2 = await cache.open();
        expect(s2.status).toBe("missing");
      }
    });

    it("properties are still readable after write()", async () => {
      const cp = cachePath("read-after-write");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const cache = makeCache(cp, files);
      const session = await cache.open();
      await session.write({ userValue0: 42 });
      // Properties set at construction time should still be accessible
      expect(session.fileCount).toBe(2);
      expect(session.version).toBe(1);
      expect(session.rootPath).toMatch(FIXTURE_DIR);
      expect(session.userValue0).toBe(0); // original value, not written value
      expect(session.disposed).toBe(true);
    });
  });
});
