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

describe("FileHashCache.overwrite [native]", () => {
  //  - basic functionality

  describe("basic", () => {
    it("creates a cache file from scratch", async () => {
      const cp = cachePath("basic");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      const ok = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();
      expect(ok).toBe(true);

      // Verify the cache is valid
      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(2);
      }
    });

    it("returns true on success", async () => {
      const cp = cachePath("ret-true");
      const files = [fixtureFile("a.txt")];

      const ok = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();
      expect(ok).toBe(true);
    });

    it("creates cache with single file", async () => {
      const cp = cachePath("single");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(1);
      }
    });

    it("creates cache with three files", async () => {
      const cp = cachePath("three");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(3);
      }
    });

    it("creates cache with empty file list", async () => {
      const cp = cachePath("empty");

      await new FileHashCache({ cachePath: cp, files: [], rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx = await new FileHashCache({ cachePath: cp, files: [], rootPath: FIXTURE_DIR }).open();
        expect(["upToDate", "missing"]).toContain(ctx.status);
      }
    });
  });

  //  - version and fingerprint

  describe("version and fingerprint", () => {
    it("sets version", async () => {
      const cp = cachePath("ver");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 42 }).overwrite();

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 42 }).open();
        expect(ctx.status).toBe("upToDate");
      }

      // Different version → stale
      {
        using ctx2 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 99 }).open();
        expect(ctx2.status).toBe("stale");
      }
    });

    it("sets fingerprint", async () => {
      const cp = cachePath("fp");
      const files = [fixtureFile("a.txt")];
      const fp = new Uint8Array(16).fill(0xaa);

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, fingerprint: fp }).overwrite();

      {
        using ctx = await new FileHashCache({
          cachePath: cp,
          files,
          rootPath: FIXTURE_DIR,
          fingerprint: fp,
        }).open();
        expect(ctx.status).toBe("upToDate");
      }

      // Different fingerprint → stale
      const fp2 = new Uint8Array(16).fill(0xbb);
      {
        using ctx2 = await new FileHashCache({
          cachePath: cp,
          files,
          rootPath: FIXTURE_DIR,
          fingerprint: fp2,
        }).open();
        expect(ctx2.status).toBe("stale");
      }
    });

    it("fingerprint must be 16 bytes", () => {
      const cp = cachePath("fp-bad");
      const files = [fixtureFile("a.txt")];

      expect(
        () => new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, fingerprint: new Uint8Array(8) })
      ).toThrow("16 bytes");
    });
  });

  //  - user values

  describe("user values", () => {
    it("writes user values", async () => {
      const cp = cachePath("uv");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
        payloadValue0: 10,
        payloadValue1: 20,
        payloadValue2: 30,
        payloadValue3: 40,
      });

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.payloadValue0).toBe(10);
        expect(ctx.payloadValue1).toBe(20);
        expect(ctx.payloadValue2).toBe(30);
        expect(ctx.payloadValue3).toBe(40);
      }
    });

    it("user values default to 0", async () => {
      const cp = cachePath("uv-default");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.payloadValue0).toBe(0);
        expect(ctx.payloadValue1).toBe(0);
        expect(ctx.payloadValue2).toBe(0);
        expect(ctx.payloadValue3).toBe(0);
      }
    });
  });

  //  - user data

  describe("user data", () => {
    it("writes single payloadData item", async () => {
      const cp = cachePath("ud-single");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
        payloadData: [Buffer.from("test payload")],
      });

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.payloadData.length).toBe(1);
        expect(ctx.payloadData[0].toString()).toBe("test payload");
      }
    });

    it("writes multiple payloadData items", async () => {
      const cp = cachePath("ud-multi");
      const files = [fixtureFile("a.txt")];
      const items = [Buffer.from("first"), Buffer.from("second item"), Buffer.from("third")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({ payloadData: items });

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.payloadData.length).toBe(3);
        for (let i = 0; i < 3; i++) {
          expect(ctx.payloadData[i].toString()).toBe(items[i].toString());
        }
      }
    });

    it("null payloadData produces no user data items", async () => {
      const cp = cachePath("ud-null");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({ payloadData: null });

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.payloadData.length).toBe(0);
      }
    });

    it("handles UTF-8 multi-byte content", async () => {
      const cp = cachePath("ud-utf8");
      const files = [fixtureFile("a.txt")];
      const utf8Str = "日本語テスト 🚀 émojis";

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
        payloadData: [Buffer.from(utf8Str)],
      });

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.payloadData[0].toString("utf8")).toBe(utf8Str);
      }
    });

    it("handles empty buffer items", async () => {
      const cp = cachePath("ud-empty-buf");
      const files = [fixtureFile("a.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
        payloadData: [Buffer.alloc(0), Buffer.from("non-empty"), Buffer.alloc(0)],
      });

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.payloadData.length).toBe(3);
        expect(ctx.payloadData[0].length).toBe(0);
        expect(ctx.payloadData[1].toString()).toBe("non-empty");
        expect(ctx.payloadData[2].length).toBe(0);
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
        using ctx1 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
        await ctx1.write({ payloadValue0: 42, payloadData: [Buffer.from("old")] });
      }

      // Overwrite via overwrite with different options
      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 2 }).overwrite({
        payloadValue0: 99,
        payloadData: [Buffer.from("new")],
      });

      {
        using ctx2 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 2 }).open();
        expect(ctx2.status).toBe("upToDate");
        expect(ctx2.payloadValue0).toBe(99);
        expect(ctx2.payloadData.length).toBe(1);
        expect(ctx2.payloadData[0].toString()).toBe("new");
      }

      // Old version → stale
      {
        using ctx3 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
        expect(ctx3.status).toBe("stale");
      }
    });

    it("overwrites with different file list", async () => {
      const cp = cachePath("overwrite-files");
      const files1 = [fixtureFile("a.txt")];
      const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

      // Seed with files1
      {
        using ctx1 = await new FileHashCache({
          cachePath: cp,
          files: files1,
          rootPath: FIXTURE_DIR,
          version: 1,
        }).open();
        await ctx1.write();
      }

      // Overwrite with files2
      await new FileHashCache({ cachePath: cp, files: files2, rootPath: FIXTURE_DIR, version: 1 }).overwrite();

      {
        using ctx2 = await new FileHashCache({
          cachePath: cp,
          files: files2,
          rootPath: FIXTURE_DIR,
          version: 1,
        }).open();
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

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 7, fingerprint: fp }).overwrite({
        payloadValue0: 100,
        payloadValue1: 200,
        payloadValue2: 300,
        payloadValue3: 400,
        payloadData: [Buffer.from("alpha"), Buffer.from("beta")],
      });

      {
        using ctx = await new FileHashCache({
          cachePath: cp,
          files,
          rootPath: FIXTURE_DIR,
          version: 7,
          fingerprint: fp,
        }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.fileCount).toBe(2);
        expect(ctx.payloadValue0).toBe(100);
        expect(ctx.payloadValue1).toBe(200);
        expect(ctx.payloadValue2).toBe(300);
        expect(ctx.payloadValue3).toBe(400);
        expect(ctx.payloadData.length).toBe(2);
        expect(ctx.payloadData[0].toString()).toBe("alpha");
        expect(ctx.payloadData[1].toString()).toBe("beta");
      }
    });
  });

  //  - detects changes after overwrite

  describe("change detection after overwrite", () => {
    it("detects file changes after overwrite", async () => {
      const cp = cachePath("detect-change");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      // Modify a file
      writeFileSync(fixtureFile("a.txt"), "modified for detect\n");
      const t = new Date(Date.now() + 2000);
      utimesSync(fixtureFile("a.txt"), t, t);

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("changed");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });

    it("open → upToDate → modify → open → changed → overwrite → open → upToDate", async () => {
      const cp = cachePath("full-cycle");
      const files = [fixtureFile("a.txt")];

      // Initial overwrite
      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx1 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx1.status).toBe("upToDate");
      }

      // Modify
      writeFileSync(fixtureFile("a.txt"), "modified for full-cycle\n");
      const t = new Date(Date.now() + 3000);
      utimesSync(fixtureFile("a.txt"), t, t);

      {
        using ctx2 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx2.status).toBe("changed");
      }

      // Re-create via overwrite
      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx3 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx3.status).toBe("upToDate");
      }

      // Restore
      writeFileSync(fixtureFile("a.txt"), "hello world\n");
    });
  });

  //  - can be used as initialization before open

  describe("initialization pattern", () => {
    it("overwrite followed by open+write cycle works correctly", async () => {
      const cp = cachePath("init-pattern");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      // Initialize via overwrite
      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).overwrite({
        payloadData: [Buffer.from("initial data")],
      });

      // Open and validate
      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.payloadData[0].toString()).toBe("initial data");

        // Update payloadData via instance write
        await ctx.write({ payloadData: [Buffer.from("updated data")] });
      }

      // Verify the update persisted
      {
        using ctx2 = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
        expect(ctx2.status).toBe("upToDate");
        expect(ctx2.payloadData[0].toString()).toBe("updated data");
      }
    });
  });

  //  - sequential calls

  describe("sequential overwrites", () => {
    it("multiple sequential overwrite calls on same path succeed", async () => {
      const cp = cachePath("seq");
      const files = [fixtureFile("a.txt")];

      for (let i = 0; i < 3; i++) {
        const ok = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
          payloadValue0: i,
        });
        expect(ok).toBe(true);
      }

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
        expect(ctx.payloadValue0).toBe(2); // last write wins
      }
    });
  });

  //  - files accessor on open after overwrite

  describe("files accessor", () => {
    it("files are readable after overwrite + open", async () => {
      const cp = cachePath("files-acc");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.files).toHaveLength(2);
        for (const f of ctx.files) {
          expect(typeof f).toBe("string");
          expect(f.length).toBeGreaterThan(0);
        }
      }
    });

    it("reuse mode works after overwrite", async () => {
      const cp = cachePath("reuse-after");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

      await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).overwrite();

      // Reuse: files=null
      {
        using ctx = await new FileHashCache({
          cachePath: cp,
          files: null,
          rootPath: FIXTURE_DIR,
          version: 1,
        }).open();
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

      const ok = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();
      expect(ok).toBe(true);

      {
        using ctx = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).open();
        expect(ctx.status).toBe("upToDate");
      }
    });
  });
});
