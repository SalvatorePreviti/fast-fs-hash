import { hashesToHexArray, hashToHex } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

describe("hashToHex", () => {
  it("converts 16 zero bytes to 32 hex zeros", () => {
    const hash = new Uint8Array(16);
    expect(hashToHex(hash)).toBe("00000000000000000000000000000000");
  });

  it("converts known bytes to expected hex", () => {
    const hash = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
    ]);
    expect(hashToHex(hash)).toBe("0123456789abcdeffedcba9876543210");
  });

  it("converts all 0xff bytes", () => {
    const hash = new Uint8Array(16).fill(0xff);
    expect(hashToHex(hash)).toBe("ffffffffffffffffffffffffffffffff");
  });

  it("matches Buffer.toString('hex') for random data", () => {
    const hash = Buffer.from([
      0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    ]);
    expect(hashToHex(hash)).toBe(hash.toString("hex"));
  });

  it("supports offset parameter", () => {
    const buf = new Uint8Array(20).fill(0);
    buf.set([0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44], 4);
    expect(hashToHex(buf, 4)).toBe("abcdef01234567899abcdef011223344");
  });

  it("returns lowercase hex", () => {
    const hash = new Uint8Array([
      0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const hex = hashToHex(hash);
    expect(hex).toBe(hex.toLowerCase());
    expect(hex.startsWith("abcdef")).toBe(true);
  });

  it("throws when offset points outside available 16 bytes", () => {
    const hash = new Uint8Array(16);
    expect(() => hashToHex(hash, 1)).toThrow(RangeError);
    expect(() => hashToHex(hash, -1)).toThrow(RangeError);
    expect(() => hashToHex(hash, 0.5)).toThrow(RangeError);
  });
});

describe("hashesToHexArray", () => {
  it("throws when length is not a multiple of 16", () => {
    expect(() => hashesToHexArray(new Uint8Array(1))).toThrow(RangeError);
    expect(() => hashesToHexArray(new Uint8Array(17))).toThrow(RangeError);
  });

  it("returns empty array for empty input", () => {
    expect(hashesToHexArray(new Uint8Array(0))).toEqual([]);
  });
});
