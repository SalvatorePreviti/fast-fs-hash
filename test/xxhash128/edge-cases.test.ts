/**
 * Edge case tests.
 *
 * Verifies correct behavior for:
 * - Input range validation (out-of-bounds offset+length)
 * - Zero-length inputs
 * - Output offset correctness
 * - Seeded vs unseeded consistency
 */

import { describe, expect, it } from "vitest";
import { ALL_BACKENDS, hex, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("edge-cases");

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const {
    XxHash128Stream,
    digestBuffer,
    digestBufferRange,
    digestBufferRangeTo,
    digestBufferTo,
    digestString,
    digestStringTo,
    digestFile,
    digestFileTo,
    digestFilesSequential,
    digestFilesSequentialTo,
    digestFilesParallel,
    digestFilesParallelTo,
  } = backend;

  // ═══════════════════════════════════════════════════════════════════════
  // I. Input range validation — both backends must throw RangeError
  // ═══════════════════════════════════════════════════════════════════════

  describe("input range validation", () => {
    it("digestBufferRange throws for offset+length > buffer size", () => {
      const buf = makeBuffer(100);
      expect(() => digestBufferRange(buf, 50, 100)).toThrow(RangeError);
    });

    it("digestBufferRange throws for offset beyond buffer", () => {
      const buf = makeBuffer(100);
      expect(() => digestBufferRange(buf, 200, 10)).toThrow(RangeError);
    });

    it("digestBufferRangeTo throws for out-of-bounds input", () => {
      const buf = makeBuffer(100);
      const out = Buffer.alloc(16);
      expect(() => digestBufferRangeTo(buf, 50, 100, out)).toThrow(RangeError);
    });

    it("digestBufferRangeTo with offset throws for out-of-bounds input", () => {
      const buf = makeBuffer(100);
      const out = Buffer.alloc(32);
      expect(() => digestBufferRangeTo(buf, 50, 100, out, 0)).toThrow(RangeError);
    });

    it("stream addBufferRange throws for offset+length > buffer size", () => {
      const s = new XxHash128Stream();
      const buf = makeBuffer(100);
      expect(() => s.addBufferRange(buf, 50, 100)).toThrow(RangeError);
    });

    it("stream addBufferRange throws for offset beyond buffer", () => {
      const s = new XxHash128Stream();
      const buf = makeBuffer(100);
      expect(() => s.addBufferRange(buf, 200, 10)).toThrow(RangeError);
    });

    it("stream addBufferRange with exact boundary succeeds", () => {
      const s = new XxHash128Stream();
      const buf = makeBuffer(100);
      // offset=50, length=50 → exactly at the end, should NOT throw
      expect(() => s.addBufferRange(buf, 50, 50)).not.toThrow();
    });

    it("stream addBufferRange one byte over throws", () => {
      const s = new XxHash128Stream();
      const buf = makeBuffer(100);
      expect(() => s.addBufferRange(buf, 50, 51)).toThrow(RangeError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // I-b. Output offset bounds validation — must throw RangeError
  // ═══════════════════════════════════════════════════════════════════════

  describe("output offset bounds validation", () => {
    it("digestBufferTo throws when outOffset + 16 > out.length", () => {
      const out = Buffer.alloc(16);
      expect(() => digestBufferTo(makeBuffer(10), out, 1)).toThrow(RangeError);
    });

    it("digestBufferTo throws when outOffset equals out.length", () => {
      const out = Buffer.alloc(16);
      expect(() => digestBufferTo(makeBuffer(10), out, 16)).toThrow(RangeError);
    });

    it("digestBufferRangeTo throws when outOffset + 16 > out.length", () => {
      const out = Buffer.alloc(16);
      expect(() => digestBufferRangeTo(makeBuffer(100), 0, 50, out, 1)).toThrow(RangeError);
    });

    it("digestStringTo throws when outOffset + 16 > out.length", () => {
      const out = Buffer.alloc(16);
      expect(() => digestStringTo("hello", out, 1)).toThrow(RangeError);
    });

    it("stream digestTo throws when offset + 16 > out.length", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(10));
      const out = Buffer.alloc(16);
      expect(() => s.digestTo(out, 1)).toThrow(RangeError);
    });

    it("digestFileTo throws when outOffset + 16 > out.length", () => {
      const p = writeFixture("oob.bin", "hello");
      const out = Buffer.alloc(16);
      // Both backends throw synchronously for output OOB (before async I/O starts)
      expect(() => digestFileTo(p, out, 1)).toThrow(RangeError);
    });

    it("digestFileTo throws even with throwOnError=false when outOffset OOB", () => {
      const p = writeFixture("oob2.bin", "hello");
      const out = Buffer.alloc(16);
      // OOB error is not a file-I/O error — it should propagate regardless of throwOnError
      expect(() => digestFileTo(p, out, 1, false)).toThrow(RangeError);
    });

    it("digestFilesSequentialTo throws or rejects when outOffset + 16 > out.length", async () => {
      const p = writeFixture("oob3.bin", "hello");
      const out = Buffer.alloc(16);
      try {
        await backend.digestFilesSequentialTo([p], out, 1);
        expect.unreachable("should have thrown or rejected");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
      }
    });

    it("digestFilesParallelTo throws or rejects when outOffset + 16 > out.length", async () => {
      const p = writeFixture("oob4.bin", "hello");
      const out = Buffer.alloc(16);
      try {
        await backend.digestFilesParallelTo([p], out, 1);
        expect.unreachable("should have thrown or rejected");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // II. Zero-length inputs
  // ═══════════════════════════════════════════════════════════════════════

  describe("zero-length inputs", () => {
    it("digestBuffer(empty) returns a valid 16-byte hash", () => {
      const result = digestBuffer(Buffer.alloc(0));
      expect(result).toHaveLength(16);
    });

    it("digestBufferRange(buf, 0, 0) matches digestBuffer(empty)", () => {
      const buf = makeBuffer(100);
      expect(hex(digestBufferRange(buf, 0, 0))).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("digestBufferRange(buf, 50, 0) matches digestBuffer(empty)", () => {
      const buf = makeBuffer(100);
      expect(hex(digestBufferRange(buf, 50, 0))).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("digestBufferRange(buf, buf.length, 0) matches digestBuffer(empty)", () => {
      const buf = makeBuffer(100);
      expect(hex(digestBufferRange(buf, 100, 0))).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("digestString('') matches digestBuffer(empty)", () => {
      expect(hex(digestString(""))).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("stream with only zero-length additions", () => {
      const s = new XxHash128Stream();
      s.addBuffer(Buffer.alloc(0));
      s.addString("");
      s.addBufferRange(makeBuffer(10), 0, 0);
      expect(hex(s.digest())).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("seeded stream empty differs from unseeded", () => {
      const unseeded = hex(new XxHash128Stream().digest());
      const seeded = hex(new XxHash128Stream(42, 0).digest());
      // Seeded with non-zero seed should produce a different hash
      expect(seeded).not.toBe(unseeded);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // III. Output offset correctness
  // ═══════════════════════════════════════════════════════════════════════

  describe("output offset correctness", () => {
    it("digestBufferTo writes exactly 16 bytes at offset 0", () => {
      const out = Buffer.alloc(32, 0xff);
      digestBufferTo(makeBuffer(100), out);
      // Bytes [0..15] should be the hash
      expect(hex(out.subarray(0, 16))).toBe(hex(digestBuffer(makeBuffer(100))));
      // Bytes [16..31] should be untouched (0xff)
      expect(out.subarray(16, 32).every((b) => b === 0xff)).toBe(true);
    });

    it("digestBufferTo writes at the specified offset", () => {
      const out = Buffer.alloc(48, 0xff);
      digestBufferTo(makeBuffer(100), out, 16);
      // Bytes [0..15] should be untouched
      expect(out.subarray(0, 16).every((b) => b === 0xff)).toBe(true);
      // Bytes [16..31] should be the hash
      expect(hex(out.subarray(16, 32))).toBe(hex(digestBuffer(makeBuffer(100))));
      // Bytes [32..47] should be untouched
      expect(out.subarray(32, 48).every((b) => b === 0xff)).toBe(true);
    });

    it("digestStringTo writes exactly 16 bytes at offset 0", () => {
      const out = Buffer.alloc(32, 0xff);
      digestStringTo("hello world", out);
      expect(hex(out.subarray(0, 16))).toBe(hex(digestString("hello world")));
      expect(out.subarray(16, 32).every((b) => b === 0xff)).toBe(true);
    });

    it("digestStringTo writes at the specified offset", () => {
      const out = Buffer.alloc(48, 0xff);
      digestStringTo("hello world", out, 16);
      expect(out.subarray(0, 16).every((b) => b === 0xff)).toBe(true);
      expect(hex(out.subarray(16, 32))).toBe(hex(digestString("hello world")));
      expect(out.subarray(32, 48).every((b) => b === 0xff)).toBe(true);
    });

    it("stream digestTo writes exactly 16 bytes at offset 0", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(100));
      const out = Buffer.alloc(32, 0xff);
      s.digestTo(out);
      expect(hex(out.subarray(0, 16))).toBe(hex(digestBuffer(makeBuffer(100))));
      expect(out.subarray(16, 32).every((b) => b === 0xff)).toBe(true);
    });

    it("stream digestTo writes at the specified offset", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(100));
      const out = Buffer.alloc(48, 0xff);
      s.digestTo(out, 16);
      expect(out.subarray(0, 16).every((b) => b === 0xff)).toBe(true);
      expect(hex(out.subarray(16, 32))).toBe(hex(digestBuffer(makeBuffer(100))));
      expect(out.subarray(32, 48).every((b) => b === 0xff)).toBe(true);
    });

    it("digestBufferRangeTo writes at the specified offset", () => {
      const input = makeBuffer(200);
      const out = Buffer.alloc(48, 0xff);
      digestBufferRangeTo(input, 50, 100, out, 16);
      expect(out.subarray(0, 16).every((b) => b === 0xff)).toBe(true);
      expect(hex(out.subarray(16, 32))).toBe(hex(digestBufferRange(input, 50, 100)));
      expect(out.subarray(32, 48).every((b) => b === 0xff)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // IV. Async file edge cases
  // ═══════════════════════════════════════════════════════════════════════

  describe("async file edge cases", () => {
    it("digestFile on empty file returns valid hash", async () => {
      const p = writeFixture("empty.bin", "");
      const result = await digestFile(p);
      expect(result).toHaveLength(16);
      // Empty file = empty input hash
      expect(hex(result)).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("digestFileTo writes at specified offset", async () => {
      const p = writeFixture("small.bin", "hello");
      const out = Buffer.alloc(48, 0xff);
      await digestFileTo(p, out, 16);
      expect(out.subarray(0, 16).every((b) => b === 0xff)).toBe(true);
      expect(out.subarray(32, 48).every((b) => b === 0xff)).toBe(true);
      // Hash should match digestString("hello")
      expect(hex(out.subarray(16, 32))).toBe(hex(digestString("hello")));
    });

    it("digestFilesSequential([]) produces hash of empty input", async () => {
      const result = await digestFilesSequential([]);
      expect(hex(result)).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("digestFilesParallel([]) produces hash of empty input", async () => {
      const result = await digestFilesParallel([]);
      expect(hex(result)).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // V. Subrange correctness
  // ═══════════════════════════════════════════════════════════════════════

  describe("subrange correctness", () => {
    it("digestBufferRange(buf, 0, buf.length) matches digestBuffer(buf)", () => {
      const buf = makeBuffer(256);
      expect(hex(digestBufferRange(buf, 0, 256))).toBe(hex(digestBuffer(buf)));
    });

    it("digestBufferRange matches streaming equivalent", () => {
      const buf = makeBuffer(256);
      const rangeHash = digestBufferRange(buf, 64, 128);
      const s = new XxHash128Stream();
      s.addBufferRange(buf, 64, 128);
      expect(hex(s.digest())).toBe(hex(rangeHash));
    });

    it("digestBufferRange matches sliced buffer", () => {
      const buf = makeBuffer(256);
      const rangeHash = hex(digestBufferRange(buf, 64, 128));
      const slicedHash = hex(digestBuffer(buf.subarray(64, 192)));
      expect(rangeHash).toBe(slicedHash);
    });
  });

  // ─── Exported functions are the same as XxHash128Stream static methods ───

  describe("exported digest functions match XxHash128Stream static methods", () => {
    it("all digest functions are identical to XxHash128Stream properties", () => {
      expect(digestBuffer).toBe(XxHash128Stream.digestBuffer);
      expect(digestBufferRange).toBe(XxHash128Stream.digestBufferRange);
      expect(digestBufferTo).toBe(XxHash128Stream.digestBufferTo);
      expect(digestBufferRangeTo).toBe(XxHash128Stream.digestBufferRangeTo);
      expect(digestString).toBe(XxHash128Stream.digestString);
      expect(digestStringTo).toBe(XxHash128Stream.digestStringTo);
      expect(digestFile).toBe(XxHash128Stream.digestFile);
      expect(digestFileTo).toBe(XxHash128Stream.digestFileTo);
      expect(digestFilesSequential).toBe(XxHash128Stream.digestFilesSequential);
      expect(digestFilesSequentialTo).toBe(XxHash128Stream.digestFilesSequentialTo);
      expect(digestFilesParallel).toBe(XxHash128Stream.digestFilesParallel);
      expect(digestFilesParallelTo).toBe(XxHash128Stream.digestFilesParallelTo);
    });

    it("XxHash128Stream.hash produces same result as digestBuffer", () => {
      const data = makeBuffer(1024);
      expect(hex(XxHash128Stream.hash(data))).toBe(hex(digestBuffer(data)));
    });

    it("XxHash128Stream.hash with string produces same result as digestString", () => {
      expect(hex(XxHash128Stream.hash("hello world"))).toBe(hex(digestString("hello world")));
    });
  });
});
