/** Tests: read-time format mismatches and stale-flavor scenarios must produce
 *  a sensible CacheStatus, never throw. */

import { writeFileSync } from "node:fs";
import { FileHashCache } from "fast-fs-hash";
import { beforeAll, describe, expect, it } from "vitest";
import { setupCacheTestDir } from "./_fixture-utils";

const { FIXTURE_DIR, cachePath: cp, fixtureFile: fx } = setupCacheTestDir("fhc-format-mismatch");

beforeAll(() => {
  writeFileSync(fx("a.txt"), "aaa\n");
  writeFileSync(fx("b.txt"), "bbb\n");
  writeFileSync(fx("c.txt"), "ccc\n");
});

describe("stale flavors", () => {
  it("fingerprint mismatch → 'stale' (payloads remain readable)", async () => {
    const cacheFile = cp("fp-stale");
    const files = [fx("a.txt")];
    const fp1 = Buffer.alloc(16, 1);
    const fp2 = Buffer.alloc(16, 2);

    // Seed
    const c1 = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, fingerprint: fp1 });
    using s1 = await c1.open();
    await s1.write({ payloadValue0: 42, compressedPayloads: [Buffer.from("payload-fp1")] });

    // Re-open with different fingerprint
    const c2 = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, fingerprint: fp2 });
    using s2 = await c2.open();
    expect(s2.status).toBe("stale");
    expect(s2.payloadValue0).toBe(42);
    expect(Buffer.from(s2.compressedPayloads[0]).toString()).toBe("payload-fp1");
  });

  it("version mismatch → 'staleVersion' (payloads remain readable, diskVersion exposed)", async () => {
    const cacheFile = cp("ver-stale");
    const files = [fx("a.txt")];

    // Seed at version 5
    const c1 = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 5 });
    using s1 = await c1.open();
    await s1.write({ payloadValue0: 99, compressedPayloads: [Buffer.from("payload-v5")] });

    // Re-open at version 7
    const c2 = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 7 });
    using s2 = await c2.open();
    expect(s2.status).toBe("staleVersion");
    expect(s2.version).toBe(7);
    expect(s2.diskVersion).toBe(5);
    expect(s2.payloadValue0).toBe(99);
    expect(Buffer.from(s2.compressedPayloads[0]).toString()).toBe("payload-v5");
  });

  it("writing on a staleVersion session promotes the disk file to the new version", async () => {
    const cacheFile = cp("ver-migrate");
    const files = [fx("a.txt")];

    // Seed at version 1
    {
      const c = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 1 });
      using s = await c.open();
      await s.write({ payloadValue0: 1, compressedPayloads: [Buffer.from("v1-data")] });
    }

    // Read at version 2 → staleVersion → migrate + write at version 2
    {
      const c = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 2 });
      using s = await c.open();
      expect(s.status).toBe("staleVersion");
      expect(s.diskVersion).toBe(1);
      // (Migration would parse s.compressedPayloads[0] and rewrite it.)
      await s.write({ payloadValue0: 2, compressedPayloads: [Buffer.from("v2-data")] });
    }

    // Re-open at version 2 → upToDate
    {
      const c = new FileHashCache({ cachePath: cacheFile, files, rootPath: FIXTURE_DIR, version: 2 });
      using s = await c.open();
      expect(s.status).toBe("upToDate");
      expect(s.diskVersion).toBe(2);
      expect(Buffer.from(s.compressedPayloads[0]).toString()).toBe("v2-data");
    }
  });
});

describe("file-count mismatch on stale", () => {
  // Regression: when the caller's `files` list size differs from what
  // was on disk AND the cache is stale, the native side must surface
  // a dataBuf sized for the caller's count — not the disk's smaller
  // count — or `session.resolve()` would read past the buffer end
  // when constructing `FileHashCacheEntries`.

  it("staleVersion with MORE files than on disk does not crash on resolve()", async () => {
    const cacheFile = cp("fc-grow-ver");
    // Seed with 1 file at version 1
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt")],
        rootPath: FIXTURE_DIR,
        version: 1,
      });
      using s = await c.open();
      await s.write();
    }
    // Open with 3 files at version 2 — exactly the precooked benchmark crash.
    const c2 = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt"), fx("b.txt"), fx("c.txt")],
      rootPath: FIXTURE_DIR,
      version: 2,
    });
    using s2 = await c2.open();
    expect(s2.status).toBe("staleVersion");
    expect(s2.files.length).toBe(3);
    // Must not throw.
    const entries = await s2.resolve();
    expect(entries.length).toBe(3);
  });

  it("staleVersion with FEWER files than on disk does not crash on resolve()", async () => {
    const cacheFile = cp("fc-shrink-ver");
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt"), fx("b.txt"), fx("c.txt")],
        rootPath: FIXTURE_DIR,
        version: 1,
      });
      using s = await c.open();
      await s.write();
    }
    const c2 = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt")],
      rootPath: FIXTURE_DIR,
      version: 2,
    });
    using s2 = await c2.open();
    expect(s2.status).toBe("staleVersion");
    const entries = await s2.resolve();
    expect(entries.length).toBe(1);
  });

  it("stale (fingerprint) with file count mismatch does not crash on resolve()", async () => {
    const cacheFile = cp("fc-grow-fp");
    const fp1 = Buffer.alloc(16, 1);
    const fp2 = Buffer.alloc(16, 2);
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt")],
        rootPath: FIXTURE_DIR,
        fingerprint: fp1,
      });
      using s = await c.open();
      await s.write();
    }
    const c2 = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt"), fx("b.txt"), fx("c.txt")],
      rootPath: FIXTURE_DIR,
      fingerprint: fp2,
    });
    using s2 = await c2.open();
    expect(s2.status).toBe("stale");
    const entries = await s2.resolve();
    expect(entries.length).toBe(3);
  });
});

describe("malformed disk files → 'missing'", () => {
  // Every read-time failure that means the file is unreadable or
  // structurally inconsistent must produce status 'missing', never throw.
  // Tests write arbitrary bytes directly to disk to construct each shape.

  async function openWithCorruptCache(cacheFile: string, raw: Buffer): Promise<string> {
    writeFileSync(cacheFile, raw);
    const c = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt")],
      rootPath: FIXTURE_DIR,
    });
    using s = await c.open();
    return s.status;
  }

  it("empty file → 'missing'", async () => {
    const status = await openWithCorruptCache(cp("corrupt-empty"), Buffer.alloc(0));
    expect(status).toBe("missing");
  });

  it("truncated header (< 80 bytes) → 'missing'", async () => {
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(0x00485346, 0); // valid magic but file too short
    const status = await openWithCorruptCache(cp("corrupt-short-hdr"), buf);
    expect(status).toBe("missing");
  });

  it("garbage bytes (no valid header) → 'missing'", async () => {
    const garbage = Buffer.from("totally not a valid .fsh file just random text bytes");
    const padded = Buffer.concat([garbage, Buffer.alloc(80)]); // ensure ≥ HEADER_SIZE
    const status = await openWithCorruptCache(cp("corrupt-garbage"), padded);
    expect(status).toBe("missing");
  });

  it("bad magic → 'missing'", async () => {
    const buf = Buffer.alloc(80);
    buf.writeUInt32LE(0xdeadbeef, 0); // wrong magic
    const status = await openWithCorruptCache(cp("corrupt-magic"), buf);
    expect(status).toBe("missing");
  });

  it("header claims N entries but body too small → 'missing'", async () => {
    // Valid header but `fileCount = 100`, leaving the file's claimed
    // body size far larger than the actual remaining bytes.
    const buf = Buffer.alloc(80);
    buf.writeUInt32LE(0x00485346, 0); // magic
    buf.writeUInt32LE(0, 4); // version
    buf.writeUInt32LE(100, 8); // fileCount — pretend 100 entries
    // No body bytes after the header.
    const status = await openWithCorruptCache(cp("corrupt-truncated-body"), buf);
    expect(status).toBe("missing");
  });

  it("LZ4 body bytes are junk → 'missing'", async () => {
    // Header says 1 entry → body should be 52 bytes uncompressed +
    // the path bytes. We append 60 bytes of arbitrary junk that won't
    // be a valid LZ4 frame.
    const buf = Buffer.alloc(80);
    buf.writeUInt32LE(0x00485346, 0);
    buf.writeUInt32LE(0, 4);
    buf.writeUInt32LE(1, 8); // fileCount = 1
    buf.writeUInt32LE(5, 64); // pathsLen = 5 → body decompressed size = 48+4+5 = 57
    const junkBody = Buffer.from("garbage that is not lz4 compressed valid bytes!!!!!!").subarray(0, 60);
    const status = await openWithCorruptCache(cp("corrupt-bad-lz4"), Buffer.concat([buf, junkBody]));
    expect(status).toBe("missing");
  });

  it("missing → next write succeeds and subsequent open is upToDate", async () => {
    // The whole point of treating malformed as 'missing' is that the
    // caller can write fresh and recover.
    const cacheFile = cp("corrupt-recovery");
    writeFileSync(cacheFile, Buffer.from("not a real cache file"));

    const c = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt")],
      rootPath: FIXTURE_DIR,
    });
    {
      using s = await c.open();
      expect(s.status).toBe("missing");
      await s.write();
    }
    // Re-open: clean upToDate.
    {
      using s = await c.open();
      expect(s.status).toBe("upToDate");
    }
  });
});

describe("session.diskVersion exposure", () => {
  it("equals the caller's version when status is 'missing' (synthesized fresh dataBuf)", async () => {
    // There's nothing readable on disk, so `diskVersion` is just the
    // synthesized header's stamped value — the caller's version. Callers
    // who want to detect "no disk file" should use status === 'missing'
    // rather than comparing diskVersion.
    const cacheFile = cp("dv-missing");
    const c = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt")],
      rootPath: FIXTURE_DIR,
      version: 3,
    });
    using s = await c.open();
    expect(s.status).toBe("missing");
    expect(s.diskVersion).toBe(3);
  });

  it("equals the caller's version when status is 'upToDate' or 'stale' (fingerprint)", async () => {
    const cacheFile = cp("dv-up-to-date");
    const fp1 = Buffer.alloc(16, 1);
    const fp2 = Buffer.alloc(16, 2);
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt")],
        rootPath: FIXTURE_DIR,
        version: 5,
        fingerprint: fp1,
      });
      using s = await c.open();
      await s.write();
    }
    // upToDate
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt")],
        rootPath: FIXTURE_DIR,
        version: 5,
        fingerprint: fp1,
      });
      using s = await c.open();
      expect(s.status).toBe("upToDate");
      expect(s.diskVersion).toBe(5);
    }
    // stale (fingerprint) — diskVersion equals version since version matches
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt")],
        rootPath: FIXTURE_DIR,
        version: 5,
        fingerprint: fp2,
      });
      using s = await c.open();
      expect(s.status).toBe("stale");
      expect(s.diskVersion).toBe(5);
    }
  });

  it("reports the OLD version when status is 'staleVersion'", async () => {
    const cacheFile = cp("dv-stale-version");
    {
      const c = new FileHashCache({
        cachePath: cacheFile,
        files: [fx("a.txt")],
        rootPath: FIXTURE_DIR,
        version: 11,
      });
      using s = await c.open();
      await s.write();
    }
    const c = new FileHashCache({
      cachePath: cacheFile,
      files: [fx("a.txt")],
      rootPath: FIXTURE_DIR,
      version: 99,
    });
    using s = await c.open();
    expect(s.status).toBe("staleVersion");
    expect(s.version).toBe(99);
    expect(s.diskVersion).toBe(11);
  });
});
