/**
 * Tests for XxHash128Stream across all backends.
 *
 * Each test uses independent fixtures via setupFixtures("stream").
 * Reference hashes are computed with the already-tested module-level
 * digest functions where appropriate, and hardcoded xxHash3-128 values
 * are used for direct verification.
 *
 * Key scenarios:
 * - addBuffer: empty, single, multi-chunk, Uint8Array
 * - addBufferRange: subrange, offset
 * - addString: empty, ASCII, multi-byte UTF-8
 * - addFile: empty, small, large, nonexistent, throwOnError
 * - addFiles: sequential concatenation
 * - addFilesParallel: parallel per-file hash aggregation
 * - digest / digestTo: finalize, idempotent, not-reset
 * - reset: clears state
 * - incremental feeding matches single-shot digest
 */

import { describe, expect, it } from "vitest";
import { ALL_BACKENDS, hex, makeAsciiString, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("stream");

const BUF = 131072;
const READ_BUF = 131072;

//  - Known xxHash3-128 digests (seed 0,0)

const H_EMPTY = "99aa06d3014798d86001c324468d497f";
const H_1BYTE_42 = "14c9ae9594c463c479d03016b7aeed0d";
const H_1024 = "83885e853bb6640ca870f92984398d22";
const H_BUF_EXACT = "9507b6f5073d831d8e707008b17e014c";
const H_BUF_PLUS1 = "e4068c0fc25b3c45e39ce30528538126";
const H_1MB = "1b208d2839093774d36c0e13a3df139e";
const H_7 = "61ce291bc3a4357ddbb207821e6d5efe";
const H_13 = "ae92e123e9472408bd795526190266c0";
const H_999 = "822c6d736ac58a76637cd0146bdf4338";
const H_100003 = "413105646a84cefecfcb6bf006e7e27f";
const H_917391 = "87fc88d3eef31bfa70568c69183231d0";

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { XxHash128Stream, digestBuffer, digestBufferRange, digestString, digestFile, digestFilesSequential } = backend;

  //  - Constructor

  describe("constructor", () => {
    it("default settings", () => {
      const s = new XxHash128Stream();
      expect(s.seedLow).toBe(0);
      expect(s.seedHigh).toBe(0);
    });

    it("seed arguments", () => {
      const s = new XxHash128Stream(42, 99);
      expect(s.seedLow).toBe(42);
      expect(s.seedHigh).toBe(99);
    });
  });

  //  - addBuffer

  describe("addBuffer", () => {
    it("empty buffer → same as empty digest", () => {
      const s = new XxHash128Stream();
      s.addBuffer(Buffer.alloc(0));
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("single byte [42]", () => {
      const s = new XxHash128Stream();
      s.addBuffer(Buffer.from([42]));
      expect(hex(s.digest())).toBe(H_1BYTE_42);
    });

    it("1024 bytes matches digestBuffer", () => {
      const buf = makeBuffer(1024);
      const s = new XxHash128Stream();
      s.addBuffer(buf);
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("exactly BUF_SIZE matches digestBuffer", () => {
      const buf = makeBuffer(BUF);
      const s = new XxHash128Stream();
      s.addBuffer(buf);
      expect(hex(s.digest())).toBe(H_BUF_EXACT);
    });

    it("BUF_SIZE + 1 (multi-chunk) matches digestBuffer", () => {
      const buf = makeBuffer(BUF + 1);
      const s = new XxHash128Stream();
      s.addBuffer(buf);
      expect(hex(s.digest())).toBe(H_BUF_PLUS1);
    });

    it("1 MB matches digestBuffer", () => {
      const buf = makeBuffer(1048576);
      const s = new XxHash128Stream();
      s.addBuffer(buf);
      expect(hex(s.digest())).toBe(H_1MB);
    });

    it("7 bytes (odd prime)", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(7));
      expect(hex(s.digest())).toBe(H_7);
    });

    it("13 bytes (odd prime)", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(13));
      expect(hex(s.digest())).toBe(H_13);
    });

    it("999 bytes (odd)", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(999));
      expect(hex(s.digest())).toBe(H_999);
    });

    it("100003 bytes (odd prime > READ_BUF)", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(100003));
      expect(hex(s.digest())).toBe(H_100003);
    });

    it("917391 bytes (large odd)", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(917391));
      expect(hex(s.digest())).toBe(H_917391);
    });

    it("917391 bytes incremental (chunks of 1000)", () => {
      const full = makeBuffer(917391);
      const s = new XxHash128Stream();
      for (let i = 0; i < 917391; i += 1000) {
        s.addBuffer(full.subarray(i, Math.min(i + 1000, 917391)));
      }
      expect(hex(s.digest())).toBe(H_917391);
    });

    it("Uint8Array input (not Buffer)", () => {
      const buf = makeBuffer(BUF);
      const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const s = new XxHash128Stream();
      s.addBuffer(arr);
      expect(hex(s.digest())).toBe(H_BUF_EXACT);
    });

    it("incremental feed matches single-shot", () => {
      const full = makeBuffer(1024);
      const s = new XxHash128Stream();
      // Feed in chunks
      s.addBuffer(full.subarray(0, 100));
      s.addBuffer(full.subarray(100, 500));
      s.addBuffer(full.subarray(500, 1024));
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("many small incremental feeds", () => {
      const full = makeBuffer(1024);
      const s = new XxHash128Stream();
      for (let i = 0; i < 1024; i++) {
        s.addBuffer(full.subarray(i, i + 1));
      }
      expect(hex(s.digest())).toBe(H_1024);
    });
  });

  //  - addBufferRange

  describe("addBufferRange", () => {
    it("full range matches addBuffer", () => {
      const buf = makeBuffer(1024);
      const s = new XxHash128Stream();
      s.addBufferRange(buf, 0, 1024);
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("subrange matches digestBufferRange", () => {
      const buf = makeBuffer(2048);
      const expected = hex(digestBufferRange(buf, 100, 500));
      const s = new XxHash128Stream();
      s.addBufferRange(buf, 100, 500);
      expect(hex(s.digest())).toBe(expected);
    });

    it("omitted length = rest of buffer", () => {
      const buf = makeBuffer(1024);
      const expected = hex(digestBufferRange(buf, 256));
      const s = new XxHash128Stream();
      s.addBufferRange(buf, 256);
      expect(hex(s.digest())).toBe(expected);
    });

    it("zero-length range → empty", () => {
      const s = new XxHash128Stream();
      s.addBufferRange(makeBuffer(100), 50, 0);
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("incremental subranges match full buffer", () => {
      const buf = makeBuffer(1024);
      const s = new XxHash128Stream();
      s.addBufferRange(buf, 0, 512);
      s.addBufferRange(buf, 512, 512);
      expect(hex(s.digest())).toBe(H_1024);
    });
  });

  //  - addString

  describe("addString", () => {
    it("empty string → empty digest", () => {
      const s = new XxHash128Stream();
      s.addString("");
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("matches digestString", () => {
      const str = "hello world\n";
      const expected = hex(digestString(str));
      const s = new XxHash128Stream();
      s.addString(str);
      expect(hex(s.digest())).toBe(expected);
    });

    it("long ASCII string matches digestString", () => {
      const str = makeAsciiString(100000);
      const expected = hex(digestString(str));
      const s = new XxHash128Stream();
      s.addString(str);
      expect(hex(s.digest())).toBe(expected);
    });

    it("incremental string feed matches single-shot", () => {
      const full = "hello world!";
      // digestString of full string
      const expected = hex(digestString(full));
      // Feed the equivalent UTF-8 bytes incrementally
      const buf = Buffer.from(full, "utf-8");
      const s = new XxHash128Stream();
      s.addBuffer(buf.subarray(0, 5));
      s.addBuffer(buf.subarray(5));
      expect(hex(s.digest())).toBe(expected);
    });

    it("mixed addString and addBuffer", () => {
      // Feeding "hello" as string then " world" as buffer should equal
      // feeding "hello world" as one buffer.
      const full = Buffer.from("hello world", "utf-8");
      const expected = hex(digestBuffer(full));
      const s = new XxHash128Stream();
      s.addString("hello");
      s.addBuffer(Buffer.from(" world", "utf-8"));
      expect(hex(s.digest())).toBe(expected);
    });
  });

  //  - addFile

  describe("addFile", () => {
    it("empty file → empty digest", async () => {
      const p = writeFixture("stream-empty.bin", Buffer.alloc(0));
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("small file matches digestFile", async () => {
      const data = makeBuffer(1024);
      const p = writeFixture("stream-small.bin", data);
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("file > READ_BUF_SIZE matches digestFile", async () => {
      const data = makeBuffer(READ_BUF + 1);
      const p = writeFixture("stream-read-plus1.bin", data);
      const expected = hex(await digestFile(p));
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(expected);
    });

    it("sequential addFile matches digestFilesSequential", async () => {
      const p1 = writeFixture("stream-seq-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("stream-seq-b.bin", makeBuffer(800, 2));
      const expected = hex(await digestFilesSequential([p1, p2]));
      const s = new XxHash128Stream();
      await s.addFile(p1);
      await s.addFile(p2);
      expect(hex(s.digest())).toBe(expected);
    });

    it("nonexistent file with throwOnError=false is skipped", async () => {
      const p = writeFixture("stream-exists.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      await s.addFile("/tmp/no-such-stream-file-99999.bin", false);
      await s.addFile(p);
      // Missing file contributes nothing; result = hash of just the real file
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("nonexistent file with throwOnError=true rejects", async () => {
      const s = new XxHash128Stream();
      await expect(s.addFile("/tmp/no-such-stream-file-99999.bin")).rejects.toThrow();
    });

    it("addFile matches addBuffer for same content", async () => {
      const data = makeBuffer(5000);
      const p = writeFixture("stream-match.bin", data);
      const s1 = new XxHash128Stream();
      s1.addBuffer(data);
      const s2 = new XxHash128Stream();
      await s2.addFile(p);
      expect(hex(s2.digest())).toBe(hex(s1.digest()));
    });

    it("1 MB file", async () => {
      const data = makeBuffer(1048576);
      const p = writeFixture("stream-1mb.bin", data);
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(H_1MB);
    });
  });

  //  - addFiles

  describe("addFiles", () => {
    it("empty array → empty digest", async () => {
      const s = new XxHash128Stream();
      await s.addFiles([]);
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("single file matches addFile", async () => {
      const p = writeFixture("addfiles-single.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      await s.addFiles([p]);
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("multiple files match digestFilesSequential", async () => {
      const p1 = writeFixture("addfiles-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("addfiles-b.bin", makeBuffer(800, 2));
      const expected = hex(await digestFilesSequential([p1, p2]));
      const s = new XxHash128Stream();
      await s.addFiles([p1, p2]);
      expect(hex(s.digest())).toBe(expected);
    });

    it("order matters", async () => {
      const p1 = writeFixture("addfiles-ord-a.bin", makeBuffer(300, 10));
      const p2 = writeFixture("addfiles-ord-b.bin", makeBuffer(400, 20));
      const s1 = new XxHash128Stream();
      await s1.addFiles([p1, p2]);
      const s2 = new XxHash128Stream();
      await s2.addFiles([p2, p1]);
      expect(hex(s1.digest())).not.toBe(hex(s2.digest()));
    });

    it("missing file skipped with throwOnError=false", async () => {
      const p = writeFixture("addfiles-ok.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      await s.addFiles(["/tmp/no-such-addfiles-1.bin", p, "/tmp/no-such-addfiles-2.bin"], false);
      expect(hex(s.digest())).toBe(H_1024);
    });

    it("missing file rejects with throwOnError=true", async () => {
      const p = writeFixture("addfiles-throw.bin", makeBuffer(100));
      const s = new XxHash128Stream();
      await expect(s.addFiles([p, "/tmp/no-such-addfiles.bin"])).rejects.toThrow();
    });

    it("many files (> 8)", async () => {
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(writeFixture(`addfiles-many-${i}.bin`, makeBuffer(100 + i * 50, i)));
      }
      const expected = hex(await digestFilesSequential(paths));
      const s = new XxHash128Stream();
      await s.addFiles(paths);
      expect(hex(s.digest())).toBe(expected);
    });

    it("addFiles extends running state", async () => {
      // addBuffer(prefix) + addFiles([a, b]) should match
      // digestFilesSequential over [prefix_file, a, b]
      const prefix = makeBuffer(200, 77);
      const a = makeBuffer(300, 1);
      const b = makeBuffer(400, 2);
      const pPrefix = writeFixture("addfiles-prefix.bin", prefix);
      const pA = writeFixture("addfiles-ext-a.bin", a);
      const pB = writeFixture("addfiles-ext-b.bin", b);
      const expected = hex(await digestFilesSequential([pPrefix, pA, pB]));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFiles([pA, pB]);
      expect(hex(s.digest())).toBe(expected);
    });
  });

  //  - addFilesParallel

  describe("addFilesParallel", () => {
    it("empty array → empty digest", async () => {
      const s = new XxHash128Stream();
      await s.addFilesParallel([]);
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("single file — digest equals hash of per-file-hash", async () => {
      const p = writeFixture("par-single.bin", makeBuffer(512));
      const fileHash = await digestFile(p);
      // Parallel result = hash(fileHash)
      const expected = hex(digestBuffer(fileHash));
      const s = new XxHash128Stream();
      await s.addFilesParallel([p]);
      expect(hex(s.digest())).toBe(expected);
    });

    it("two files produces consistent aggregate", async () => {
      const p1 = writeFixture("par-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("par-b.bin", makeBuffer(800, 2));
      // Compute expected via per-file hashes
      const h1 = await digestFile(p1);
      const h2 = await digestFile(p2);
      const expected = hex(digestBuffer(Buffer.concat([h1, h2])));
      const s = new XxHash128Stream();
      await s.addFilesParallel([p1, p2]);
      expect(hex(s.digest())).toBe(expected);
    });

    it("order matters", async () => {
      const p1 = writeFixture("par-ord-a.bin", makeBuffer(300, 10));
      const p2 = writeFixture("par-ord-b.bin", makeBuffer(400, 20));
      const s1 = new XxHash128Stream();
      await s1.addFilesParallel([p1, p2]);
      const s2 = new XxHash128Stream();
      await s2.addFilesParallel([p2, p1]);
      expect(hex(s1.digest())).not.toBe(hex(s2.digest()));
    });

    it("missing file with throwOnError=false → zero hash contribution", async () => {
      const p = writeFixture("par-ok.bin", makeBuffer(1024));
      // In parallel mode, a missing file with throwOnError=false contributes
      // 16 zero bytes. The expected hash is: hash(zeros_16 || fileHash).
      const fileHash = await digestFile(p);
      const expected = hex(digestBuffer(Buffer.concat([Buffer.alloc(16), fileHash])));
      const s = new XxHash128Stream();
      await s.addFilesParallel(["/tmp/no-par-1.bin", p], 0, false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("missing file rejects with throwOnError=true", async () => {
      const p = writeFixture("par-throw.bin", makeBuffer(100));
      const s = new XxHash128Stream();
      await expect(s.addFilesParallel([p, "/tmp/no-par.bin"])).rejects.toThrow();
    });

    it("many files (> 8 concurrent lanes)", async () => {
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(writeFixture(`par-many-${i}.bin`, makeBuffer(100 + i * 50, i)));
      }
      // Two separate stream invocations should produce the same result
      const s1 = new XxHash128Stream();
      await s1.addFilesParallel(paths);
      const s2 = new XxHash128Stream();
      await s2.addFilesParallel(paths);
      expect(hex(s1.digest())).toBe(hex(s2.digest()));
    });

    it("parallel ≠ sequential for same files", async () => {
      const p1 = writeFixture("par-neq-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("par-neq-b.bin", makeBuffer(800, 2));
      const s1 = new XxHash128Stream();
      await s1.addFiles([p1, p2]);
      const s2 = new XxHash128Stream();
      await s2.addFilesParallel([p1, p2]);
      expect(hex(s1.digest())).not.toBe(hex(s2.digest()));
    });

    it("addFilesParallel extends running state", async () => {
      // addBuffer(prefix) then addFilesParallel([a, b])
      // should equal: hash(prefix || perFileHash_a || perFileHash_b)
      const prefix = makeBuffer(200, 77);
      const aData = makeBuffer(300, 1);
      const bData = makeBuffer(400, 2);
      const pA = writeFixture("par-ext-a.bin", aData);
      const pB = writeFixture("par-ext-b.bin", bData);
      const hashA = await digestFile(pA);
      const hashB = await digestFile(pB);
      const combined = Buffer.concat([prefix, hashA, hashB]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFilesParallel([pA, pB]);
      expect(hex(s.digest())).toBe(expected);
    });

    it("concurrency = 1 gives same result", async () => {
      const p1 = writeFixture("par-conc1-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("par-conc1-b.bin", makeBuffer(800, 2));
      const sDefault = new XxHash128Stream();
      await sDefault.addFilesParallel([p1, p2]);
      const s1 = new XxHash128Stream();
      await s1.addFilesParallel([p1, p2], 1);
      expect(hex(s1.digest())).toBe(hex(sDefault.digest()));
    });
  });

  //  - digest / digestTo

  describe("digest", () => {
    it("returns a Buffer", () => {
      const s = new XxHash128Stream();
      const result = s.digest();
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
    });

    it("empty stream → empty digest", () => {
      expect(hex(new XxHash128Stream().digest())).toBe(H_EMPTY);
    });

    it("digest is idempotent", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      const first = hex(s.digest());
      const second = hex(s.digest());
      expect(first).toBe(H_1024);
      expect(second).toBe(H_1024);
    });

    it("digest does not reset state", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(512));
      const h1 = hex(s.digest());
      s.addBuffer(makeBuffer(512));
      const h2 = hex(s.digest());
      // Adding more data after digest should change the result
      expect(h1).not.toBe(h2);
    });
  });

  describe("digestTo", () => {
    it("writes 16 bytes at offset 0", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      const out = Buffer.alloc(16);
      s.digestTo(out);
      expect(hex(out)).toBe(H_1024);
    });

    it("writes at custom offset", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      const out = Buffer.alloc(32);
      s.digestTo(out, 8);
      expect(out.subarray(0, 8).every((b) => b === 0)).toBe(true);
      expect(hex(out.subarray(8, 24))).toBe(H_1024);
    });

    it("matches digest()", () => {
      const s = new XxHash128Stream();
      s.addString("test data for digestTo");
      const buf = s.digest();
      const out = Buffer.alloc(16);
      s.digestTo(out);
      expect(hex(out)).toBe(hex(buf));
    });
  });

  //  - reset

  describe("reset", () => {
    it("returns to empty digest", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      expect(hex(s.digest())).toBe(H_1024);
      s.reset();
      expect(hex(s.digest())).toBe(H_EMPTY);
    });

    it("after reset, feeding same data gives same result", () => {
      const buf = makeBuffer(1024);
      const s = new XxHash128Stream();
      s.addBuffer(buf);
      const h1 = hex(s.digest());
      s.reset();
      s.addBuffer(buf);
      const h2 = hex(s.digest());
      expect(h1).toBe(h2);
      expect(h1).toBe(H_1024);
    });

    it("reset with seeds restores seeded initial state", () => {
      const s = new XxHash128Stream(42, 99);
      const empty = hex(s.digest());
      s.addBuffer(makeBuffer(100));
      s.reset();
      expect(hex(s.digest())).toBe(empty);
    });

    it("reset after file feed", async () => {
      const p = writeFixture("stream-reset-file.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      await s.addFile(p);
      s.reset();
      expect(hex(s.digest())).toBe(H_EMPTY);
    });
  });

  //  - Seeded streams

  describe("seeded streams", () => {
    it("seed affects digest", () => {
      const buf = makeBuffer(1024);
      const s0 = new XxHash128Stream();
      s0.addBuffer(buf);
      const s42 = new XxHash128Stream(42);
      s42.addBuffer(buf);
      expect(hex(s0.digest())).not.toBe(hex(s42.digest()));
    });

    it("stream with seed produces different hash from unseeded", () => {
      const buf = makeBuffer(1024);
      const s0 = new XxHash128Stream();
      s0.addBuffer(buf);
      const s42 = new XxHash128Stream(42, 99);
      s42.addBuffer(buf);
      expect(hex(s0.digest())).not.toBe(hex(s42.digest()));
    });

    it("seeded stream is deterministic", () => {
      const buf = makeBuffer(1024);
      const s1 = new XxHash128Stream(42, 99);
      s1.addBuffer(buf);
      const s2 = new XxHash128Stream(42, 99);
      s2.addBuffer(buf);
      expect(hex(s1.digest())).toBe(hex(s2.digest()));
    });

    it("seeded addFile produces different hash from unseeded", async () => {
      const data = makeBuffer(5000);
      const p = writeFixture("stream-seeded-file.bin", data);
      const s0 = new XxHash128Stream();
      await s0.addFile(p);
      const s42 = new XxHash128Stream(42, 99);
      await s42.addFile(p);
      expect(hex(s0.digest())).not.toBe(hex(s42.digest()));
    });
  });

  //  - Two independent streams

  describe("independent streams", () => {
    it("two streams do not interfere", () => {
      const s1 = new XxHash128Stream();
      const s2 = new XxHash128Stream();
      s1.addBuffer(makeBuffer(1024));
      s2.addBuffer(makeBuffer(512));
      expect(hex(s1.digest())).toBe(H_1024);
      const h512 = hex(digestBuffer(makeBuffer(512)));
      expect(hex(s2.digest())).toBe(h512);
    });

    it("two streams with different seeds", () => {
      const buf = makeBuffer(1024);
      const s1 = new XxHash128Stream(0, 0);
      const s2 = new XxHash128Stream(42, 0);
      s1.addBuffer(buf);
      s2.addBuffer(buf);
      expect(hex(s1.digest())).not.toBe(hex(s2.digest()));
    });
  });

  //  - clone()

  describe("clone", () => {
    it("cloned stream produces same digest", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      const clone = s.clone();
      expect(hex(clone.digest())).toBe(hex(s.digest()));
    });

    it("cloned stream is independent", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(100));
      const clone = s.clone();
      s.addBuffer(makeBuffer(200));
      clone.addString("different data");
      expect(hex(s.digest())).not.toBe(hex(clone.digest()));
    });

    it("clone of empty stream matches empty digest", () => {
      const s = new XxHash128Stream();
      const clone = s.clone();
      expect(hex(clone.digest())).toBe(H_EMPTY);
    });

    it("clone preserves seed", () => {
      const s = new XxHash128Stream(42, 99);
      s.addBuffer(makeBuffer(1024));
      const clone = s.clone();
      expect(clone.seedLow).toBe(42);
      expect(clone.seedHigh).toBe(99);
      expect(hex(clone.digest())).toBe(hex(s.digest()));
    });

    it("clone after addFile matches original", async () => {
      const p = writeFixture("clone-file.bin", makeBuffer(5000));
      const s = new XxHash128Stream();
      await s.addFile(p);
      const clone = s.clone();
      expect(hex(clone.digest())).toBe(hex(s.digest()));
    });
  });

  //  - static hash()

  describe("static hash", () => {
    it("hash(buffer) matches digestBuffer", () => {
      const buf = makeBuffer(1024);
      expect(hex(XxHash128Stream.hash(buf))).toBe(hex(digestBuffer(buf)));
    });

    it("hash(string) matches digestString", () => {
      expect(hex(XxHash128Stream.hash("hello world"))).toBe(hex(digestString("hello world")));
    });

    it("hash(empty buffer) matches empty digest", () => {
      expect(hex(XxHash128Stream.hash(Buffer.alloc(0)))).toBe(H_EMPTY);
    });

    it("hash('') matches empty digest", () => {
      expect(hex(XxHash128Stream.hash(""))).toBe(H_EMPTY);
    });
  });

  //  - Odd byte counts with files

  describe("odd byte count files", () => {
    it("917391-byte file matches digestFile", async () => {
      const data = makeBuffer(917391);
      const p = writeFixture("stream-odd-917391.bin", data);
      const expected = hex(await digestFile(p));
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(expected);
      expect(hex(s.digest())).toBe(H_917391);
    });

    it("100003-byte file matches digestFile", async () => {
      const data = makeBuffer(100003);
      const p = writeFixture("stream-odd-100003.bin", data);
      const expected = hex(await digestFile(p));
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(expected);
    });

    it("addFiles with odd-sized files matches digestFilesSequential", async () => {
      const p1 = writeFixture("stream-odd-a.bin", makeBuffer(917391, 1));
      const p2 = writeFixture("stream-odd-b.bin", makeBuffer(7, 2));
      const p3 = writeFixture("stream-odd-c.bin", makeBuffer(100003, 3));
      const expected = hex(await digestFilesSequential([p1, p2, p3]));
      const s = new XxHash128Stream();
      await s.addFiles([p1, p2, p3]);
      expect(hex(s.digest())).toBe(expected);
    });

    it("addFilesParallel with odd-sized files is deterministic", async () => {
      const p1 = writeFixture("stream-odd-par-a.bin", makeBuffer(917391, 1));
      const p2 = writeFixture("stream-odd-par-b.bin", makeBuffer(999, 2));
      const p3 = writeFixture("stream-odd-par-c.bin", makeBuffer(13, 3));
      const s1 = new XxHash128Stream();
      await s1.addFilesParallel([p1, p2, p3]);
      const s2 = new XxHash128Stream();
      await s2.addFilesParallel([p1, p2, p3]);
      expect(hex(s1.digest())).toBe(hex(s2.digest()));
    });
  });
});
