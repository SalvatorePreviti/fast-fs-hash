import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache, FileHashCacheWasm, XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── Fixture setup ───────────────────────────────────────────────────

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-open");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

beforeAll(async () => {
  await XXHash128.init();
  await XXHash128Wasm.init();
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

// ── Tests ───────────────────────────────────────────────────────────

function makeBackends(): [string, typeof FileHashCache][] {
  return [
    ["native", FileHashCache],
    ["wasm", FileHashCacheWasm],
  ];
}

describe.each(makeBackends())("open (%s)", (_label, Cache) => {
  // ── Status return values ────────────────────────────────────────

  it("returns 'not-found' when no cache file exists", async () => {
    await using c = new Cache(FIXTURE_DIR, cachePath("no-file"));
    expect(await c.open()).toBe("not-found");
    expect(c.fileCount).toBe(0);
  });

  it("returns 'valid' and reads user values from a seeded cache", async () => {
    const cp = cachePath("seed");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    // Seed a cache with user values.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 2 });
      c.setFiles(files);
      c.userValue0 = 100;
      c.userValue1 = 200;
      c.userValue2 = 300;
      c.userValue3 = 400;
      await c.serialize();
    }

    // Open the cache.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 2 });
      expect(await c.open()).toBe("valid");
      expect(c.userValue0).toBe(100);
      expect(c.userValue1).toBe(200);
      expect(c.userValue2).toBe(300);
      expect(c.userValue3).toBe(400);
      expect(c.fileCount).toBe(2);
    }
  });

  it("sets position to start of user data section", async () => {
    const cp = cachePath("pos");
    const files = [fixtureFile("a.txt")];
    const userData = Buffer.from("my-user-data-payload");

    // Seed with user data.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
      await c.write(userData);
      c.position += userData.length;
    }

    // open() should set position to user data start.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      expect(await c.open()).toBe("valid");
      expect(c.fileCount).toBe(1);

      // Read back user data at position.
      const buf = Buffer.alloc(userData.length);
      const bytesRead = await c.read(buf);
      expect(bytesRead).toBe(userData.length);
      expect(buf.toString()).toBe("my-user-data-payload");
    }
  });

  it("returns 'stale' on version mismatch", async () => {
    const cp = cachePath("ver-mismatch");
    const files = [fixtureFile("a.txt")];

    // Seed with version 5.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 5 });
      c.setFiles(files);
      await c.serialize();
    }

    // Open with version 6 — should be stale.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 6 });
      expect(await c.open()).toBe("stale");
    }
  });

  it("returns 'stale' on fingerprint mismatch, 'valid' on match", async () => {
    const cp = cachePath("fp-mismatch");
    const files = [fixtureFile("a.txt")];
    const fp1 = new Uint8Array(16);
    fp1[0] = 1;
    const fp2 = new Uint8Array(16);
    fp2[0] = 2;

    // Seed with fp1.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1, fingerprint: fp1 });
      c.setFiles(files);
      await c.serialize();
    }

    // Open with fp2 — should be stale.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1, fingerprint: fp2 });
      expect(await c.open()).toBe("stale");
    }

    // Open with fp1 — should succeed.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1, fingerprint: fp1 });
      expect(await c.open()).toBe("valid");
    }
  });

  it("returns 'corrupt' for truncated cache file", async () => {
    const cp = cachePath("truncated");
    writeFileSync(cp, Buffer.alloc(32));

    await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
    expect(await c.open()).toBe("corrupt");
  });

  it("returns 'corrupt' for truncated body", async () => {
    const cp = cachePath("trunc-body");
    const files = [fixtureFile("a.txt")];

    // Seed a valid cache.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
    }

    // Truncate to just the header (breaking the body).
    const full = require("node:fs").readFileSync(cp);
    writeFileSync(cp, full.subarray(0, 64 + 10)); // header + partial body

    await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
    expect(await c.open()).toBe("corrupt");
  });

  // ── Error handling ──────────────────────────────────────────────

  it("throws when already disposed", async () => {
    const c = new Cache(FIXTURE_DIR, cachePath("disposed"));
    await c.dispose();
    await expect(c.open()).rejects.toThrow("disposed");
  });

  it("throws when called twice", async () => {
    const cp = cachePath("twice");
    const files = [fixtureFile("a.txt")];

    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
    }

    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      expect(await c.open()).toBe("valid");
      await expect(c.open()).rejects.toThrow("file already open");
    }
  });

  // ── Lifecycle ───────────────────────────────────────────────────

  it("dispose works after open", async () => {
    const cp = cachePath("dispose-after");
    const files = [fixtureFile("a.txt")];

    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
    }

    {
      const c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      expect(await c.open()).toBe("valid");
      await c.dispose();
      await c.dispose(); // idempotent
    }
  });

  it("read returns 0 after failed open", async () => {
    await using c = new Cache(FIXTURE_DIR, cachePath("read-miss"));
    expect(await c.open()).toBe("not-found");
    const buf = Buffer.alloc(16);
    expect(await c.read(buf)).toBe(0);
  });

  it("readv works after open", async () => {
    const cp = cachePath("readv");
    const files = [fixtureFile("a.txt")];
    const chunk1 = Buffer.from("AAAA");
    const chunk2 = Buffer.from("BBBB");

    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
      const pos = c.position;
      await c.writev([chunk1, chunk2], pos);
      c.position = pos + chunk1.length + chunk2.length;
    }

    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      expect(await c.open()).toBe("valid");
      const r1 = Buffer.alloc(4);
      const r2 = Buffer.alloc(4);
      const totalRead = await c.readv([r1, r2]);
      expect(totalRead).toBe(8);
      expect(r1.toString()).toBe("AAAA");
      expect(r2.toString()).toBe("BBBB");
    }
  });

  // ── open() + validate() integration ─────────────────────────────

  it("validate works after open (open then validate)", async () => {
    const cp = cachePath("open-validate");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    // Seed.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      c.userValue0 = 42;
      await c.serialize();
    }

    // open() → check userValue → setFiles → validate.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      expect(await c.open()).toBe("valid");
      expect(c.userValue0).toBe(42);
      c.setFiles(files);
      expect(await c.validate()).toBe(true);
    }
  });

  it("validate works without explicit open", async () => {
    const cp = cachePath("validate-only");
    const files = [fixtureFile("a.txt")];

    // Seed.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
    }

    // Just validate — should call open() internally.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      expect(await c.validate()).toBe(true);
    }
  });

  it("validate returns false after open on stale cache", async () => {
    const cp = cachePath("stale-validate");
    const files = [fixtureFile("a.txt")];

    // Seed with version 1.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 1 });
      c.setFiles(files);
      await c.serialize();
    }

    // Open with version 2 (stale), then validate.
    {
      await using c = new Cache(FIXTURE_DIR, cp, { version: 2 });
      expect(await c.open()).toBe("stale");
      c.setFiles(files);
      expect(await c.validate()).toBe(false);
    }
  });

  it("validate returns false after open on not-found", async () => {
    await using c = new Cache(FIXTURE_DIR, cachePath("nf-validate"));
    expect(await c.open()).toBe("not-found");
    c.setFiles([fixtureFile("a.txt")]);
    expect(await c.validate()).toBe(false);
  });
});
