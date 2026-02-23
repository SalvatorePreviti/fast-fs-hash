/**
 * Tests for digestBuffer, digestBufferTo,
 * digestBufferRange, and digestBufferRangeTo.
 *
 * Key boundaries tested:
 * - Empty buffer (0 bytes)
 * - Tiny buffer (1 byte)
 * - Just under 128 KiB internal buffer boundary (131071)
 * - Exactly 128 KiB internal buffer boundary (131072)
 * - Just over 128 KiB internal buffer boundary (131073)
 * - Multi-chunk: 2x BUF_SIZE (262144)
 * - Large: 4x BUF_SIZE + 1 (524289)
 * - Uint8Array vs Buffer inputs
 */

import { describe, expect, it } from "vitest";
import { ALL_BACKENDS, hex, makeBuffer, setupFixtures } from "./_helpers_new";

setupFixtures("digest-buffer");

const BUF = 131072;

// --- Known xxHash3-128 digests (seed 0,0) --------------------------------

const H_EMPTY = "99aa06d3014798d86001c324468d497f";
const H_1BYTE_42 = "14c9ae9594c463c479d03016b7aeed0d";
const H_254 = "5f1c718471269aa13293277bc8e5839a";
const H_255 = "5914868aa80541d9b85fd37a0a050e63";
const H_256 = "f1f8a93f50849ac39408a4433b952d71";
const H_BUF_MINUS1 = "0d8bc9f7c7a0ad547a1a6df4c883b693";
const H_BUF_EXACT = "9507b6f5073d831d8e707008b17e014c";
const H_BUF_PLUS1 = "e4068c0fc25b3c45e39ce30528538126";
const H_BUF_2X = "63637e9b9c5891c0f34cc5c9153c3287";
const H_BUF_4X1 = "22c665e0fa317195cd1d43623c23c019";
const H_1MB = "1b208d2839093774d36c0e13a3df139e";
const H_BUF_PLUS100 = "ea10aa29167e65896886c9043af510ae";
const H_1024 = "83885e853bb6640ca870f92984398d22";
const H_500 = "56dd5682fe04888bc12fd3e43ffdd5a1";
const H_BUF_PLUS1000 = "36286707f949cd724aef9c62eec0ac09";
const H_RANGE_100_500 = "f4964d52ead1b021c53897805a28e34e";
const H_RANGE_CROSS = "c27981a9ea4e51af5f84717eaafbfa5d";
const H_RANGE_LARGE = "89974b04913831eb8774f68f13fec493";
const H_RANGE2048_100_500 = "f4964d52ead1b021c53897805a28e34e";
const H_RANGE2048_0_1024 = "83885e853bb6640ca870f92984398d22";
const H_7 = "61ce291bc3a4357ddbb207821e6d5efe";
const H_13 = "ae92e123e9472408bd795526190266c0";
const H_999 = "822c6d736ac58a76637cd0146bdf4338";
const H_100003 = "413105646a84cefecfcb6bf006e7e27f";
const H_131073 = "e4068c0fc25b3c45e39ce30528538126";
const H_917391 = "87fc88d3eef31bfa70568c69183231d0";

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { digestBuffer, digestBufferRange, digestBufferRangeTo, digestBufferTo } = backend;

  // --- digestBuffer --------------------------------------------------------

  describe("digestBuffer", () => {
    it("empty buffer", () => {
      const result = digestBuffer(Buffer.alloc(0));
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("1 byte", () => {
      const result = digestBuffer(Buffer.from([42]));
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_1BYTE_42);
    });

    it("254 bytes", () => {
      expect(hex(digestBuffer(makeBuffer(254)))).toBe(H_254);
    });

    it("255 bytes", () => {
      expect(hex(digestBuffer(makeBuffer(255)))).toBe(H_255);
    });

    it("256 bytes", () => {
      expect(hex(digestBuffer(makeBuffer(256)))).toBe(H_256);
    });

    it("BUF_SIZE - 1 (131071 bytes)", () => {
      expect(hex(digestBuffer(makeBuffer(BUF - 1)))).toBe(H_BUF_MINUS1);
    });

    it("exactly BUF_SIZE (131072 bytes)", () => {
      expect(hex(digestBuffer(makeBuffer(BUF)))).toBe(H_BUF_EXACT);
    });

    it("BUF_SIZE + 1 (131073 bytes — triggers multi-chunk)", () => {
      expect(hex(digestBuffer(makeBuffer(BUF + 1)))).toBe(H_BUF_PLUS1);
    });

    it("2x BUF_SIZE (262144 bytes)", () => {
      expect(hex(digestBuffer(makeBuffer(BUF * 2)))).toBe(H_BUF_2X);
    });

    it("4x BUF_SIZE + 1 (524289 bytes)", () => {
      expect(hex(digestBuffer(makeBuffer(BUF * 4 + 1)))).toBe(H_BUF_4X1);
    });

    it("1 MB (1048576 bytes)", () => {
      expect(hex(digestBuffer(makeBuffer(1048576)))).toBe(H_1MB);
    });

    it("7 bytes (odd prime)", () => {
      expect(hex(digestBuffer(makeBuffer(7)))).toBe(H_7);
    });

    it("13 bytes (odd prime)", () => {
      expect(hex(digestBuffer(makeBuffer(13)))).toBe(H_13);
    });

    it("999 bytes (odd)", () => {
      expect(hex(digestBuffer(makeBuffer(999)))).toBe(H_999);
    });

    it("100003 bytes (odd prime > READ_BUF_SIZE)", () => {
      expect(hex(digestBuffer(makeBuffer(100003)))).toBe(H_100003);
    });

    it("131073 bytes (2xREAD_BUF + 1, odd)", () => {
      expect(hex(digestBuffer(makeBuffer(131073)))).toBe(H_131073);
    });

    it("917391 bytes (large odd)", () => {
      expect(hex(digestBuffer(makeBuffer(917391)))).toBe(H_917391);
    });

    it("Uint8Array (not Buffer) input", () => {
      const buf = makeBuffer(BUF + 100);
      const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      expect(hex(digestBuffer(arr))).toBe(H_BUF_PLUS100);
    });

    it("Uint8Array with non-zero byteOffset", () => {
      const backing = new ArrayBuffer(BUF + 100);
      const fullView = Buffer.from(backing);
      for (let i = 0; i < fullView.length; i++) {
        fullView[i] = (i * 7 + 3) & 0xff;
      }
      const slice = new Uint8Array(backing, 50, BUF);
      const result = digestBuffer(slice);
      const equivalent = Buffer.from(backing, 50, BUF);
      expect(hex(result)).toBe(hex(digestBuffer(equivalent)));
    });
  });

  // --- digestBufferTo ------------------------------------------------------

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

    it("large buffer (> BUF_SIZE)", () => {
      const out = Buffer.alloc(16);
      digestBufferTo(makeBuffer(BUF + 1000), out);
      expect(hex(out)).toBe(H_BUF_PLUS1000);
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

  // --- digestBufferRange ---------------------------------------------------

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

    it("offset at end, length 0", () => {
      expect(hex(digestBufferRange(makeBuffer(BUF), BUF, 0))).toBe(H_EMPTY);
    });

    it("range crossing BUF_SIZE boundary", () => {
      expect(hex(digestBufferRange(makeBuffer(BUF * 2), BUF - 100, 200))).toBe(H_RANGE_CROSS);
    });

    it("range larger than BUF_SIZE", () => {
      expect(hex(digestBufferRange(makeBuffer(BUF * 3), 100, BUF + 500))).toBe(H_RANGE_LARGE);
    });
  });

  // --- digestBufferRangeTo -------------------------------------------------

  describe("digestBufferRangeTo", () => {
    it("writes range digest at offset 0", () => {
      const out = Buffer.alloc(16);
      digestBufferRangeTo(makeBuffer(2048), 100, 500, out);
      expect(hex(out)).toBe(H_RANGE2048_100_500);
    });

    it("full range equals digestBufferRange", () => {
      const out = Buffer.alloc(16);
      digestBufferRangeTo(makeBuffer(2048), 0, 1024, out);
      expect(hex(out)).toBe(H_RANGE2048_0_1024);
    });

    it("writes at custom output offset", () => {
      const out = Buffer.alloc(32);
      digestBufferRangeTo(makeBuffer(2048), 0, 1024, out, 10);
      expect(out.subarray(0, 10).every((b) => b === 0)).toBe(true);
      expect(hex(out.subarray(10, 26))).toBe(H_RANGE2048_0_1024);
    });

    it("writes at offset 0 same as default", () => {
      const out1 = Buffer.alloc(16);
      const out2 = Buffer.alloc(16);
      digestBufferRangeTo(makeBuffer(2048), 100, 500, out1);
      digestBufferRangeTo(makeBuffer(2048), 100, 500, out2, 0);
      expect(hex(out1)).toBe(hex(out2));
    });
  });
});
