/**
 * Core XXHash128 tests: pre-init, libraryStatus, static hash, streaming,
 * reset, digestTo, updateFile, updateFilesBulk, seed, determinism,
 * error handling, cross-implementation compatibility.
 */

import { encodeFilePaths, hashesToHexArray, XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

import {
  fileA,
  fileB,
  fileEmpty,
  H_ABGD,
  H_DETERMINISTIC,
  H_EMPTY,
  H_GOODBYE_WORLD_LF,
  H_HELLO,
  H_HELLO_WORLD,
  H_HELLO_WORLD_LF,
  H_HW_SEED_0_42,
  H_HW_SEED_42_0,
  H_HW_SEED_42_99,
  H_HW_SEED_123_456,
  H_HW_SEED_MAX,
  H_SECOND_INPUT,
  H_TEST_SEED_MAX,
  H_WORLD,
  H_ZERO,
  HF_A_MISSING_COMBINED,
  HF_AB_COMBINED,
  HF_BA_COMBINED,
  implementations,
  setupXXHash128Fixtures,
} from "./_helpers";

setupXXHash128Fixtures("core");

//  - Pre-init behavior

describe("pre-init behavior", () => {
  it("base class exists and is exported", async () => {
    const { XXHash128Base } = await import("../../packages/fast-fs-hash/src/xxhash128/xxhash128-base");
    expect(typeof XXHash128Base).toBe("function");
    expect(new XXHash128() instanceof XXHash128Base).toBe(true);
    expect(new XXHash128Wasm() instanceof XXHash128Base).toBe(true);
  });
});

//  - Per-implementation tests

describe.each(implementations)("%s", (_name, Hasher) => {
  //  - libraryStatus

  describe("libraryStatus", () => {
    it("returns a valid status after init", () => {
      const h = new Hasher();
      expect(["native", "wasm"]).toContain(h.libraryStatus);
    });

    it("XXHash128Wasm always reports wasm", () => {
      expect(new XXHash128Wasm().libraryStatus).toBe("wasm");
    });
  });

  //  - Static hash

  describe("static hash()", () => {
    it("returns correct hash for string input", () => {
      expect(Hasher.hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("returns correct hash for Buffer input", () => {
      expect(Hasher.hash(Buffer.from("hello world")).toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("returns correct hash for Uint8Array input", () => {
      expect(Hasher.hash(new TextEncoder().encode("hello world")).toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("returns correct hash for empty input", () => {
      expect(Hasher.hash("").toString("hex")).toBe(H_EMPTY);
    });

    it("produces same hash for same input regardless of type", () => {
      expect(Hasher.hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
      expect(Hasher.hash(Buffer.from("hello world")).toString("hex")).toBe(H_HELLO_WORLD);
      expect(Hasher.hash(new TextEncoder().encode("hello world")).toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("produces different hashes for different inputs", () => {
      expect(Hasher.hash("hello").toString("hex")).toBe(H_HELLO);
      expect(Hasher.hash("world").toString("hex")).toBe(H_WORLD);
    });

    it("supports inputOffset via update", () => {
      const h = new Hasher();
      h.update(Buffer.from("XXhello"), 2);
      expect(h.digest().toString("hex")).toBe(H_HELLO);
    });

    it("supports inputOffset + inputLength via update", () => {
      const h = new Hasher();
      h.update(Buffer.from("XXhelloYY"), 2, 5);
      expect(h.digest().toString("hex")).toBe(H_HELLO);
    });

    it("hashes empty slice when length is 0 via update", () => {
      const h = new Hasher();
      h.update(Buffer.from("hello"), 0, 0);
      expect(h.digest().toString("hex")).toBe(H_EMPTY);
    });
  });

  //  - Streaming update + digest

  describe("streaming update/digest", () => {
    it("single update matches static hash", () => {
      const h = new Hasher();
      h.update("hello world");
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("multiple updates produce correct hash", () => {
      const h = new Hasher();
      h.update("hello ");
      h.update("world");
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("digest does not reset state", () => {
      const h = new Hasher();
      h.update("hello");
      expect(h.digest().toString("hex")).toBe(H_HELLO);
      expect(h.digest().toString("hex")).toBe(H_HELLO);
    });

    it("digest changes after more updates", () => {
      const h = new Hasher();
      h.update("hello");
      expect(h.digest().toString("hex")).toBe(H_HELLO);
      h.update(" world");
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("empty update has no effect", () => {
      const h = new Hasher();
      h.update("hello");
      h.update("");
      expect(h.digest().toString("hex")).toBe(H_HELLO);
    });

    it("update with Buffer input", () => {
      const h = new Hasher();
      h.update(Buffer.from("hello world"));
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("update with Uint8Array input", () => {
      const h = new Hasher();
      h.update(new TextEncoder().encode("hello world"));
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("update with offset and length", () => {
      const h = new Hasher();
      h.update(Buffer.from("XXhelloYY"), 2, 5);
      expect(h.digest().toString("hex")).toBe(H_HELLO);
    });

    it("multi-part streaming matches one-shot", () => {
      const h = new Hasher();
      h.update("alpha");
      h.update("beta");
      h.update("gamma");
      h.update("delta");
      expect(h.digest().toString("hex")).toBe(H_ABGD);
    });
  });

  //  - reset

  describe("reset()", () => {
    it("resets state to initial", () => {
      const h = new Hasher();
      h.update("hello world");
      h.reset();
      expect(h.digest().toString("hex")).toBe(H_EMPTY);
    });

    it("can reuse after reset", () => {
      const h = new Hasher();
      h.update("first input");
      h.reset();
      h.update("second input");
      expect(h.digest().toString("hex")).toBe(H_SECOND_INPUT);
    });
  });

  //  - digestTo

  describe("digestTo()", () => {
    it("writes correct digest to Buffer at offset 0", () => {
      const h = new Hasher();
      h.update("hello world");
      const out = Buffer.alloc(16);
      h.digestTo(out);
      expect(out.toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("writes correct digest to Uint8Array", () => {
      const h = new Hasher();
      h.update("hello world");
      const out = new Uint8Array(16);
      h.digestTo(out);
      expect(Buffer.from(out).toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("writes at given offset", () => {
      const h = new Hasher();
      h.update("hello world");
      const out = Buffer.alloc(32);
      h.digestTo(out, 8);
      expect(out.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD);
      expect(out.subarray(0, 8).every((b) => b === 0)).toBe(true);
      expect(out.subarray(24, 32).every((b) => b === 0)).toBe(true);
    });
  });

  //  - updateFile

  describe("updateFile()", () => {
    it("reads a single file and feeds raw content into state", async () => {
      const h = new Hasher();
      await h.updateFile(fileA());
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD_LF);
    });

    it("throws on non-existent file", async () => {
      const h = new Hasher();
      await expect(h.updateFile("/no/such/file.txt")).rejects.toThrow();
    });

    it("handles empty files", async () => {
      const h = new Hasher();
      await h.updateFile(fileEmpty());
      expect(h.digest().toString("hex")).toBe(H_EMPTY);
    });

    it("sequential updateFile matches streaming update", async () => {
      const h = new Hasher();
      await h.updateFile(fileA());
      await h.updateFile(fileB());
      const expected = new Hasher();
      expected.update("hello world\n");
      expected.update("goodbye world\n");
      expect(h.digest().toString("hex")).toBe(expected.digest().toString("hex"));
    });
  });

  //  - updateFilesBulk

  describe("updateFilesBulk()", () => {
    it("produces correct combined digest", async () => {
      const h = new Hasher();
      await h.updateFilesBulk([fileA(), fileB()]);
      expect(h.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });

    it("returns null when allFiles is falsy", async () => {
      const h = new Hasher();
      const result = await h.updateFilesBulk([fileA()]);
      expect(result).toBeNull();
    });

    it("returns correct per-file hashes when allFiles=true", async () => {
      const h = new Hasher();
      const result = await h.updateFilesBulk([fileA(), fileB()], true);
      expect(result).not.toBeNull();
      expect(hashesToHexArray(result as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
      expect(h.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });

    it("writes per-file hashes into provided Uint8Array via updateFilesBulkTo", async () => {
      const h = new Hasher();
      const out = new Uint8Array(2 * 16);
      await h.updateFilesBulkTo([fileA(), fileB()], out);
      expect(hashesToHexArray(out)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
    });

    it("writes per-file hashes into provided Buffer via updateFilesBulkTo", async () => {
      const h = new Hasher();
      const out = Buffer.alloc(2 * 16);
      await h.updateFilesBulkTo([fileA(), fileB()], out);
      expect(hashesToHexArray(out)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
    });

    it("throws if provided buffer is too small for updateFilesBulkTo", async () => {
      const h = new Hasher();
      await expect(h.updateFilesBulkTo([fileA(), fileB()], Buffer.alloc(8))).rejects.toThrow(RangeError);
    });

    it("empty file list returns empty Buffer with allFiles=true", async () => {
      const h = new Hasher();
      const result = await h.updateFilesBulk([], true);
      expect(result).not.toBeNull();
      expect((result as Buffer).length).toBe(0);
    });

    it("empty file list returns null with allFiles=false", async () => {
      const h = new Hasher();
      expect(await h.updateFilesBulk([])).toBeNull();
    });

    it("unreadable files produce zero hashes", async () => {
      const h = new Hasher();
      const result = await h.updateFilesBulk([fileA(), "/no/such/file.txt"], true);
      expect(hashesToHexArray(result as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_ZERO]);
      expect(h.digest().toString("hex")).toBe(HF_A_MISSING_COMBINED);
    });

    it("accepts Uint8Array of null-terminated paths", async () => {
      const h = new Hasher();
      await h.updateFilesBulk(encodeFilePaths([fileA(), fileB()]));
      expect(h.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });

    it("produces deterministic results", async () => {
      const h1 = new Hasher();
      const pf1 = await h1.updateFilesBulk([fileA(), fileB()], true);
      const h2 = new Hasher();
      const pf2 = await h2.updateFilesBulk([fileA(), fileB()], true);
      expect(h1.digest().toString("hex")).toBe(HF_AB_COMBINED);
      expect(h2.digest().toString("hex")).toBe(HF_AB_COMBINED);
      expect(hashesToHexArray(pf1 as Uint8Array)).toEqual(hashesToHexArray(pf2 as Uint8Array));
    });

    it("order matters", async () => {
      const h1 = new Hasher();
      await h1.updateFilesBulk([fileA(), fileB()]);
      expect(h1.digest().toString("hex")).toBe(HF_AB_COMBINED);

      const h2 = new Hasher();
      await h2.updateFilesBulk([fileB(), fileA()]);
      expect(h2.digest().toString("hex")).toBe(HF_BA_COMBINED);
    });

    it("per-file hashes are swapped when order is reversed", async () => {
      const h1 = new Hasher();
      const ab = await h1.updateFilesBulk([fileA(), fileB()], true);
      const h2 = new Hasher();
      const ba = await h2.updateFilesBulk([fileB(), fileA()], true);
      expect(hashesToHexArray(ab as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
      expect(hashesToHexArray(ba as Uint8Array)).toEqual([H_GOODBYE_WORLD_LF, H_HELLO_WORLD_LF]);
    });

    it("concurrency=1 produces same result", async () => {
      const h1 = new Hasher();
      await h1.updateFilesBulk([fileA(), fileB()]);
      const h2 = new Hasher();
      h2.concurrency = 1;
      await h2.updateFilesBulk([fileA(), fileB()]);
      expect(h1.digest().toString("hex")).toBe(HF_AB_COMBINED);
      expect(h2.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });
  });

  //  - Seed support

  describe("seed support", () => {
    it("seed=0 (default) produces the known hash", () => {
      expect(Hasher.hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
      expect(Hasher.hash("hello world", 0, 0).toString("hex")).toBe(H_HELLO_WORLD);
    });

    it("different seedLow produces correct hash", () => {
      expect(Hasher.hash("hello world", 42, 0).toString("hex")).toBe(H_HW_SEED_42_0);
    });

    it("different seedHigh produces correct hash", () => {
      expect(Hasher.hash("hello world", 0, 42).toString("hex")).toBe(H_HW_SEED_0_42);
    });

    it("streaming with seed matches one-shot", () => {
      const h = new Hasher(123, 456);
      h.update("hello world");
      expect(h.digest().toString("hex")).toBe(H_HW_SEED_123_456);
    });

    it("reset preserves seed", () => {
      const h = new Hasher(123, 456);
      h.update("hello");
      h.reset();
      h.update("hello world");
      expect(h.digest().toString("hex")).toBe(H_HW_SEED_123_456);
    });

    it("large seed values work (max u32)", () => {
      expect(Hasher.hash("test", 0xffffffff, 0xffffffff).toString("hex")).toBe(H_TEST_SEED_MAX);
    });
  });

  //  - Determinism

  describe("determinism", () => {
    it("same inputs always produce the same hash", () => {
      for (let i = 0; i < 10; i++) {
        expect(Hasher.hash("deterministic test input").toString("hex")).toBe(H_DETERMINISTIC);
      }
    });
  });

  //  - Error handling

  describe("error handling", () => {
    it("update throws on out-of-range offset+length", () => {
      expect(() => new Hasher().update(Buffer.from("hi"), 0, 100)).toThrow();
    });

    it("digestTo throws if output buffer is too small", () => {
      const h = new Hasher();
      h.update("test");
      expect(() => h.digestTo(Buffer.alloc(8))).toThrow();
    });

    it("digestTo throws if offset leaves too few bytes", () => {
      const h = new Hasher();
      h.update("test");
      expect(() => h.digestTo(Buffer.alloc(20), 10)).toThrow();
    });
  });
});

//  - Cross-implementation compatibility

describe("Native ↔ WASM compatibility", () => {
  it.each([
    ["empty string", "", H_EMPTY],
    ["hello world", "hello world", H_HELLO_WORLD],
    ["single char", "a", "a96faf705af16834e6c632b61e964e1f"],
    ["The quick brown fox", "The quick brown fox jumps over the lazy dog", "ddd650205ca3e7fa24a1cc2e3a8a7651"],
    ["x×1000", "x".repeat(1000), "50a1af5a5f2dcf01c0a4877b962cba82"],
    ["x×100000", "x".repeat(100_000), "0fe996a84987456bd8b99a30e426ac41"],
  ])("static hash %s", (_label, input, expected) => {
    expect(XXHash128.hash(input).toString("hex")).toBe(expected);
    expect(XXHash128Wasm.hash(input).toString("hex")).toBe(expected);
  });

  it("streaming produces identical output", () => {
    const parts = ["hello ", "world ", "from ", "streaming"];
    const hn = new XXHash128();
    const hw = new XXHash128Wasm();
    for (const part of parts) {
      hn.update(part);
      hw.update(part);
    }
    const expected = XXHash128.hash("hello world from streaming").toString("hex");
    expect(hn.digest().toString("hex")).toBe(expected);
    expect(hw.digest().toString("hex")).toBe(expected);
  });

  it.each([
    [1, 0, "fa3a96b27c8228fc9c199070b6177663"],
    [0, 1, "98d6f5d6389c39bc77831306fde7ebbd"],
    [42, 99, H_HW_SEED_42_99],
    [0xdeadbeef, 0xcafebabe, "6638d48a81ba158813b6083fb99b8f91"],
    [0xffffffff, 0xffffffff, H_HW_SEED_MAX],
  ])("seeded hash (seed %i,%i)", (lo, hi, expected) => {
    expect(XXHash128.hash("hello world", lo, hi).toString("hex")).toBe(expected);
    expect(XXHash128Wasm.hash("hello world", lo, hi).toString("hex")).toBe(expected);
  });

  it("streaming with seed", () => {
    const hn = new XXHash128(42, 99);
    const hw = new XXHash128Wasm(42, 99);
    hn.update("hello world");
    hw.update("hello world");
    expect(hn.digest().toString("hex")).toBe(H_HW_SEED_42_99);
    expect(hw.digest().toString("hex")).toBe(H_HW_SEED_42_99);
  });

  it("updateFile produces identical output", async () => {
    const hn = new XXHash128();
    const hw = new XXHash128Wasm();
    await hn.updateFile(fileA());
    await hw.updateFile(fileA());
    expect(hn.digest().toString("hex")).toBe(H_HELLO_WORLD_LF);
    expect(hw.digest().toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("updateFilesBulk produces identical combined and per-file output", async () => {
    const hn = new XXHash128();
    const nPerFile = await hn.updateFilesBulk([fileA(), fileB()], true);
    const hw = new XXHash128Wasm();
    const wPerFile = await hw.updateFilesBulk([fileA(), fileB()], true);

    expect(hn.digest().toString("hex")).toBe(HF_AB_COMBINED);
    expect(hw.digest().toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(nPerFile as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
    expect(hashesToHexArray(wPerFile as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });
});
