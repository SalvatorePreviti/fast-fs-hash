import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache, XXHash128 } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-setfiles-rootpath");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const SUB_DIR = path.join(FIXTURE_DIR, "sub");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

beforeAll(async () => {
  await XXHash128.init();
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SUB_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  // Fixture layout:
  //   fixtures/a.txt
  //   fixtures/b.txt
  //   fixtures/sub/c.txt
  //   fixtures/sub/d.txt
  writeFileSync(path.join(FIXTURE_DIR, "a.txt"), "aaa\n");
  writeFileSync(path.join(FIXTURE_DIR, "b.txt"), "bbb\n");
  writeFileSync(path.join(SUB_DIR, "c.txt"), "ccc\n");
  writeFileSync(path.join(SUB_DIR, "d.txt"), "ddd\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

//  - Tests

describe("FileHashCache", () => {
  // ── setFiles after post-validate remap throws ─────────────────────

  describe("setFiles after post-validate remap throws", () => {
    it("throws when calling setFiles a second time after remap", async () => {
      const cp = cachePath("double-remap");
      const a = path.join(FIXTURE_DIR, "a.txt");
      const b = path.join(FIXTURE_DIR, "b.txt");

      // Seed with [a, b].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        await c.serialize();
      }

      // Validate, remap to [a], then try to remap again — should throw.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        expect(await c.validate()).toBe(true);

        // First post-validate setFiles — triggers remap, should succeed.
        c.setFiles([a]);
        expect(c.currentFiles).toEqual(["a.txt"]);

        // Second post-validate setFiles — should throw.
        expect(() => c.setFiles([b])).toThrow("cannot be called again after a post-validate remap");
      }
    });

    it("does not throw when setFiles same list after remap", async () => {
      const cp = cachePath("same-after-remap");
      const a = path.join(FIXTURE_DIR, "a.txt");
      const b = path.join(FIXTURE_DIR, "b.txt");

      // Seed with [a, b].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        await c.serialize();
      }

      // Validate, remap to [a], then try same list — still throws because
      // _remapped is already set (the same-list fast path is checked AFTER
      // the remap guard, but the remap guard fires first).
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([a, b]);
        expect(await c.validate()).toBe(true);

        c.setFiles([a]); // triggers remap

        // Even with same list [a], _remapped is true → throws.
        expect(() => c.setFiles([a])).toThrow("cannot be called again after a post-validate remap");
      }
    });
  });

  // ── setFiles with rootPath parameter ──────────────────────────────

  describe("setFiles with rootPath change", () => {
    it("updates rootPath getter when rootPath parameter is provided", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath("rootpath-getter"), {
        version: 1,
      });
      expect(c.rootPath).toBe(FIXTURE_DIR);

      c.setFiles([path.join(SUB_DIR, "c.txt")], SUB_DIR);
      expect(c.rootPath).toBe(SUB_DIR);
      expect(c.currentFiles).toEqual(["c.txt"]);
    });

    it("does not update rootPath when resolved path is the same", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath("rootpath-same"), {
        version: 1,
      });
      // Trailing slash or `.` should resolve to the same path.
      c.setFiles(["a.txt"], `${FIXTURE_DIR}/.`);
      expect(c.rootPath).toBe(FIXTURE_DIR);
    });

    it("normalizes files relative to new rootPath", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath("rootpath-normalize"), {
        version: 1,
      });
      // Files are absolute paths under SUB_DIR — root changes to SUB_DIR.
      c.setFiles([path.join(SUB_DIR, "c.txt"), path.join(SUB_DIR, "d.txt")], SUB_DIR);
      expect(c.currentFiles).toEqual(["c.txt", "d.txt"]);
    });

    it("drops files outside the new root", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath("rootpath-drop"), {
        version: 1,
      });
      // Root changes to SUB_DIR — a.txt is in FIXTURE_DIR, outside SUB_DIR.
      c.setFiles([path.join(FIXTURE_DIR, "a.txt"), path.join(SUB_DIR, "c.txt")], SUB_DIR);
      expect(c.currentFiles).toEqual(["c.txt"]);
      expect(c.fileCount).toBe(1);
    });

    it("cold serialize with rootPath change produces valid cache", async () => {
      const cp = cachePath("rootpath-cold");

      // Cold write under SUB_DIR.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([path.join(SUB_DIR, "c.txt"), path.join(SUB_DIR, "d.txt")], SUB_DIR);
        expect(c.rootPath).toBe(SUB_DIR);
        await c.serialize();
      }

      // Re-open under SUB_DIR, validate.
      {
        await using c = new FileHashCache(SUB_DIR, cp, { version: 1 });
        c.setFiles(["c.txt", "d.txt"]);
        expect(await c.validate()).toBe(true);
        expect(c.currentFiles).toEqual(["c.txt", "d.txt"]);
      }
    });
  });

  // ── Post-validate remap with rootPath change ─────────────────────

  describe("post-validate remap with rootPath change", () => {
    it("preserves entries for files surviving root change", async () => {
      const cp = cachePath("remap-root-survive");
      const cFile = path.join(SUB_DIR, "c.txt");
      const dFile = path.join(SUB_DIR, "d.txt");

      // Seed cache under FIXTURE_DIR with [sub/c.txt, sub/d.txt].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([cFile, dFile]);
        expect(c.currentFiles).toEqual(["sub/c.txt", "sub/d.txt"]);
        await c.serialize();
      }

      // Validate under FIXTURE_DIR, then setFiles with rootPath = SUB_DIR.
      // sub/c.txt and sub/d.txt under FIXTURE_DIR become c.txt and d.txt under SUB_DIR.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([cFile, dFile]);
        expect(await c.validate()).toBe(true);

        // Remap: change root to SUB_DIR.
        c.setFiles([cFile, dFile], SUB_DIR);
        expect(c.rootPath).toBe(SUB_DIR);
        expect(c.currentFiles).toEqual(["c.txt", "d.txt"]);

        // Complete — entries should have survived the remap as F_HAS_OLD,
        // re-stat matches → not changed.
        await c.complete();
        expect(c.getChangedFiles()).toEqual([]);
        await c.serialize();
      }

      // Verify the re-written cache is valid under SUB_DIR.
      {
        await using c = new FileHashCache(SUB_DIR, cp, { version: 1 });
        c.setFiles(["c.txt", "d.txt"]);
        expect(await c.validate()).toBe(true);
      }
    });

    it("drops entries for files outside new root", async () => {
      const cp = cachePath("remap-root-drop");
      const aFile = path.join(FIXTURE_DIR, "a.txt");
      const cFile = path.join(SUB_DIR, "c.txt");

      // Seed under FIXTURE_DIR with [a.txt, sub/c.txt].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([aFile, cFile]);
        await c.serialize();
      }

      // Validate, then remap to SUB_DIR — a.txt is outside SUB_DIR, dropped.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([aFile, cFile]);
        expect(await c.validate()).toBe(true);

        c.setFiles([cFile], SUB_DIR);
        expect(c.rootPath).toBe(SUB_DIR);
        expect(c.currentFiles).toEqual(["c.txt"]);

        await c.complete();
        // c.txt survived remap, stat matches → not changed.
        expect(c.getChangedFiles()).toEqual([]);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(SUB_DIR, cp, { version: 1 });
        c.setFiles(["c.txt"]);
        expect(await c.validate()).toBe(true);
      }
    });

    it("remap with root change to parent preserves all files", async () => {
      const cp = cachePath("remap-root-parent");
      const cFile = path.join(SUB_DIR, "c.txt");
      const dFile = path.join(SUB_DIR, "d.txt");

      // Seed under SUB_DIR with [c.txt, d.txt].
      {
        await using c = new FileHashCache(SUB_DIR, cp, { version: 1 });
        c.setFiles([cFile, dFile]);
        await c.serialize();
      }

      // Validate under SUB_DIR, then remap root to FIXTURE_DIR (parent).
      // c.txt → sub/c.txt, d.txt → sub/d.txt — all survive.
      {
        await using c = new FileHashCache(SUB_DIR, cp, { version: 1 });
        c.setFiles([cFile, dFile]);
        expect(await c.validate()).toBe(true);

        c.setFiles([cFile, dFile], FIXTURE_DIR);
        expect(c.rootPath).toBe(FIXTURE_DIR);
        expect(c.currentFiles).toEqual(["sub/c.txt", "sub/d.txt"]);

        await c.complete();
        expect(c.getChangedFiles()).toEqual([]);
        await c.serialize();
      }

      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles(["sub/c.txt", "sub/d.txt"]);
        expect(await c.validate()).toBe(true);
      }
    });

    it("remap with root change adds new files as changed", async () => {
      const cp = cachePath("remap-root-new");
      const cFile = path.join(SUB_DIR, "c.txt");

      // Seed with [sub/c.txt] under FIXTURE_DIR.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([cFile]);
        await c.serialize();
      }

      // Validate, remap to SUB_DIR, add d.txt.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([cFile]);
        expect(await c.validate()).toBe(true);

        c.setFiles([cFile, path.join(SUB_DIR, "d.txt")], SUB_DIR);
        expect(c.currentFiles).toEqual(["c.txt", "d.txt"]);

        await c.complete();
        // c.txt survived remap, d.txt is new → changed.
        expect(c.getChangedFiles()).toEqual(["d.txt"]);
      }
    });
  });

  // ── oldFiles getter explicit verification ─────────────────────────

  describe("oldFiles", () => {
    it("returns previous cache list when setFiles was called before validate", async () => {
      const cp = cachePath("oldfiles-with-setfiles");
      const aFile = path.join(FIXTURE_DIR, "a.txt");
      const bFile = path.join(FIXTURE_DIR, "b.txt");

      // Seed cache with [a, b].
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([aFile, bFile]);
        await c.serialize();
      }

      // Re-open, setFiles with [a] only, then validate.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([aFile]); // different list from cache
        await c.validate();

        // currentFiles should be the setFiles list.
        expect(c.currentFiles).toEqual(["a.txt"]);
        // oldFiles should be the previous cache's list.
        expect(c.oldFiles).toEqual(["a.txt", "b.txt"]);
      }
    });

    it("returns [] before validate", async () => {
      await using c = new FileHashCache(FIXTURE_DIR, cachePath("oldfiles-before-validate"), {
        version: 1,
      });
      expect(c.oldFiles).toEqual([]);
    });

    it("returns same list as currentFiles when no setFiles before validate", async () => {
      const cp = cachePath("oldfiles-no-setfiles");
      const aFile = path.join(FIXTURE_DIR, "a.txt");

      // Seed.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        c.setFiles([aFile]);
        await c.serialize();
      }

      // Validate without setFiles — file list comes from cache.
      {
        await using c = new FileHashCache(FIXTURE_DIR, cp, { version: 1 });
        await c.validate();
        expect(c.currentFiles).toEqual(["a.txt"]);
        expect(c.oldFiles).toEqual(["a.txt"]);
        // Same reference since currentFiles falls through to oldFiles.
        expect(c.currentFiles).toBe(c.oldFiles);
      }
    });
  });
});
