/**
 * Tests for top-level function-based API exported from digest-functions.ts.
 *
 * Validates that every exported function produces correct hashes,
 * matches the class-based API, and handles edge cases properly.
 *
 * Uses describe.each(ALL_BACKENDS) to run all tests against every backend.
 */

import { describe, expect, it } from "vitest";
import { ALL_BACKENDS, hex, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

//  - Fixtures

setupFixtures("digest-functions");

//  - Known xxHash3-128 digests (seed 0,0)

const H_EMPTY = "99aa06d3014798d86001c324468d497f";
const H_1BYTE_42 = "14c9ae9594c463c479d03016b7aeed0d";
const H_1024 = "83885e853bb6640ca870f92984398d22";
const H_500 = "56dd5682fe04888bc12fd3e43ffdd5a1";
const H_HELLO_WORLD = "df8d09e93f874900a99b8775cc15b6c7";
const H_TEST = "6c78e0e3bd51d358d01e758642b85fb8";
const H_HELLO = "b5e9c1ad071b3e7fc779cfaa5e523818";
const H_RANGE_100_500 = "f4964d52ead1b021c53897805a28e34e";
const H_HELLO_WORLD_LF = "eefac9d87100cd1336b2e733a5484425";

// ═══════════════════════════════════════════════════════════════════════

describe.each(ALL_BACKENDS)("%s backend", (_name, backendInstance) => {
  const {
    digestBuffer,
    digestBufferTo,
    digestBufferRange,
    digestBufferRangeTo,
    digestString,
    digestStringTo,
    digestFile,
    digestFileTo,
    digestFilesSequential,
    digestFilesSequentialTo,
    digestFilesParallel,
    digestFilesParallelTo,
  } = backendInstance;

  // ═══════════════════════════════════════════════════════════════════════
  // digestBuffer
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestBuffer", () => {
    it("empty buffer", () => {
      const result = digestBuffer(Buffer.alloc(0));
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("1 byte", () => {
      expect(hex(digestBuffer(Buffer.from([42])))).toBe(H_1BYTE_42);
    });

    it("1024 bytes", () => {
      expect(hex(digestBuffer(makeBuffer(1024)))).toBe(H_1024);
    });

    it("500 bytes", () => {
      expect(hex(digestBuffer(makeBuffer(500)))).toBe(H_500);
    });

    it("Uint8Array input", () => {
      const buf = makeBuffer(1024);
      const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      expect(hex(digestBuffer(arr))).toBe(H_1024);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestBufferTo
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestBufferTo", () => {
    it("writes 16 bytes at offset 0", () => {
      const out = Buffer.alloc(16);
      digestBufferTo(makeBuffer(1024), out);
      expect(hex(out)).toBe(H_1024);
    });

    it("empty input", () => {
      const out = Buffer.alloc(16);
      digestBufferTo(Buffer.alloc(0), out);
      expect(hex(out)).toBe(H_EMPTY);
    });

    it("writes at custom offset", () => {
      const out = Buffer.alloc(32);
      digestBufferTo(makeBuffer(500), out, 8);
      expect(out.subarray(0, 8).every((b) => b === 0)).toBe(true);
      expect(hex(out.subarray(8, 24))).toBe(H_500);
    });

    it("offset 0 matches default", () => {
      const out1 = Buffer.alloc(16);
      const out2 = Buffer.alloc(16);
      digestBufferTo(makeBuffer(1024), out1);
      digestBufferTo(makeBuffer(1024), out2, 0);
      expect(hex(out1)).toBe(hex(out2));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestBufferRange
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestBufferRange", () => {
    it("full range equals digestBuffer", () => {
      expect(hex(digestBufferRange(makeBuffer(1024), 0, 1024))).toBe(H_1024);
    });

    it("full range with undefined length", () => {
      expect(hex(digestBufferRange(makeBuffer(1024), 0))).toBe(H_1024);
    });

    it("subrange from middle", () => {
      expect(hex(digestBufferRange(makeBuffer(1024), 100, 500))).toBe(H_RANGE_100_500);
    });

    it("zero-length range", () => {
      expect(hex(digestBufferRange(makeBuffer(1024), 512, 0))).toBe(H_EMPTY);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestBufferRangeTo
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestBufferRangeTo", () => {
    it("writes range digest at offset 0", () => {
      const out = Buffer.alloc(16);
      digestBufferRangeTo(makeBuffer(1024), 100, 500, out);
      expect(hex(out)).toBe(H_RANGE_100_500);
    });

    it("writes at custom output offset", () => {
      const out = Buffer.alloc(32);
      digestBufferRangeTo(makeBuffer(1024), 0, 1024, out, 10);
      expect(out.subarray(0, 10).every((b) => b === 0)).toBe(true);
      expect(hex(out.subarray(10, 26))).toBe(H_1024);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestString
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestString", () => {
    it("empty string", () => {
      const result = digestString("");
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("short ASCII string", () => {
      expect(hex(digestString("hello world"))).toBe(H_HELLO_WORLD);
    });

    it("'test'", () => {
      expect(hex(digestString("test"))).toBe(H_TEST);
    });

    it("'hello'", () => {
      expect(hex(digestString("hello"))).toBe(H_HELLO);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestStringTo
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestStringTo", () => {
    it("writes at offset 0", () => {
      const out = Buffer.alloc(16);
      digestStringTo("hello world", out);
      expect(hex(out)).toBe(H_HELLO_WORLD);
    });

    it("empty string", () => {
      const out = Buffer.alloc(16);
      digestStringTo("", out);
      expect(hex(out)).toBe(H_EMPTY);
    });

    it("writes at custom offset", () => {
      const out = Buffer.alloc(32);
      digestStringTo("test", out, 8);
      expect(hex(out.subarray(8, 24))).toBe(H_TEST);
      expect(out.subarray(0, 8).every((b) => b === 0)).toBe(true);
    });

    it("offset 0 matches default", () => {
      const out1 = Buffer.alloc(16);
      const out2 = Buffer.alloc(16);
      digestStringTo("hello world", out1);
      digestStringTo("hello world", out2, 0);
      expect(hex(out1)).toBe(hex(out2));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestFile
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFile", () => {
    it("empty file", async () => {
      const p = writeFixture("file-empty.bin", Buffer.alloc(0));
      const result = await digestFile(p);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("1024-byte file", async () => {
      const p = writeFixture("file-1024.bin", makeBuffer(1024));
      expect(hex(await digestFile(p))).toBe(H_1024);
    });

    it("text file matches digestString", async () => {
      const p = writeFixture("file-hello.txt", "hello world\n");
      expect(hex(await digestFile(p))).toBe(H_HELLO_WORLD_LF);
    });

    it("nonexistent file rejects", async () => {
      await expect(digestFile("/tmp/no-such-file-digest-fn-test.bin")).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestFileTo
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFileTo", () => {
    it("writes digest at offset 0", async () => {
      const p = writeFixture("fileto-0.bin", makeBuffer(1024));
      const out = Buffer.alloc(16);
      await digestFileTo(p, out);
      expect(hex(out)).toBe(H_1024);
    });

    it("writes at custom offset", async () => {
      const p = writeFixture("fileto-off.bin", makeBuffer(500));
      const out = Buffer.alloc(32);
      await digestFileTo(p, out, 10);
      expect(out.subarray(0, 10).every((b) => b === 0)).toBe(true);
      expect(hex(out.subarray(10, 26))).toBe(H_500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestFilesSequential
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesSequential", () => {
    it("empty array", async () => {
      const result = await digestFilesSequential([]);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
    });

    it("single file matches class-based sequential", async () => {
      const p = writeFixture("seq-single.bin", makeBuffer(1024));
      const result = await digestFilesSequential([p]);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_1024);
    });

    it("two files in different order produce different hashes", async () => {
      const p1 = writeFixture("seq-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("seq-b.bin", makeBuffer(800, 2));
      const ab = hex(await digestFilesSequential([p1, p2]));
      const ba = hex(await digestFilesSequential([p2, p1]));
      expect(ab).not.toBe(ba);
    });

    it("nonexistent file rejects", async () => {
      const p = writeFixture("seq-ok.bin", makeBuffer(100));
      await expect(digestFilesSequential([p, "/tmp/no-such.bin"])).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestFilesSequentialTo
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesSequentialTo", () => {
    it("writes at offset 0", async () => {
      const p = writeFixture("seqto-0.bin", makeBuffer(500));
      const out = Buffer.alloc(16);
      await digestFilesSequentialTo([p], out);
      expect(hex(out)).toBe(H_500);
    });

    it("writes at custom offset", async () => {
      const p = writeFixture("seqto-off.bin", makeBuffer(1024));
      const out = Buffer.alloc(32);
      await digestFilesSequentialTo([p], out, 8);
      expect(hex(out.subarray(8, 24))).toBe(H_1024);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestFilesParallel
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesParallel", () => {
    it("empty array", async () => {
      const result = await digestFilesParallel([]);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
    });

    it("single file matches stream addFilesParallel", async () => {
      const p = writeFixture("par-fn-single.bin", makeBuffer(1024));
      const standalone = hex(await digestFilesParallel([p]));
      const { XxHash128Stream } = backendInstance;
      const stream = new XxHash128Stream();
      await stream.addFilesParallel([p]);
      expect(standalone).toBe(hex(stream.digest()));
    });

    it("nonexistent file rejects with throwOnError=true (default)", async () => {
      await expect(digestFilesParallel(["/tmp/no-such-parallel-fn-test.bin"])).rejects.toThrow();
    });

    it("nonexistent file produces deterministic result (zero hash for failed file, throwOnError=false)", async () => {
      const r1 = hex(await digestFilesParallel(["/tmp/no-such-parallel-fn-test.bin"], 0, false));
      const r2 = hex(await digestFilesParallel(["/tmp/no-such-parallel-fn-test.bin"], 0, false));
      expect(r1).toBe(r2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // digestFilesParallelTo
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesParallelTo", () => {
    it("writes at offset 0", async () => {
      const p = writeFixture("parto-fn-0.bin", makeBuffer(500));
      const out = Buffer.alloc(16);
      await digestFilesParallelTo([p], out);
      expect(hex(out)).toBe(hex(await digestFilesParallel([p])));
    });

    it("writes at custom offset", async () => {
      const p = writeFixture("parto-fn-off.bin", makeBuffer(1024));
      const out = Buffer.alloc(32);
      await digestFilesParallelTo([p], out, 8);
      expect(hex(out.subarray(8, 24))).toBe(hex(await digestFilesParallel([p])));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cross-API consistency
  // ═══════════════════════════════════════════════════════════════════════

  describe("cross-API consistency", () => {
    it("digestBuffer matches digestBufferTo", () => {
      const input = makeBuffer(1024);
      const direct = digestBuffer(input);
      const out = Buffer.alloc(16);
      digestBufferTo(input, out);
      expect(hex(direct)).toBe(hex(out));
    });

    it("digestString matches digestStringTo", () => {
      const direct = digestString("hello world");
      const out = Buffer.alloc(16);
      digestStringTo("hello world", out);
      expect(hex(direct)).toBe(hex(out));
    });

    it("digestBufferRange(full) matches digestBuffer", () => {
      const input = makeBuffer(1024);
      expect(hex(digestBufferRange(input, 0, 1024))).toBe(hex(digestBuffer(input)));
    });

    it("digestFile matches digestBuffer on same content", async () => {
      const data = makeBuffer(1024);
      const p = writeFixture("cross-file.bin", data);
      const filehash = hex(await digestFile(p));
      const bufhash = hex(digestBuffer(data));
      expect(filehash).toBe(bufhash);
    });

    it("digestBuffer of UTF-8 bytes matches digestString", () => {
      const str = "hello world";
      const buf = Buffer.from(str, "utf-8");
      expect(hex(digestBuffer(buf))).toBe(hex(digestString(str)));
    });
  });
});
