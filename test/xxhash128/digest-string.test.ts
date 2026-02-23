/**
 * Tests for digestString and digestStringTo.
 *
 * String hashing edge cases:
 *
 * 1. **Guaranteed safe**: `len * 3 <= BUF_SIZE` → ≤ 43690 chars.
 *    Worst-case 3 bytes/char still fits in the 128 KiB I/O buffer.
 *
 * 2. **Optimistic**: `len <= BUF_SIZE - 100` (≤ 130972 chars).
 *    Writes directly; checks if the result was truncated.
 *    Falls through only when buffer.write returned BUF_SIZE (full).
 *
 * 3. **Fallback**: `Buffer.from(input, "utf-8")` + chunked feed.
 *
 * We test each tier boundary with ASCII, 2-byte UTF-8, and 3-byte UTF-8.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_BACKENDS,
  hex,
  make2ByteUtf8String,
  make3ByteUtf8String,
  makeAsciiString,
  setupFixtures,
} from "./_helpers_new";

setupFixtures("digest-string");

const BUF = 131072;
const TIER1_MAX = Math.floor(BUF / 3); // 43690
const FIRST_TIER2 = TIER1_MAX + 1; // 43691
const TIER2_MAX = BUF - 100; // 130972
const FIRST_TIER3 = TIER2_MAX + 1; // 130973

//  - Known xxHash3-128 digests (seed 0,0)

const H_EMPTY = "99aa06d3014798d86001c324468d497f";
const H_HELLO_WORLD = "df8d09e93f874900a99b8775cc15b6c7";
const H_DETERMINISTIC = "880b27bfb3d9ab19eb68ceb85a5c1ce8";
const H_ALPHA = "3da56ec08de5da93af92a1f85e52d146";
const H_BETA = "f19f3895086da42f5e80feea399a2d8b";
const H_X = "5c7401c0ec22eeeeeaf06c6480b2cd11";
const H_TEST = "6c78e0e3bd51d358d01e758642b85fb8";

// Tier 1 (TIER1_MAX = floor(131072/3) = 43690)
const H_ASCII_5461 = "97ebeba6c7982d297719e20eae8740c5";
const H_ASCII_5460 = "4e57ab22fd93c09e83d25172094a8c03";
const H_2BYTE_5461 = "40c3c5875c3047630f414f4ac864f26d";
const H_3BYTE_5461 = "14bfdfd751175d683e7669750b3ab109";

// Tier 1→2 boundary (FIRST_TIER2 = 43691)
const H_ASCII_5462 = "831ce0bd0362bc62f560c18358bd1d63";
const H_2BYTE_5462 = "565bc29ddb802eb37ace216eefb7cd1e";
const H_3BYTE_5462 = "cce4ee8204a534c2cb5a1f013bae85f2";

// Tier 2 (TIER2_MAX = 131072 - 100 = 130972)
const H_ASCII_130972 = "b7a7ab566c6fcf9391adff5ab4ece919";
const H_ASCII_130971 = "f763d6722a5271ff777efe23e8e33fbe";
const H_ASCII_10000 = "5fc5fdafeb6c5fec36fad77478f70559";
const H_2BYTE_130972 = "e774e76b8847e1662ab04c25330169c8";
const H_3BYTE_130972 = "013d09cb64140686fa15d1346fbfa5fc";
const H_2BYTE_65536 = "5ff5c23a586b9f255079208185dc0880";
const H_2BYTE_65537 = "77834640a698b2f7f381cb89cae715fb";

// Tier 2→3 boundary (FIRST_TIER3 = 130973)
const H_ASCII_130973 = "41c02a419f49245f9f6c260d5ea5d36c";
const H_ASCII_131072 = "1ff25b9594e26b43801dc92c920d3613";
const H_ASCII_131073 = "219f4950b1332d52bbb448db5f52a81f";

// Small sizes
const H_ASCII_254 = "58df957230780c41b0e224e24e436bda";
const H_ASCII_255 = "55bb86069950848a24fe8ef93b38a365";
const H_ASCII_256 = "3dd9e270172f1a25381d17a7d4a08a4c";

// Tier 3: fallback
const H_ASCII_262144 = "182fd139e32bc58466d9e371284875b0";
const H_ASCII_524289 = "4faa17e956879c27846deb0f14c4bc38";
const H_2BYTE_131072 = "2130365c3731bdc924464af55cde39f0";
const H_3BYTE_131072 = "49573a3d6ad74243c840efb4fa202029";
const H_3BYTE_262144 = "695523759dc6375963996c631c9e0b6b";
const H_ASCII_1MB = "b5af040bfc649af367dacca0235f8abe";

// Mixed
const H_MIXED1 = "ae1ed1d9e6589964ad6bb786fcd94764";
const H_MIXED2 = "ca49a451a1fb3a29cf30e2f3a02dd38b";
const H_MIXED3 = "bacc3917f3a5c8e7423f5dce9838dfe0";

//  - All backends

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { digestString, digestStringTo } = backend;

  //  - digestString basic

  describe("digestString", () => {
    it("empty string", () => {
      const result = digestString("");
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("short ASCII string", () => {
      const result = digestString("hello world");
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_HELLO_WORLD);
    });

    it("254-char ASCII string", () => {
      expect(hex(digestString(makeAsciiString(254)))).toBe(H_ASCII_254);
    });

    it("255-char ASCII string", () => {
      expect(hex(digestString(makeAsciiString(255)))).toBe(H_ASCII_255);
    });

    it("256-char ASCII string", () => {
      expect(hex(digestString(makeAsciiString(256)))).toBe(H_ASCII_256);
    });

    it("deterministic: same string → same hash", () => {
      expect(hex(digestString("deterministic"))).toBe(H_DETERMINISTIC);
      expect(hex(digestString("deterministic"))).toBe(H_DETERMINISTIC);
    });

    it("different strings → different hashes", () => {
      expect(hex(digestString("alpha"))).toBe(H_ALPHA);
      expect(hex(digestString("beta"))).toBe(H_BETA);
    });
  });

  //  - Tier 1: guaranteed safe (len * 3 <= BUF_SIZE)

  describe("tier 1: guaranteed safe (len * 3 <= BUF_SIZE)", () => {
    it(`ASCII string at tier 1 max (${TIER1_MAX} chars)`, () => {
      expect(hex(digestString(makeAsciiString(TIER1_MAX)))).toBe(H_ASCII_5461);
    });

    it("1 char", () => {
      expect(hex(digestString("x"))).toBe(H_X);
    });

    it(`ASCII string at tier 1 max - 1 (${TIER1_MAX - 1} chars)`, () => {
      expect(hex(digestString(makeAsciiString(TIER1_MAX - 1)))).toBe(H_ASCII_5460);
    });

    it(`2-byte UTF-8 at tier 1 max (${TIER1_MAX} chars = ${TIER1_MAX * 2} bytes)`, () => {
      const s = make2ByteUtf8String(TIER1_MAX);
      expect(Buffer.byteLength(s, "utf-8")).toBe(TIER1_MAX * 2);
      expect(hex(digestString(s))).toBe(H_2BYTE_5461);
    });

    it(`3-byte UTF-8 at tier 1 max (${TIER1_MAX} chars = ${TIER1_MAX * 3} bytes)`, () => {
      const s = make3ByteUtf8String(TIER1_MAX);
      expect(Buffer.byteLength(s, "utf-8")).toBe(TIER1_MAX * 3);
      expect(hex(digestString(s))).toBe(H_3BYTE_5461);
    });
  });

  //  - Tier 1→2 boundary (len * 3 crosses BUF_SIZE)

  describe("tier 1→2 boundary", () => {
    it(`ASCII string at ${FIRST_TIER2} chars (first tier 2 length)`, () => {
      expect(hex(digestString(makeAsciiString(FIRST_TIER2)))).toBe(H_ASCII_5462);
    });

    it(`2-byte UTF-8 at ${FIRST_TIER2} chars (${FIRST_TIER2 * 2} bytes)`, () => {
      expect(hex(digestString(make2ByteUtf8String(FIRST_TIER2)))).toBe(H_2BYTE_5462);
    });

    it(`3-byte UTF-8 at ${FIRST_TIER2} chars (${FIRST_TIER2 * 3} bytes > BUF_SIZE)`, () => {
      expect(hex(digestString(make3ByteUtf8String(FIRST_TIER2)))).toBe(H_3BYTE_5462);
    });
  });

  //  - Tier 2: optimistic (len <= BUF_SIZE - 100)

  describe("tier 2: optimistic (len <= BUF_SIZE - 100)", () => {
    it(`ASCII string at tier 2 max (${TIER2_MAX} chars)`, () => {
      expect(hex(digestString(makeAsciiString(TIER2_MAX)))).toBe(H_ASCII_130972);
    });

    it(`ASCII string at tier 2 max - 1`, () => {
      expect(hex(digestString(makeAsciiString(TIER2_MAX - 1)))).toBe(H_ASCII_130971);
    });

    it("medium ASCII that fills most of the buffer", () => {
      expect(hex(digestString(makeAsciiString(10000)))).toBe(H_ASCII_10000);
    });

    it(`2-byte UTF-8 at tier 2 max chars (${TIER2_MAX * 2} bytes > BUF_SIZE)`, () => {
      const s = make2ByteUtf8String(TIER2_MAX);
      expect(hex(digestString(s))).toBe(H_2BYTE_130972);
    });

    it(`3-byte UTF-8 at tier 2 max chars (${TIER2_MAX * 3} bytes)`, () => {
      expect(hex(digestString(make3ByteUtf8String(TIER2_MAX)))).toBe(H_3BYTE_130972);
    });

    it("2-byte UTF-8: just enough chars to fill buffer exactly", () => {
      const charCount = BUF / 2; // 65536 chars → 131072 bytes
      const s = make2ByteUtf8String(charCount);
      expect(Buffer.byteLength(s, "utf-8")).toBe(BUF);
      expect(hex(digestString(s))).toBe(H_2BYTE_65536);
    });

    it("2-byte UTF-8: one char over exact fill", () => {
      const charCount = BUF / 2 + 1; // 65537 chars → 131074 bytes
      const s = make2ByteUtf8String(charCount);
      expect(Buffer.byteLength(s, "utf-8")).toBe(BUF + 2);
      expect(hex(digestString(s))).toBe(H_2BYTE_65537);
    });
  });

  //  - Tier 2→3 boundary (len > BUF_SIZE - 100)

  describe("tier 2→3 boundary (fallback)", () => {
    it(`ASCII string at ${FIRST_TIER3} chars (first fallback length)`, () => {
      expect(hex(digestString(makeAsciiString(FIRST_TIER3)))).toBe(H_ASCII_130973);
    });

    it(`ASCII at exactly BUF_SIZE chars (${BUF})`, () => {
      expect(hex(digestString(makeAsciiString(BUF)))).toBe(H_ASCII_131072);
    });

    it(`ASCII at BUF_SIZE + 1 chars (${BUF + 1})`, () => {
      expect(hex(digestString(makeAsciiString(BUF + 1)))).toBe(H_ASCII_131073);
    });
  });

  //  - Tier 3: fallback (large strings)

  describe("tier 3: fallback (large strings)", () => {
    it("ASCII string 2× BUF_SIZE", () => {
      expect(hex(digestString(makeAsciiString(BUF * 2)))).toBe(H_ASCII_262144);
    });

    it("ASCII string 4× BUF_SIZE + 1", () => {
      expect(hex(digestString(makeAsciiString(BUF * 4 + 1)))).toBe(H_ASCII_524289);
    });

    it("ASCII string 1 MB (1048576 chars)", () => {
      expect(hex(digestString(makeAsciiString(1048576)))).toBe(H_ASCII_1MB);
    });

    it("2-byte UTF-8 large (BUF_SIZE chars = 2× BUF_SIZE bytes)", () => {
      const s = make2ByteUtf8String(BUF);
      expect(Buffer.byteLength(s, "utf-8")).toBe(BUF * 2);
      expect(hex(digestString(s))).toBe(H_2BYTE_131072);
    });

    it("3-byte UTF-8 large (BUF_SIZE chars = 3× BUF_SIZE bytes)", () => {
      const s = make3ByteUtf8String(BUF);
      expect(Buffer.byteLength(s, "utf-8")).toBe(BUF * 3);
      expect(hex(digestString(s))).toBe(H_3BYTE_131072);
    });

    it("3-byte UTF-8 very large (2× BUF_SIZE chars = 6× BUF_SIZE bytes)", () => {
      const s = make3ByteUtf8String(BUF * 2);
      expect(Buffer.byteLength(s, "utf-8")).toBe(BUF * 6);
      expect(hex(digestString(s))).toBe(H_3BYTE_262144);
    });
  });

  //  - Mixed content

  describe("mixed UTF-8 content", () => {
    it("mixed ASCII + 2-byte + 3-byte chars", () => {
      const s = "Hello " + make2ByteUtf8String(100) + " World " + make3ByteUtf8String(100) + " End";
      expect(hex(digestString(s))).toBe(H_MIXED1);
    });

    it("large mixed string exceeding BUF_SIZE in bytes", () => {
      const s = makeAsciiString(3000) + make2ByteUtf8String(3000) + make3ByteUtf8String(3000);
      expect(hex(digestString(s))).toBe(H_MIXED2);
    });

    it("string where char count < BUF_SIZE but byte count > BUF_SIZE", () => {
      const s = make3ByteUtf8String(6000);
      // 6000 chars, 18000 UTF-8 bytes — hash is deterministic regardless of BUF
      expect(hex(digestString(s))).toBe(H_MIXED3);
    });
  });

  //  - digestStringTo

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

    it("large 3-byte UTF-8 string (fallback path)", () => {
      const out = Buffer.alloc(16);
      digestStringTo(make3ByteUtf8String(BUF), out);
      expect(hex(out)).toBe(H_3BYTE_131072);
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
});
