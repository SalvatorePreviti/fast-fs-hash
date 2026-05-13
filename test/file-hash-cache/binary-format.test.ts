/**
 * Tests: FileHashCache binary format verification.
 *
 * On-disk format is LZ4-compressed: [magic:4][uncompressedSize:4][LZ4 block]
 * Tests verify the on-disk prefix, round-trip correctness, and that the
 * in-memory format exposes correct values via the context.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileHashCacheSession } from "fast-fs-hash";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BodyFormat,
  H_UNCOMPRESSED_PAYLOAD_ITEM_COUNT,
  H_UNCOMPRESSED_PAYLOADS_LEN,
  HEADER_SIZE,
  MAGIC_ID,
  MAGIC_ID_MASK,
} from "../../packages/fast-fs-hash/src/file-hash-cache-format";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-binary-format");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

async function withCache<T>(
  cp: string,
  files: string[],
  opts: { rootPath?: string; version: number; fingerprint?: Uint8Array },
  run: (session: FileHashCacheSession) => Promise<T> | T
): Promise<T> {
  const cache = new FileHashCache({ cachePath: cp, files, rootPath: opts.rootPath ?? FIXTURE_DIR, ...opts });
  using session = await cache.open();
  return await run(session);
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

describe("FileHashCache binary format [native]", () => {
  //  - On-disk format

  describe("on-disk format", () => {
    it("writes correct magic in header", async () => {
      const cp = cachePath("fmt");
      await withCache(cp, [fixtureFile("a.txt")], { version: 99 }, async (session) => {
        await session.write();
      });

      const data = readFileSync(cp);
      // On-disk: [header:80][LZ4 body]
      expect(data.length).toBeGreaterThan(HEADER_SIZE);
      // Low 3 bytes carry the format ID; high byte is BodyFormat.
      expect(data.readUInt32LE(0) & MAGIC_ID_MASK).toBe(MAGIC_ID);
      // Version at byte 4 should be 99
      expect(data.readUInt32LE(4)).toBe(99);
      // File count at byte 8 should be 1
      expect(data.readUInt32LE(8)).toBe(1);
    });

    it("on-disk file has header + LZ4 body", async () => {
      const cp = cachePath("compressed");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });

      const data = readFileSync(cp);
      // File must be larger than just the header (has compressed body)
      expect(data.length).toBeGreaterThan(HEADER_SIZE);
      // But smaller than header + full uncompressed body (LZ4 compresses)
      // Each entry = 48 bytes + 4 byte pathEnd. 3 files ~ 156 bytes body.
      // Compressed should be smaller, so total < 96 + 156 + 16 slack
      expect(data.length).toBeLessThan(HEADER_SIZE + 200);
    });

    it("header size is 80 bytes", () => {
      expect(HEADER_SIZE).toBe(80);
    });

    it("uncompressed payloads are stored raw directly after the header", async () => {
      const cp = cachePath("uncompressed-section");
      const files = [fixtureFile("a.txt")];
      const items = [Buffer.from("ALPHA"), Buffer.from("BETA-DATA"), Buffer.from("GAMMA-RAW")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write({ uncompressedPayloads: items });
      });

      const data = readFileSync(cp);
      // Header is uncompressed → fields readable directly from disk.
      const uncCount = data.readUInt32LE(H_UNCOMPRESSED_PAYLOAD_ITEM_COUNT);
      const uncLen = data.readUInt32LE(H_UNCOMPRESSED_PAYLOADS_LEN);
      expect(uncCount).toBe(3);
      const expectedLen = items.reduce((s, b) => s + b.byteLength, 0);
      expect(uncLen).toBe(expectedLen);

      // The uncompressed section sits directly after the header:
      //   [dir: uncCount × 4][raw payload bytes]
      // Each entry's bytes must appear verbatim — i.e. no LZ4 compression.
      const dirStart = HEADER_SIZE;
      const payloadsStart = dirStart + uncCount * 4;
      let prevEnd = 0;
      for (let i = 0; i < uncCount; i++) {
        const end = data.readUInt32LE(dirStart + i * 4);
        const slice = data.subarray(payloadsStart + prevEnd, payloadsStart + end);
        expect(Buffer.from(slice).equals(items[i])).toBe(true);
        prevEnd = end;
      }
    });
  });

  //  - In-memory format via context

  describe("in-memory format via context", () => {
    it("exposes correct file count for single file", async () => {
      const cp = cachePath("ctx1");
      const fc = await withCache(cp, [fixtureFile("a.txt")], { version: 42 }, async (session) => {
        const n = session.fileCount;
        await session.write();
        return n;
      });
      expect(fc).toBe(1);
    });

    it("exposes correct file count for multiple files", async () => {
      const cp = cachePath("ctx2");
      const fc = await withCache(cp, [fixtureFile("a.txt"), fixtureFile("b.txt")], { version: 1 }, async (session) => {
        const n = session.fileCount;
        await session.write();
        return n;
      });
      expect(fc).toBe(2);
    });

    it("user values round-trip through write and re-read", async () => {
      const cp = cachePath("ctxuv");
      const files = [fixtureFile("a.txt")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write({
          payloadValue0: 0xdead,
          payloadValue1: 0xbeef,
          payloadValue2: 0xcafe,
          payloadValue3: 0xbabe,
        });
      });

      // Re-open and verify user values survived the round-trip
      const payloadValues = await withCache(
        cp,
        files,
        { version: 1 },
        (session) =>
          [session.payloadValue0, session.payloadValue1, session.payloadValue2, session.payloadValue3] as const
      );
      expect(payloadValues[0]).toBe(0xdead);
      expect(payloadValues[1]).toBe(0xbeef);
      expect(payloadValues[2]).toBe(0xcafe);
      expect(payloadValues[3]).toBe(0xbabe);
    });
  });

  //  - Re-validate with separate opens

  describe("re-validate with separate opens", () => {
    it("can open and re-validate twice", async () => {
      const cp = cachePath("reval");
      const files = [fixtureFile("a.txt")];

      // Create initial cache
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });

      // First re-validate
      const status1 = await withCache(cp, files, { version: 1 }, (session) => session.status);
      expect(status1).toBe("upToDate");

      // Second re-validate
      const status2 = await withCache(cp, files, { version: 1 }, (session) => session.status);
      expect(status2).toBe("upToDate");
    });
  });

  //  - Fingerprint validation

  describe("fingerprint validation", () => {
    it("throws on wrong-length Uint8Array", () => {
      expect(
        () =>
          new FileHashCache({
            cachePath: cachePath(),
            files: [],
            rootPath: FIXTURE_DIR,
            version: 0,
            fingerprint: new Uint8Array(8),
          })
      ).toThrow("16 bytes");
      expect(
        () =>
          new FileHashCache({
            cachePath: cachePath(),
            files: [],
            rootPath: FIXTURE_DIR,
            version: 0,
            fingerprint: new Uint8Array(32),
          })
      ).toThrow("16 bytes");
    });

    it("omitted fingerprint defaults to zero (round-trips)", async () => {
      const cp = cachePath("fp-zero");
      const files = [fixtureFile("a.txt")];

      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });

      const status = await withCache(cp, files, { version: 1 }, (session) => session.status);
      expect(status).toBe("upToDate");
    });
  });

  //  - Body encoding (LZ4 vs PLAIN) chosen by the writer
  //
  // The writer compares LZ4 output against the raw body and picks the smaller
  // form. The chosen encoding is stamped into the high byte of the magic word
  // (BodyFormat enum). Round-trip must produce identical bytes regardless of
  // the chosen encoding.

  describe("body encoding selection", () => {
    function readBodyFormat(cachePath: string): BodyFormat {
      const data = readFileSync(cachePath);
      // Validate the format ID (low 3 bytes) and extract the high byte.
      const magic = data.readUInt32LE(0);
      expect(magic & MAGIC_ID_MASK).toBe(MAGIC_ID);
      return (magic >>> 24) as BodyFormat;
    }

    /** Deterministic xorshift32 PRNG. Produces a high-entropy byte stream
     *  with no repeated patterns — LZ4's match-finder finds nothing useful,
     *  so the compressed output is larger than the input. Reproducible
     *  across runs (no flakiness vs `randomBytes`). `byteLength` must be a
     *  multiple of 4. Mirrors the xorshift32 idiom in
     *  `test/bench/generate-raw-data.cjs`. */
    function incompressibleBytes(byteLength: number, seed = 0xdeadbeef): Buffer {
      if (byteLength % 4 !== 0) {
        throw new Error("byteLength must be a multiple of 4");
      }
      const out = Buffer.alloc(byteLength);
      let s = seed >>> 0;
      for (let i = 0; i < byteLength; i += 4) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        out.writeUInt32LE(s >>> 0, i);
      }
      return out;
    }

    it("compressible body uses LZ4 encoding", async () => {
      const cp = cachePath("fmt-lz4");
      // Many short, similar paths compress well.
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });
      expect(readBodyFormat(cp)).toBe(BodyFormat.LZ4);
    });

    it("writer selects PLAIN for an incompressible body", async () => {
      const cp = cachePath("fmt-plain-comp");
      const files = [fixtureFile("a.txt")];
      const incompressible = incompressibleBytes(32 * 1024);
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write({ compressedPayloads: [incompressible] });
      });
      expect(readBodyFormat(cp)).toBe(BodyFormat.PLAIN);
    });

    it("round-trips compressedPayloads correctly through PLAIN body", async () => {
      const cp = cachePath("fmt-plain-rt");
      const files = [fixtureFile("a.txt")];
      const payload = incompressibleBytes(48 * 1024, 0xbadc0ffe);
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write({ compressedPayloads: [payload] });
      });
      expect(readBodyFormat(cp)).toBe(BodyFormat.PLAIN);

      // Re-open and verify the payload bytes survive a PLAIN round-trip.
      await withCache(cp, files, { version: 1 }, (session) => {
        const recovered = Buffer.from(session.compressedPayloads[0]);
        expect(recovered.equals(payload)).toBe(true);
      });
    });

    it("round-trips compressedPayloads correctly through LZ4 body", async () => {
      const cp = cachePath("fmt-lz4-rt");
      const files = [fixtureFile("a.txt")];
      // Highly compressible payload — LZ4 must win.
      const payload = Buffer.alloc(48 * 1024, 0x41);
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write({ compressedPayloads: [payload] });
      });
      expect(readBodyFormat(cp)).toBe(BodyFormat.LZ4);

      await withCache(cp, files, { version: 1 }, (session) => {
        const recovered = Buffer.from(session.compressedPayloads[0]);
        expect(recovered.equals(payload)).toBe(true);
      });
    });

    it("old files (BodyFormat=LZ4) still readable after upgrade", async () => {
      // We can't easily fabricate a pre-v0.0.3 file, but we can verify the
      // writer's choice of LZ4 produces a file whose magic byte 3 is exactly
      // 0 — matching the pre-v0.0.3 layout exactly. That guarantees old
      // readers (which compared magic === 0x00485346) would see new LZ4
      // files identically.
      const cp = cachePath("fmt-compat");
      const files = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
      await withCache(cp, files, { version: 1 }, async (session) => {
        await session.write();
      });
      const data = readFileSync(cp);
      expect(data.readUInt8(3)).toBe(0); // BodyFormat::LZ4 (byte 3 of magic)
    });
  });
});
