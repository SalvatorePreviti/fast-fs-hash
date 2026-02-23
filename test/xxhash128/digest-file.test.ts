/**
 * Tests for digestFile and digestFileTo.
 *
 * Key scenarios:
 * - Empty file
 * - Tiny file (1 byte)
 * - File exactly at 128 KiB internal buffer boundary
 * - File crossing 128 KiB internal buffer boundary
 * - File crossing 128 KiB read buffer boundary
 * - Large file (> 64 KiB)
 * - Nonexistent file rejects
 * - UTF-8 content file matches digestString
 */

import { describe, expect, it } from "vitest";
import { ALL_BACKENDS, hex, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("digest-file");

const BUF = 131072;
const READ_BUF = 131072;

// ─── Known xxHash3-128 digests (seed 0,0) ─────────────────────────────

const H_EMPTY = "99aa06d3014798d86001c324468d497f";
const H_0x42 = "9d1b9bc4078a3e7274d3766ca02423f3";
const H_BUF_MINUS1 = "0d8bc9f7c7a0ad547a1a6df4c883b693";
const H_BUF_EXACT = "9507b6f5073d831d8e707008b17e014c";
const H_BUF_PLUS1 = "e4068c0fc25b3c45e39ce30528538126";
const H_READ_MINUS1 = "0d8bc9f7c7a0ad547a1a6df4c883b693";
const H_READ_EXACT = "9507b6f5073d831d8e707008b17e014c";
const H_READ_PLUS1 = "e4068c0fc25b3c45e39ce30528538126";
const H_READ_2X = "63637e9b9c5891c0f34cc5c9153c3287";
const H_READ_2X_PLUS1 = "efb397350a56b59f115670d6321903af";
const H_5000 = "7a681524919c28221b74bda2c82a8c7a";
const H_HELLO_WORLD_LF = "eefac9d87100cd1336b2e733a5484425";
const H_1024 = "83885e853bb6640ca870f92984398d22";
const H_512 = "111d5771df64cbcb1059105ad19bfa09";
const H_254 = "5f1c718471269aa13293277bc8e5839a";
const H_255 = "5914868aa80541d9b85fd37a0a050e63";
const H_256 = "f1f8a93f50849ac39408a4433b952d71";
const H_1MB = "1b208d2839093774d36c0e13a3df139e";
const H_READ_PLUS5000 = "914fa5ed8dad876a19a51d949704c197";
const H_917391 = "87fc88d3eef31bfa70568c69183231d0";
const H_100003 = "413105646a84cefecfcb6bf006e7e27f";
const H_999 = "822c6d736ac58a76637cd0146bdf4338";
const H_7 = "61ce291bc3a4357ddbb207821e6d5efe";
const H_13 = "ae92e123e9472408bd795526190266c0";

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { digestFile, digestFileTo } = backend;

  // ─── digestFile ───────────────────────────────────────────────────────

  describe("digestFile", () => {
    it("empty file", async () => {
      const path = writeFixture("empty.bin", Buffer.alloc(0));
      const result = await digestFile(path);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("1-byte file", async () => {
      const path = writeFixture("one-byte.bin", Buffer.from([0x42]));
      const result = await digestFile(path);
      expect(hex(result)).toBe(H_0x42);
    });

    it("254-byte file", async () => {
      const path = writeFixture("254.bin", makeBuffer(254));
      expect(hex(await digestFile(path))).toBe(H_254);
    });

    it("255-byte file", async () => {
      const path = writeFixture("255.bin", makeBuffer(255));
      expect(hex(await digestFile(path))).toBe(H_255);
    });

    it("256-byte file", async () => {
      const path = writeFixture("256.bin", makeBuffer(256));
      expect(hex(await digestFile(path))).toBe(H_256);
    });

    it(`file exactly BUF_SIZE bytes (${BUF})`, async () => {
      const path = writeFixture("exact-buf.bin", makeBuffer(BUF));
      expect(hex(await digestFile(path))).toBe(H_BUF_EXACT);
    });

    it(`file BUF_SIZE - 1 bytes (${BUF - 1})`, async () => {
      const path = writeFixture("buf-minus-1.bin", makeBuffer(BUF - 1));
      expect(hex(await digestFile(path))).toBe(H_BUF_MINUS1);
    });

    it(`file BUF_SIZE + 1 bytes (${BUF + 1})`, async () => {
      const path = writeFixture("buf-plus-1.bin", makeBuffer(BUF + 1));
      expect(hex(await digestFile(path))).toBe(H_BUF_PLUS1);
    });

    it(`file exactly READ_BUF_SIZE bytes (${READ_BUF})`, async () => {
      const path = writeFixture("exact-read-buf.bin", makeBuffer(READ_BUF));
      expect(hex(await digestFile(path))).toBe(H_READ_EXACT);
    });

    it(`file READ_BUF_SIZE - 1 bytes (${READ_BUF - 1})`, async () => {
      const path = writeFixture("read-buf-minus-1.bin", makeBuffer(READ_BUF - 1));
      expect(hex(await digestFile(path))).toBe(H_READ_MINUS1);
    });

    it(`file READ_BUF_SIZE + 1 bytes (${READ_BUF + 1}) — triggers second read`, async () => {
      const path = writeFixture("read-buf-plus-1.bin", makeBuffer(READ_BUF + 1));
      expect(hex(await digestFile(path))).toBe(H_READ_PLUS1);
    });

    it("large file (2× READ_BUF_SIZE)", async () => {
      const path = writeFixture("large-2x.bin", makeBuffer(READ_BUF * 2));
      expect(hex(await digestFile(path))).toBe(H_READ_2X);
    });

    it("large file (2× READ_BUF_SIZE + 1)", async () => {
      const path = writeFixture("large-2x-plus-1.bin", makeBuffer(READ_BUF * 2 + 1));
      expect(hex(await digestFile(path))).toBe(H_READ_2X_PLUS1);
    });

    it("1 MB file (1048576 bytes)", async () => {
      const path = writeFixture("1mb.bin", makeBuffer(1048576));
      expect(hex(await digestFile(path))).toBe(H_1MB);
    });

    it("7-byte file (odd prime)", async () => {
      const path = writeFixture("odd-7.bin", makeBuffer(7));
      expect(hex(await digestFile(path))).toBe(H_7);
    });

    it("13-byte file (odd prime)", async () => {
      const path = writeFixture("odd-13.bin", makeBuffer(13));
      expect(hex(await digestFile(path))).toBe(H_13);
    });

    it("999-byte file (odd)", async () => {
      const path = writeFixture("odd-999.bin", makeBuffer(999));
      expect(hex(await digestFile(path))).toBe(H_999);
    });

    it("100003-byte file (odd prime > READ_BUF_SIZE)", async () => {
      const path = writeFixture("odd-100003.bin", makeBuffer(100003));
      expect(hex(await digestFile(path))).toBe(H_100003);
    });

    it("917391-byte file (large odd)", async () => {
      const path = writeFixture("odd-917391.bin", makeBuffer(917391));
      expect(hex(await digestFile(path))).toBe(H_917391);
    });

    it("nonexistent file rejects", async () => {
      await expect(digestFile("/tmp/this-file-does-not-exist-at-all-12345.bin")).rejects.toThrow();
    });

    it("nonexistent nested path rejects", async () => {
      await expect(digestFile("/tmp/no/such/dir/file.bin")).rejects.toThrow();
    });

    it("UTF-8 text file matches digestString", async () => {
      const path = writeFixture("hello.txt", "hello world\n");
      expect(hex(await digestFile(path))).toBe(H_HELLO_WORLD_LF);
    });

    it("deterministic: hashing same file twice", async () => {
      const path = writeFixture("deterministic.bin", makeBuffer(5000));
      expect(hex(await digestFile(path))).toBe(H_5000);
      expect(hex(await digestFile(path))).toBe(H_5000);
    });
  });

  // ─── digestFileTo ─────────────────────────────────────────────────────

  describe("digestFileTo", () => {
    it("writes digest at offset 0", async () => {
      const path = writeFixture("to-offset0.bin", makeBuffer(1024));
      const out = Buffer.alloc(16);
      await digestFileTo(path, out);
      expect(hex(out)).toBe(H_1024);
    });

    it("writes at custom offset", async () => {
      const path = writeFixture("to-offset8.bin", makeBuffer(512));
      const out = Buffer.alloc(32);
      await digestFileTo(path, out, 10);
      expect(out.subarray(0, 10).every((b) => b === 0)).toBe(true);
      expect(hex(out.subarray(10, 26))).toBe(H_512);
    });

    it("nonexistent file rejects digestFileTo", async () => {
      const out = Buffer.alloc(16);
      await expect(digestFileTo("/tmp/no-such-file-xyz.bin", out)).rejects.toThrow();
    });

    it("empty file", async () => {
      const path = writeFixture("to-empty.bin", Buffer.alloc(0));
      const out = Buffer.alloc(16);
      await digestFileTo(path, out);
      expect(hex(out)).toBe(H_EMPTY);
    });

    it("large file (> READ_BUF_SIZE)", async () => {
      const path = writeFixture("to-large.bin", makeBuffer(READ_BUF + 5000));
      const out = Buffer.alloc(16);
      await digestFileTo(path, out);
      expect(hex(out)).toBe(H_READ_PLUS5000);
    });
  });
});
