/**
 * Tests for static hashFile, instance hashFile, and cross-implementation
 * hashFile compatibility.
 */

import path from "node:path";
import { XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

import {
  fileA,
  fileB,
  fileEmpty,
  fixturesDir,
  H_EMPTY,
  H_GOODBYE_WORLD_LF,
  H_HELLO_WORLD_LF,
  HF_A_SALT_MYSALT,
  HF_A_SALT_MYSALT_SEED_MAX,
  HF_A_SALT_MYSALT_SEED42,
  HF_A_SEED_0_42,
  HF_A_SEED_42_0,
  HF_A_SEED_123_456,
  HF_B_SEED_42_0,
  HF_BINARY_SALT_1234,
  implementations,
  setupXXHash128Fixtures,
} from "./_helpers";

setupXXHash128Fixtures("file");

//  - Static hashFile

describe.each(implementations)("%s — static hashFile", (_name, Hasher) => {
  //  - Basic usage

  it("returns correct 16-byte Buffer for a.txt", async () => {
    const result = await Hasher.hashFile(fileA());
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
    expect(result.toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("returns correct hash for b.txt", async () => {
    const result = await Hasher.hashFile(fileB());
    expect(result.toString("hex")).toBe(H_GOODBYE_WORLD_LF);
  });

  it("returns correct hash for empty file", async () => {
    const result = await Hasher.hashFile(fileEmpty());
    expect(result.toString("hex")).toBe(H_EMPTY);
  });

  //  - Output buffer

  it("writes into pre-allocated Buffer", async () => {
    const buf = Buffer.alloc(32);
    await Hasher.hashFileTo(fileA(), buf);
    expect(buf.subarray(0, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("writes into pre-allocated Uint8Array", async () => {
    const buf = new Uint8Array(32);
    await Hasher.hashFileTo(fileA(), buf);
    expect(Buffer.from(buf.buffer, buf.byteOffset, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("writes at specified offset", async () => {
    const buf = Buffer.alloc(64);
    await Hasher.hashFileTo(fileA(), buf, 10);
    expect(buf.subarray(10, 26).toString("hex")).toBe(H_HELLO_WORLD_LF);
    expect(buf.subarray(0, 10).every((b) => b === 0)).toBe(true);
    expect(buf.subarray(26, 64).every((b) => b === 0)).toBe(true);
  });

  it("writes at end of buffer (exact fit)", async () => {
    const buf = Buffer.alloc(20);
    await Hasher.hashFileTo(fileA(), buf, 4);
    expect(buf.subarray(4, 20).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  //  - Seed support

  it("seedLow changes digest", async () => {
    const result = await Hasher.hashFile(fileA(), 42);
    expect(result.toString("hex")).toBe(HF_A_SEED_42_0);
  });

  it("seedHigh changes digest", async () => {
    const result = await Hasher.hashFile(fileA(), 0, 42);
    expect(result.toString("hex")).toBe(HF_A_SEED_0_42);
  });

  it("both seed parts produce correct digest", async () => {
    const result = await Hasher.hashFile(fileA(), 123, 456);
    expect(result.toString("hex")).toBe(HF_A_SEED_123_456);
  });

  it("seeded writeback into output buffer", async () => {
    const buf = Buffer.alloc(32);
    await Hasher.hashFileTo(fileA(), buf, 8, 42);
    expect(buf.subarray(8, 24).toString("hex")).toBe(HF_A_SEED_42_0);
  });

  it("seed with b.txt", async () => {
    const result = await Hasher.hashFile(fileB(), 42);
    expect(result.toString("hex")).toBe(HF_B_SEED_42_0);
  });

  //  - Salt support

  it("salt changes digest", async () => {
    const salt = Buffer.from("mysalt");
    const result = await Hasher.hashFile(fileA(), 0, 0, salt);
    expect(result.toString("hex")).toBe(HF_A_SALT_MYSALT);
    const noSalt = await Hasher.hashFile(fileA());
    expect(noSalt.toString("hex")).not.toBe(result.toString("hex"));
  });

  it("salt + seed combined", async () => {
    const salt = Buffer.from("mysalt");
    const result = await Hasher.hashFile(fileA(), 42, 0, salt);
    expect(result.toString("hex")).toBe(HF_A_SALT_MYSALT_SEED42);
  });

  it("salt + seed max", async () => {
    const salt = Buffer.from("mysalt");
    const result = await Hasher.hashFile(fileA(), 0xffffffff, 0xffffffff, salt);
    expect(result.toString("hex")).toBe(HF_A_SALT_MYSALT_SEED_MAX);
  });

  it("binary salt with binary file", async () => {
    const binaryFile = path.join(fixturesDir(), "..", "fixtures/hash-fixture/binary.bin");
    const salt = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const result = await Hasher.hashFile(binaryFile, 0, 0, salt);
    expect(result.toString("hex")).toBe(HF_BINARY_SALT_1234);
  });

  it("empty salt produces same result as no salt", async () => {
    const noSalt = await Hasher.hashFile(fileA());
    const emptySalt = await Hasher.hashFile(fileA(), 0, 0, Buffer.alloc(0));
    expect(emptySalt.toString("hex")).toBe(noSalt.toString("hex"));
  });

  it("undefined salt produces same result as no salt", async () => {
    const noSalt = await Hasher.hashFile(fileA());
    const undefSalt = await Hasher.hashFile(fileA(), 0, 0, undefined);
    expect(undefSalt.toString("hex")).toBe(noSalt.toString("hex"));
  });

  it("salt into output buffer with offset", async () => {
    const buf = Buffer.alloc(48);
    const salt = Buffer.from("mysalt");
    await Hasher.hashFileTo(fileA(), buf, 16, 0, 0, salt);
    expect(buf.subarray(16, 32).toString("hex")).toBe(HF_A_SALT_MYSALT);
  });

  //  - Determinism

  it("produces identical results on repeated calls", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => Hasher.hashFile(fileA())));
    for (const r of results) {
      expect(r.toString("hex")).toBe(H_HELLO_WORLD_LF);
    }
  });

  it("concurrent calls return correct independent results", async () => {
    const [a, b, empty] = await Promise.all([
      Hasher.hashFile(fileA()),
      Hasher.hashFile(fileB()),
      Hasher.hashFile(fileEmpty()),
    ]);
    expect(a.toString("hex")).toBe(H_HELLO_WORLD_LF);
    expect(b.toString("hex")).toBe(H_GOODBYE_WORLD_LF);
    expect(empty.toString("hex")).toBe(H_EMPTY);
  });

  //  - Error handling

  it("rejects for non-existent file", async () => {
    await expect(Hasher.hashFile("/no/such/file.txt")).rejects.toThrow();
  });

  it("rejects for directory path", async () => {
    await expect(Hasher.hashFile(fixturesDir())).rejects.toThrow();
  });
});

//  - Instance hashFile

describe.each(implementations)("%s — instance hashFile", (_name, Hasher) => {
  it("returns correct 16-byte Buffer for a.txt (seed 0)", async () => {
    const h = new Hasher();
    const result = await h.hashFile(fileA());
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
    expect(result.toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("returns correct hash for b.txt", async () => {
    const h = new Hasher();
    const result = await h.hashFile(fileB());
    expect(result.toString("hex")).toBe(H_GOODBYE_WORLD_LF);
  });

  it("returns correct hash for empty file", async () => {
    const h = new Hasher();
    const result = await h.hashFile(fileEmpty());
    expect(result.toString("hex")).toBe(H_EMPTY);
  });

  it("uses the instance seed", async () => {
    const h = new Hasher(42, 0);
    const result = await h.hashFile(fileA());
    expect(result.toString("hex")).toBe(HF_A_SEED_42_0);
  });

  it("different seedHigh via instance", async () => {
    const h = new Hasher(0, 42);
    const result = await h.hashFile(fileA());
    expect(result.toString("hex")).toBe(HF_A_SEED_0_42);
  });

  it("writes into output buffer", async () => {
    const h = new Hasher();
    const buf = Buffer.alloc(32);
    await h.hashFileTo(fileA(), buf);
    expect(buf.subarray(0, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("writes at offset into output buffer", async () => {
    const h = new Hasher();
    const buf = Buffer.alloc(64);
    await h.hashFileTo(fileA(), buf, 20);
    expect(buf.subarray(20, 36).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("writes into Uint8Array output", async () => {
    const h = new Hasher();
    const buf = new Uint8Array(32);
    await h.hashFileTo(fileA(), buf, 8);
    expect(Buffer.from(buf.buffer, buf.byteOffset + 8, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("seeded instance writes into output buffer", async () => {
    const h = new Hasher(123, 456);
    const buf = Buffer.alloc(32);
    await h.hashFileTo(fileA(), buf, 4);
    expect(buf.subarray(4, 20).toString("hex")).toBe(HF_A_SEED_123_456);
  });

  it("rejects for non-existent file", async () => {
    const h = new Hasher();
    await expect(h.hashFile("/no/such/file.txt")).rejects.toThrow();
  });

  it("concurrent instance calls return correct results", async () => {
    const h = new Hasher();
    const [a, b] = await Promise.all([h.hashFile(fileA()), h.hashFile(fileB())]);
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
  });
});

//  - Cross-implementation hashFile compatibility

describe("Native ↔ WASM hashFile compatibility", () => {
  it("static hashFile produces identical results", async () => {
    const n = await XXHash128.hashFile(fileA());
    const w = await XXHash128Wasm.hashFile(fileA());
    expect(n.toString("hex")).toBe(H_HELLO_WORLD_LF);
    expect(w.toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("instance hashFile produces identical results", async () => {
    const hn = new XXHash128();
    const hw = new XXHash128Wasm();
    const n = await hn.hashFile(fileA());
    const w = await hw.hashFile(fileA());
    expect(n.toString("hex")).toBe(H_HELLO_WORLD_LF);
    expect(w.toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("static hashFile with seed produces identical results", async () => {
    const n = await XXHash128.hashFile(fileA(), 42, 0);
    const w = await XXHash128Wasm.hashFile(fileA(), 42, 0);
    expect(n.toString("hex")).toBe(HF_A_SEED_42_0);
    expect(w.toString("hex")).toBe(HF_A_SEED_42_0);
  });

  it("static hashFile with salt produces identical results", async () => {
    const salt = Buffer.from("mysalt");
    const n = await XXHash128.hashFile(fileA(), 0, 0, salt);
    const w = await XXHash128Wasm.hashFile(fileA(), 0, 0, salt);
    expect(n.toString("hex")).toBe(HF_A_SALT_MYSALT);
    expect(w.toString("hex")).toBe(HF_A_SALT_MYSALT);
  });

  it("static hashFile with salt + seed produces identical results", async () => {
    const salt = Buffer.from("mysalt");
    const n = await XXHash128.hashFile(fileA(), 42, 0, salt);
    const w = await XXHash128Wasm.hashFile(fileA(), 42, 0, salt);
    expect(n.toString("hex")).toBe(HF_A_SALT_MYSALT_SEED42);
    expect(w.toString("hex")).toBe(HF_A_SALT_MYSALT_SEED42);
  });

  it("static hashFileTo with output buffer produces identical results", async () => {
    const bufN = Buffer.alloc(32);
    const bufW = Buffer.alloc(32);
    await XXHash128.hashFileTo(fileA(), bufN, 8);
    await XXHash128Wasm.hashFileTo(fileA(), bufW, 8);
    expect(bufN.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD_LF);
    expect(bufW.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("instance hashFile with seed produces identical results", async () => {
    const n = await new XXHash128(123, 456).hashFile(fileA());
    const w = await new XXHash128Wasm(123, 456).hashFile(fileA());
    expect(n.toString("hex")).toBe(HF_A_SEED_123_456);
    expect(w.toString("hex")).toBe(HF_A_SEED_123_456);
  });

  it("all fixture files produce identical hashes", async () => {
    const fixtures = [fileA(), fileB(), fileEmpty()];
    for (const f of fixtures) {
      const n = await XXHash128.hashFile(f);
      const w = await XXHash128Wasm.hashFile(f);
      expect(n.toString("hex")).toBe(w.toString("hex"));
    }
  });
});
