import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-write-new");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
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

describe("FileHashCache.writeNew [native]", () => {
  //  - basic functionality

  describe("basic", () => {
    it("creates a cache file from scratch", async () => {
      const cp = cachePath("basic");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      const ok = await FileHashCache.writeNew(cp, FIXTURE_DIR, files);
      expect(ok).toBe(true);

      // Verify the cache is valid
      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(2);
      }
    });

    it("returns true on success", async () => {
      const cp = cachePath("ret-true");
      const files = [fixtureFile("a.txt")];

      const ok = await FileHashCache.writeNew(cp, FIXTURE_DIR, files);
      expect(ok).toBe(true);
    });

    it("creates cache with single file", async () => {
      const cp = cachePath("single");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(1);
      }
    });

    it("creates cache with three files", async () => {
      const cp = cachePath("three");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(3);
      }
    });

    it("creates cache with empty file list", async () => {
      const cp = cachePath("empty");

      await FileHashCache.writeNew(cp, FIXTURE_DIR, []);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, [], 0);
        expect(["upToDate", "missing"]).toContain(ctx.status);
      }
    });
  });

  //  - version and fingerprint

  describe("version and fingerprint", () => {
    it("sets version", async () => {
      const cp = cachePath("ver");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, { version: 42 });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 42);
        expect(ctx.status).toBe("upToDate");
      }

      // Different version → stale
      {
        await using ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 99);
        expect(ctx2.status).toBe("stale");
      }
    });

    it("sets fingerprint", async () => {
      const cp = cachePath("fp");
      const files = [fixtureFile("a.txt")];
      const fp = new Uint8Array(16).fill(0xaa);

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, { fingerprint: fp });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0, fp);
        expect(ctx.status).toBe("upToDate");
      }

      // Different fingerprint → stale
      const fp2 = new Uint8Array(16).fill(0xbb);
      {
        await using ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 0, fp2);
        expect(ctx2.status).toBe("stale");
      }
    });

    it("fingerprint must be 16 bytes", async () => {
      const cp = cachePath("fp-bad");
      const files = [fixtureFile("a.txt")];

      await expect(FileHashCache.writeNew(cp, FIXTURE_DIR, files, { fingerprint: new Uint8Array(8) })).rejects.toThrow(
        "16 bytes"
      );
    });
  });

  //  - user values

  describe("user values", () => {
    it("writes user values", async () => {
      const cp = cachePath("uv");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        userValue0: 10,
        userValue1: 20,
        userValue2: 30,
        userValue3: 40,
      });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.userValue0).toBe(10);
        expect(ctx.userValue1).toBe(20);
        expect(ctx.userValue2).toBe(30);
        expect(ctx.userValue3).toBe(40);
      }
    });

    it("user values default to 0", async () => {
      const cp = cachePath("uv-default");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.userValue0).toBe(0);
        expect(ctx.userValue1).toBe(0);
        expect(ctx.userValue2).toBe(0);
        expect(ctx.userValue3).toBe(0);
      }
    });
  });

  //  - user data

  describe("user data", () => {
    it("writes single userData item", async () => {
      const cp = cachePath("ud-single");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        userData: [Buffer.from("test payload")],
      });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.userData.length).toBe(1);
        expect(ctx.userData[0].toString()).toBe("test payload");
      }
    });

    it("writes multiple userData items", async () => {
      const cp = cachePath("ud-multi");
      const files = [fixtureFile("a.txt")];
      const items = [Buffer.from("first"), Buffer.from("second item"), Buffer.from("third")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, { userData: items });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.userData.length).toBe(3);
        for (let i = 0; i < 3; i++) {
          expect(ctx.userData[i].toString()).toBe(items[i].toString());
        }
      }
    });

    it("null userData produces no user data items", async () => {
      const cp = cachePath("ud-null");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, { userData: null });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.userData.length).toBe(0);
      }
    });

    it("handles UTF-8 multi-byte content", async () => {
      const cp = cachePath("ud-utf8");
      const files = [fixtureFile("a.txt")];
      const utf8Str = "日本語テスト 🚀 émojis";

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        userData: [Buffer.from(utf8Str)],
      });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.userData[0].toString("utf8")).toBe(utf8Str);
      }
    });

    it("handles empty buffer items", async () => {
      const cp = cachePath("ud-empty-buf");
      const files = [fixtureFile("a.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        userData: [Buffer.alloc(0), Buffer.from("non-empty"), Buffer.alloc(0)],
      });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.userData.length).toBe(3);
        expect(ctx.userData[0].length).toBe(0);
        expect(ctx.userData[1].toString()).toBe("non-empty");
        expect(ctx.userData[2].length).toBe(0);
      }
    });
  });

  //  - overwrite existing cache

  describe("overwrite", () => {
    it("overwrites an existing cache file", async () => {
      const cp = cachePath("overwrite");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Seed via open+write with userValue
      {
        await using ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
        await ctx1.write({ userValue0: 42, userData: [Buffer.from("old")] });
      }

      // Overwrite via writeNew with different options
      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        version: 2,
        userValue0: 99,
        userData: [Buffer.from("new")],
      });

      {
        await using ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 2);
        expect(ctx2.status).toBe("upToDate");
        expect(ctx2.userValue0).toBe(99);
        expect(ctx2.userData.length).toBe(1);
        expect(ctx2.userData[0].toString()).toBe("new");
      }

      // Old version → stale
      {
        await using ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
        expect(ctx3.status).toBe("stale");
      }
    });

    it("overwrites with different file list", async () => {
      const cp = cachePath("overwrite-files");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      // Seed with files1
      {
        await using ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files1, 1);
        await ctx1.write();
      }

      // Overwrite with files2
      await FileHashCache.writeNew(cp, FIXTURE_DIR, files2, { version: 1 });

      {
        await using ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files2, 1);
        expect(ctx2.status).toBe("upToDate");
        expect(ctx2.fileCount).toBe(3);
      }
    });
  });

  //  - all options together

  describe("all options", () => {
    it("sets version, fingerprint, user values, and user data together", async () => {
      const cp = cachePath("all");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
      const fp = new Uint8Array(16).fill(0x42);

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        version: 7,
        fingerprint: fp,
        userValue0: 100,
        userValue1: 200,
        userValue2: 300,
        userValue3: 400,
        userData: [Buffer.from("alpha"), Buffer.from("beta")],
      });

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 7, fp);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(2);
        expect(ctx.userValue0).toBe(100);
        expect(ctx.userValue1).toBe(200);
        expect(ctx.userValue2).toBe(300);
        expect(ctx.userValue3).toBe(400);
        expect(ctx.userData.length).toBe(2);
        expect(ctx.userData[0].toString()).toBe("alpha");
        expect(ctx.userData[1].toString()).toBe("beta");
      }
    });
  });

  //  - detects changes after writeNew

  describe("change detection after writeNew", () => {
    it("detects file changes after writeNew", async () => {
      const cp = cachePath("detect-change");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      // Modify a file
      writeFileSync(fixtureFile("a.txt"), "modified for detect\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("changed");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("open → upToDate → modify → open → changed → writeNew → open → upToDate", async () => {
      const cp = cachePath("full-cycle");
      const files = [fixtureFile("a.txt")];

      // Initial writeNew
      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      {
        await using ctx1 = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx1.status).toBe("upToDate");
      }

      // Modify
      writeFileSync(fixtureFile("a.txt"), "modified for full-cycle\n");
      const t = new Date(Date.now() + 3000);
      utimesSync(fixtureFile("a.txt"), t, t);

      {
        await using ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx2.status).toBe("changed");
      }

      // Re-create via writeNew
      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      {
        await using ctx3 = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx3.status).toBe("upToDate");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - can be used as initialization before open

  describe("initialization pattern", () => {
    it("writeNew followed by open+write cycle works correctly", async () => {
      const cp = cachePath("init-pattern");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Initialize via writeNew
      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
        version: 1,
        userData: [Buffer.from("initial data")],
      });

      // Open and validate
      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.userData[0].toString()).toBe("initial data");

        // Update userData via instance write
        await ctx.write({ userData: [Buffer.from("updated data")] });
      }

      // Verify the update persisted
      {
        await using ctx2 = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
        expect(ctx2.status).toBe("upToDate");
        expect(ctx2.userData[0].toString()).toBe("updated data");
      }
    });
  });

  //  - sequential calls

  describe("sequential writes", () => {
    it("multiple sequential writeNew calls on same path succeed", async () => {
      const cp = cachePath("seq");
      const files = [fixtureFile("a.txt")];

      for (let i = 0; i < 3; i++) {
        const ok = await FileHashCache.writeNew(cp, FIXTURE_DIR, files, {
          userValue0: i,
        });
        expect(ok).toBe(true);
      }

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.userValue0).toBe(2); // last write wins
      }
    });
  });

  //  - files accessor on open after writeNew

  describe("files accessor", () => {
    it("files are readable after writeNew + open", async () => {
      const cp = cachePath("files-acc");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.files).toHaveLength(2);
        for (const f of ctx.files) {
          expect(typeof f).toBe("string");
          expect(f.length).toBeGreaterThan(0);
        }
      }
    });

    it("reuse mode works after writeNew", async () => {
      const cp = cachePath("reuse-after");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await FileHashCache.writeNew(cp, FIXTURE_DIR, files, { version: 1 });

      // Reuse: files=null
      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, null, 1);
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(2);
      }
    });
  });

  //  - creates parent directories

  describe("directory creation", () => {
    it("creates parent directories if they don't exist", async () => {
      const cp = path.join(CACHE_DIR, "nested", "deep", `wn-mkdir-${++cacheCounter}.cache`);
      const files = [fixtureFile("a.txt")];

      const ok = await FileHashCache.writeNew(cp, FIXTURE_DIR, files);
      expect(ok).toBe(true);

      {
        await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
        expect(ctx.status).toBe("upToDate");
      }
    });
  });
});
