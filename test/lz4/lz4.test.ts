import {
  lz4CompressBlock,
  lz4CompressBlockAsync,
  lz4CompressBlockTo,
  lz4CompressBound,
  lz4DecompressBlock,
  lz4DecompressBlockAsync,
  lz4DecompressBlockTo,
} from "fast-fs-hash";
import { describe, expect, it } from "vitest";

describe("LZ4 block compression", () => {
  const testData = Buffer.from("Hello, LZ4 compression! This is a test string that should compress well. ".repeat(100));

  describe("lz4CompressBound", () => {
    it("returns positive value for valid input size", () => {
      expect(lz4CompressBound(1024)).toBeGreaterThan(0);
    });

    it("returns 0 for oversized input", () => {
      expect(lz4CompressBound(0x80000000)).toBe(0);
    });

    it("returns bound >= input size", () => {
      expect(lz4CompressBound(100)).toBeGreaterThanOrEqual(100);
    });
  });

  describe("lz4CompressBlock / lz4DecompressBlock", () => {
    it("round-trips data correctly", () => {
      const compressed = lz4CompressBlock(testData);
      expect(compressed.length).toBeGreaterThan(0);
      expect(compressed.length).toBeLessThan(testData.length);

      const decompressed = lz4DecompressBlock(compressed, testData.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("handles empty input", () => {
      const compressed = lz4CompressBlock(Buffer.alloc(0));
      expect(compressed.length).toBe(0);

      const decompressed = lz4DecompressBlock(compressed, 0);
      expect(decompressed.length).toBe(0);
    });

    it("handles small input (1 byte)", () => {
      const input = Buffer.from([0x42]);
      const compressed = lz4CompressBlock(input);
      const decompressed = lz4DecompressBlock(compressed, 1);
      expect(Buffer.from(decompressed)).toEqual(input);
    });

    it("handles incompressible data", () => {
      const random = Buffer.alloc(1024);
      for (let i = 0; i < random.length; i++) {
        random[i] = Math.floor(Math.random() * 256);
      }
      const compressed = lz4CompressBlock(random);
      const decompressed = lz4DecompressBlock(compressed, random.length);
      expect(Buffer.from(decompressed)).toEqual(random);
    });

    it("throws on corrupt compressed data", () => {
      const garbage = Buffer.from([1, 2, 3, 4, 5]);
      expect(() => lz4DecompressBlock(garbage, 100)).toThrow();
    });

    it("throws on wrong uncompressed size", () => {
      const compressed = lz4CompressBlock(testData);
      expect(() => lz4DecompressBlock(compressed, testData.length + 1)).toThrow();
    });
  });

  describe("range variants (offset/length)", () => {
    it("compresses a subrange of input", () => {
      const full = Buffer.from("AAAA" + "Hello LZ4!".repeat(50) + "BBBB");
      const offset = 4;
      const length = full.length - 8;

      const compressed = lz4CompressBlock(full, offset, length);
      const decompressed = lz4DecompressBlock(compressed, length);
      expect(Buffer.from(decompressed)).toEqual(full.subarray(offset, offset + length));
    });

    it("decompresses from a subrange of compressed buffer", () => {
      const compressed = lz4CompressBlock(testData);
      const padded = Buffer.alloc(10 + compressed.length + 10);
      compressed.copy(padded, 10);

      const decompressed = lz4DecompressBlock(padded, testData.length, 10, compressed.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("throws on offset exceeding buffer", () => {
      expect(() => lz4CompressBlock(Buffer.alloc(10), 20)).toThrow(/offset/i);
    });

    it("throws on offset + length exceeding buffer", () => {
      expect(() => lz4CompressBlock(Buffer.alloc(10), 5, 10)).toThrow(/offset.*length|length.*buffer/i);
    });
  });

  describe("lz4CompressBlockTo / lz4DecompressBlockTo", () => {
    it("compresses into pre-allocated buffer", () => {
      const bound = lz4CompressBound(testData.length);
      const output = Buffer.alloc(bound);
      const bytesWritten = lz4CompressBlockTo(testData, output);
      expect(bytesWritten).toBeGreaterThan(0);
      expect(bytesWritten).toBeLessThanOrEqual(bound);

      const compressed = output.subarray(0, bytesWritten);
      const decompressed = lz4DecompressBlock(compressed, testData.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("compresses with outputOffset", () => {
      const offset = 16;
      const bound = lz4CompressBound(testData.length);
      const output = Buffer.alloc(offset + bound);
      const bytesWritten = lz4CompressBlockTo(testData, output, offset);
      expect(bytesWritten).toBeGreaterThan(0);

      const compressed = output.subarray(offset, offset + bytesWritten);
      const decompressed = lz4DecompressBlock(compressed, testData.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("compresses with inputOffset + inputLength", () => {
      const sub = testData.subarray(10, 200);
      const bound = lz4CompressBound(sub.length);
      const output = Buffer.alloc(bound);
      const bytesWritten = lz4CompressBlockTo(testData, output, 0, 10, 190);
      expect(bytesWritten).toBeGreaterThan(0);

      const decompressed = lz4DecompressBlock(output.subarray(0, bytesWritten), 190);
      expect(Buffer.from(decompressed)).toEqual(sub);
    });

    it("decompresses into pre-allocated buffer", () => {
      const compressed = lz4CompressBlock(testData);
      const output = Buffer.alloc(testData.length);
      const bytesWritten = lz4DecompressBlockTo(compressed, testData.length, output);
      expect(bytesWritten).toBe(testData.length);
      expect(output).toEqual(testData);
    });

    it("decompresses with outputOffset", () => {
      const offset = 32;
      const compressed = lz4CompressBlock(testData);
      const output = Buffer.alloc(offset + testData.length);
      const bytesWritten = lz4DecompressBlockTo(compressed, testData.length, output, offset);
      expect(bytesWritten).toBe(testData.length);
      expect(output.subarray(offset, offset + testData.length)).toEqual(testData);
    });

    it("throws on output buffer too small", () => {
      const output = Buffer.alloc(1);
      expect(() => lz4CompressBlockTo(testData, output)).toThrow();
    });

    it("throws on outputOffset exceeding buffer", () => {
      const output = Buffer.alloc(100);
      expect(() => lz4CompressBlockTo(testData, output, 200)).toThrow(/offset/i);
    });

    it("throws on uncompressedSize exceeding output space", () => {
      const compressed = lz4CompressBlock(testData);
      const output = Buffer.alloc(10);
      expect(() => lz4DecompressBlockTo(compressed, testData.length, output)).toThrow();
    });
  });

  describe("async variants", () => {
    it("lz4CompressBlockAsync round-trips", async () => {
      const compressed = await lz4CompressBlockAsync(testData);
      expect(compressed.length).toBeGreaterThan(0);

      const decompressed = lz4DecompressBlock(compressed, testData.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("lz4DecompressBlockAsync round-trips", async () => {
      const compressed = lz4CompressBlock(testData);
      const decompressed = await lz4DecompressBlockAsync(compressed, testData.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("async handles empty input", async () => {
      const compressed = await lz4CompressBlockAsync(Buffer.alloc(0));
      expect(compressed.length).toBe(0);
    });

    it("full async round-trip", async () => {
      const compressed = await lz4CompressBlockAsync(testData);
      const decompressed = await lz4DecompressBlockAsync(compressed, testData.length);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it("async with offset/length range", async () => {
      const sub = testData.subarray(100, 500);
      const compressed = await lz4CompressBlockAsync(testData, 100, 400);
      const decompressed = lz4DecompressBlock(compressed, 400);
      expect(Buffer.from(decompressed)).toEqual(sub);
    });
  });
});
