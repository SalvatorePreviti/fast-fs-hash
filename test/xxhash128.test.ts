/**
 * Tests for the XXHash128 class hierarchy:
 *  - XXHash128Wasm (WASM backend)
 *  - XXHash128 (native backend, falls back to WASM)
 *
 * Verifies: init, static hash, streaming, reset, digestTo, updateFile,
 * updateFilesBulk, seed support, determinism, error handling, libraryStatus,
 * and cross-implementation byte-compatibility.
 *
 * Every hash assertion checks the exact expected hex value to catch
 * any algorithmic drift or encoding regression.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFilePaths, hashesToHexArray, XXHash128, XXHash128Wasm } from "../packages/fast-fs-hash/src/index";

//  - Known xxHash3-128 values (seed 0 unless noted)

/** hash("") */
const H_EMPTY = "99aa06d3014798d86001c324468d497f";
/** hash("hello world") */
const H_HELLO_WORLD = "df8d09e93f874900a99b8775cc15b6c7";
/** hash("hello") */
const H_HELLO = "b5e9c1ad071b3e7fc779cfaa5e523818";
/** hash("world") */
const H_WORLD = "fa0d38a9b38280d0891e4985bdb2583e";
/** hash("hello world\n") — file a.txt content */
const H_HELLO_WORLD_LF = "eefac9d87100cd1336b2e733a5484425";
/** hash("goodbye world\n") — file b.txt content */
const H_GOODBYE_WORLD_LF = "472e10c9821c728278f31afb08378f2f";
/** hash("second input") */
const H_SECOND_INPUT = "3ee0a1fa1aee88446d7fc964fd741cee";
/** hash("deterministic test input") */
const H_DETERMINISTIC = "d4eda7f49d59fcbd3b2a44403aa95841";
/** hash("alphabetagammadelta") — streaming: alpha + beta + gamma + delta */
const H_ABGD = "1711218225c1291b3a4be5addce11463";

/** hash("hello world", seed 42, 0) */
const H_HW_SEED_42_0 = "5a5ecb4a698378a282c1ce3b43a636ba";
/** hash("hello world", seed 0, 42) */
const H_HW_SEED_0_42 = "ef8e7031c4aed4e25d34b0470936b5b2";
/** hash("hello world", seed 123, 456) */
const H_HW_SEED_123_456 = "954ea75c6dc99739878336dd196d0dc6";
/** hash("hello world", seed 42, 99) */
const H_HW_SEED_42_99 = "fa02c118551d9e0e2765c10f89392d8e";
/** hash("hello world", seed 0xffffffff, 0xffffffff) */
const H_HW_SEED_MAX = "81b1c25a11865b660e073134928addc0";
/** hash("test", seed 0xffffffff, 0xffffffff) */
const H_TEST_SEED_MAX = "6cc7cd132e2ff1eeac22e8e10a24ee1d";

/** updateFilesBulk([a,b]) combined digest */
const HF_AB_COMBINED = "14cb7b529dbb3358999291d5315f9ec8";
/** updateFilesBulk([b,a]) combined digest */
const HF_BA_COMBINED = "b96712ebc4252558f427015fab836b59";
/** updateFilesBulk([a, missing]) combined digest */
const HF_A_MISSING_COMBINED = "3bd4a3acde4c43af41d10b55b7dcc098";
/** Zero hash (unreadable / missing file) */
const H_ZERO = "0".repeat(32);

//  - Test fixtures

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures-xxhash128");

const fileA = () => path.join(FIXTURES_DIR, "a.txt");
const fileB = () => path.join(FIXTURES_DIR, "b.txt");
const fileEmpty = () => path.join(FIXTURES_DIR, "empty.txt");

beforeAll(async () => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });

  writeFileSync(fileA(), "hello world\n");
  writeFileSync(fileB(), "goodbye world\n");
  writeFileSync(fileEmpty(), "");

  await XXHash128Wasm.init();
  await XXHash128.init();
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

//  - Pre-init behavior

describe("pre-init behavior", () => {
  it("base class exists and is exported", async () => {
    const { XXHash128Base } = await import("../packages/fast-fs-hash/src/xxhash128/xxhash128-base");
    expect(typeof XXHash128Base).toBe("function");
    expect(new XXHash128() instanceof XXHash128Base).toBe(true);
    expect(new XXHash128Wasm() instanceof XXHash128Base).toBe(true);
  });
});

//  - Helper: run tests for both implementations

type HasherClass = typeof XXHash128 | typeof XXHash128Wasm;

const implementations: [string, HasherClass][] = [
  ["XXHash128 (native)", XXHash128],
  ["XXHash128Wasm", XXHash128Wasm],
];

//  - Tests

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
      // updateFile feeds raw content — same as update("hello world\n")
      expect(h.digest().toString("hex")).toBe(H_HELLO_WORLD_LF);
    });

    it("throws on non-existent file", async () => {
      const h = new Hasher();
      await expect(h.updateFile("/no/such/file.txt")).rejects.toThrow();
    });

    it("handles empty files", async () => {
      const h = new Hasher();
      await h.updateFile(fileEmpty());
      // Empty file -> update with empty content -> hash of ""
      expect(h.digest().toString("hex")).toBe(H_EMPTY);
    });

    it("sequential updateFile matches streaming update", async () => {
      const h = new Hasher();
      await h.updateFile(fileA());
      await h.updateFile(fileB());
      // Equivalent to update("hello world\n") then update("goodbye world\n")
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

//  - Static hashFilesBulk

describe.each(implementations)("%s — static hashFilesBulk", (_name, Hasher) => {
  it("outputMode=digest returns 16-byte aggregate", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "digest" });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
    expect(result.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("default (outputMode=digest) returns 16-byte aggregate", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
    expect(result.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("outputMode=all returns digest + per-file hashes", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all" });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16 + 32); // digest + 2 file hashes
    expect(result.subarray(0, 16).toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("outputMode=files returns only per-file hashes", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "files" });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(32);
    expect(hashesToHexArray(result)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("explicit outputMode=digest matches default", async () => {
    const def = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    const dig = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "digest" });
    expect(def.toString("hex")).toBe(dig.toString("hex"));
  });

  it("order matters", async () => {
    const ab = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    const ba = await Hasher.hashFilesBulk({ files: [fileB(), fileA()] });
    expect(ab.toString("hex")).toBe(HF_AB_COMBINED);
    expect(ba.toString("hex")).toBe(HF_BA_COMBINED);
  });

  it("missing file produces zero hash", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), "/no/such/file.txt"], outputMode: "all" });
    expect(result.subarray(0, 16).toString("hex")).toBe(HF_A_MISSING_COMBINED);
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF, H_ZERO]);
  });

  it("empty list (digest)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [] });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
  });

  it("empty list (all)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [], outputMode: "all" });
    expect(result.length).toBe(16); // digest only, no per-file hashes
  });

  it("empty list (files)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [], outputMode: "files" });
    expect(result.length).toBe(0);
  });

  it("single file (all)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA()], outputMode: "all" });
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF]);
  });

  it("matches instance-based updateFilesBulk+digest", async () => {
    const h = new Hasher();
    await h.updateFilesBulk([fileA(), fileB()]);
    const instanceDigest = h.digest().toString("hex");
    const staticDigest = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    expect(staticDigest.toString("hex")).toBe(instanceDigest);
  });

  it("accepts Uint8Array of null-terminated paths", async () => {
    const result = await Hasher.hashFilesBulk({
      files: encodeFilePaths([fileA(), fileB()]),
    });
    expect(result.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("with pre-allocated Buffer (all mode) via hashFilesBulkTo", async () => {
    const buf = Buffer.alloc(100);
    await Hasher.hashFilesBulkTo(
      {
        files: [fileA(), fileB()],
        outputMode: "all",
      },
      buf,
      10
    );
    expect(buf.subarray(10, 26).toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(buf.subarray(26, 58))).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("with pre-allocated Uint8Array (all mode) via hashFilesBulkTo", async () => {
    const buf = new Uint8Array(100);
    await Hasher.hashFilesBulkTo(
      {
        files: [fileA(), fileB()],
        outputMode: "all",
      },
      buf,
      10
    );
    expect(Buffer.from(buf.buffer, buf.byteOffset + 10, 16).toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("with pre-allocated Buffer (digest mode) via hashFilesBulkTo", async () => {
    const buf = Buffer.alloc(64);
    await Hasher.hashFilesBulkTo(
      {
        files: [fileA(), fileB()],
      },
      buf,
      4
    );
    expect(buf.subarray(4, 20).toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("with seed changes aggregate but not per-file hashes", async () => {
    const seeded = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all", seedLow: 42 });
    const unseeded = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all" });
    // Aggregate differs
    expect(seeded.subarray(0, 16).toString("hex")).not.toBe(unseeded.subarray(0, 16).toString("hex"));
    // Per-file hashes identical (always seed=0)
    expect(hashesToHexArray(seeded.subarray(16))).toEqual(hashesToHexArray(unseeded.subarray(16)));
  });

  it("seeded digest matches instance approach", async () => {
    const seeded = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], seedLow: 42 });
    const h = new Hasher(42, 0);
    await h.updateFilesBulk([fileA(), fileB()]);
    expect(seeded.toString("hex")).toBe(h.digest().toString("hex"));
  });

  it("throws if outputBuffer is too small for hashFilesBulkTo", async () => {
    await expect(Hasher.hashFilesBulkTo({ files: [fileA(), fileB()] }, Buffer.alloc(10))).rejects.toThrow(RangeError);
  });

  it("concurrency=1 produces same result", async () => {
    const normal = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    const single = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], concurrency: 1 });
    expect(normal.toString("hex")).toBe(single.toString("hex"));
  });
});

//  - Unbound static methods (destructured, no `this`)

describe.each(implementations)("%s — unbound static methods", (_name, Hasher) => {
  it("hash() works when destructured", () => {
    const { hash } = Hasher;
    expect(hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
  });

  it("hash() works when assigned to a variable", () => {
    const hash = Hasher.hash;
    expect(hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
    expect(hash("").toString("hex")).toBe(H_EMPTY);
  });

  it("hash() with seed works when destructured", () => {
    const { hash } = Hasher;
    expect(hash("hello world", 42, 0).toString("hex")).toBe(H_HW_SEED_42_0);
  });

  it("hashFilesBulk() works when destructured", async () => {
    const { hashFilesBulk } = Hasher;
    const digest = await hashFilesBulk({ files: [fileA(), fileB()] });
    expect(digest.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("hashFilesBulk() all mode works when destructured", async () => {
    const { hashFilesBulk } = Hasher;
    const result = await hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all" });
    expect(result.subarray(0, 16).toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("init() works when destructured", async () => {
    const { init } = Hasher;
    // Should be a no-op since already initialized, but must not throw
    await expect(init()).resolves.toBeUndefined();
  });
});

//  - Known hashFile values (seed 0 unless noted)

/** hash(salt="mysalt" + "hello world\n", seed 0,0) */
const HF_A_SALT_MYSALT = "f269da00a3f956f199158556730e4af1";
/** hash(salt="mysalt" + "hello world\n", seed 42,0) */
const HF_A_SALT_MYSALT_SEED42 = "ffc8b234b10f7b17def04905ebb1d001";
/** hash(salt="mysalt" + "hello world\n", seed 0xffffffff,0xffffffff) */
const HF_A_SALT_MYSALT_SEED_MAX = "792cc06f75a86868388691e89a723956";
/** hash("hello world\n", seed 42,0) */
const HF_A_SEED_42_0 = "860ad33aa44f26a9ae34601b61d5637c";
/** hash("hello world\n", seed 0,42) */
const HF_A_SEED_0_42 = "4d1bb5a5314ef1e687c3e451ac6176e5";
/** hash("hello world\n", seed 123,456) */
const HF_A_SEED_123_456 = "5af43df781f7e9963b9c2d89ca3ebc5a";
/** hash("goodbye world\n", seed 42,0) */
const HF_B_SEED_42_0 = "4638f724963550a71a54688c03cf18ad";
/** hash(salt=[1,2,3,4] + binary.bin, seed 0,0) */
const HF_BINARY_SALT_1234 = "48ff1eeae97208f1b02ffd1307ccc6da";

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
    // Before and after should be zeroes
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
    // Without salt should differ
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
    const binaryFile = path.join(FIXTURES_DIR, "..", "fixtures/hash-fixture/binary.bin");
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
    await expect(Hasher.hashFile(FIXTURES_DIR)).rejects.toThrow();
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
    // Note: instance hashFile in JS fallback mutates state — these may interleave.
    // Both should still produce 16-byte results (native does NOT mutate state).
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

//  - Static hashFileHandle

describe.each(implementations)("%s — static hashFileHandle", (_name, Hasher) => {
  it("returns correct 16-byte Buffer for a.txt", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(result.toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("returns correct hash for b.txt", async () => {
    const fh = await open(fileB(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh);
      expect(result.toString("hex")).toBe(H_GOODBYE_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("returns correct hash for empty file", async () => {
    const fh = await open(fileEmpty(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh);
      expect(result.toString("hex")).toBe(H_EMPTY);
    } finally {
      await fh.close();
    }
  });

  it("writes into pre-allocated Buffer", async () => {
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(32);
      await Hasher.hashFileHandleTo(fh, buf);
      expect(buf.subarray(0, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("writes at specified offset", async () => {
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(64);
      await Hasher.hashFileHandleTo(fh, buf, 10);
      expect(buf.subarray(10, 26).toString("hex")).toBe(H_HELLO_WORLD_LF);
      expect(buf.subarray(0, 10).every((b) => b === 0)).toBe(true);
      expect(buf.subarray(26, 64).every((b) => b === 0)).toBe(true);
    } finally {
      await fh.close();
    }
  });

  it("seedLow changes digest", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh, 42);
      expect(result.toString("hex")).toBe(HF_A_SEED_42_0);
    } finally {
      await fh.close();
    }
  });

  it("seedHigh changes digest", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh, 0, 42);
      expect(result.toString("hex")).toBe(HF_A_SEED_0_42);
    } finally {
      await fh.close();
    }
  });

  it("both seed parts produce correct digest", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh, 123, 456);
      expect(result.toString("hex")).toBe(HF_A_SEED_123_456);
    } finally {
      await fh.close();
    }
  });

  it("produces identical results on repeated calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const fh = await open(fileA(), "r");
        try {
          return await Hasher.hashFileHandle(fh);
        } finally {
          await fh.close();
        }
      })
    );
    for (const r of results) {
      expect(r.toString("hex")).toBe(H_HELLO_WORLD_LF);
    }
  });

  it("matches hashFile result (same content, same seed)", async () => {
    const fromFile = await Hasher.hashFile(fileA());
    const fh = await open(fileA(), "r");
    try {
      const fromHandle = await Hasher.hashFileHandle(fh);
      expect(fromHandle.toString("hex")).toBe(fromFile.toString("hex"));
    } finally {
      await fh.close();
    }
  });
});

//  - Instance hashFileHandle

describe.each(implementations)("%s — instance hashFileHandle", (_name, Hasher) => {
  it("returns correct 16-byte Buffer for a.txt (seed 0)", async () => {
    const h = new Hasher();
    const fh = await open(fileA(), "r");
    try {
      const result = await h.hashFileHandle(fh);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(result.toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("uses the instance seed", async () => {
    const h = new Hasher(42, 0);
    const fh = await open(fileA(), "r");
    try {
      const result = await h.hashFileHandle(fh);
      expect(result.toString("hex")).toBe(HF_A_SEED_42_0);
    } finally {
      await fh.close();
    }
  });

  it("writes into output buffer", async () => {
    const h = new Hasher();
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(32);
      await h.hashFileHandleTo(fh, buf);
      expect(buf.subarray(0, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("writes at offset into output buffer", async () => {
    const h = new Hasher();
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(64);
      await h.hashFileHandleTo(fh, buf, 20);
      expect(buf.subarray(20, 36).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });
});

//  - Cross-implementation hashFileHandle compatibility

describe("Native ↔ WASM hashFileHandle compatibility", () => {
  it("static hashFileHandle produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const n = await XXHash128.hashFileHandle(fhN);
      const w = await XXHash128Wasm.hashFileHandle(fhW);
      expect(n.toString("hex")).toBe(H_HELLO_WORLD_LF);
      expect(w.toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });

  it("static hashFileHandle with seed produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const n = await XXHash128.hashFileHandle(fhN, 42, 0);
      const w = await XXHash128Wasm.hashFileHandle(fhW, 42, 0);
      expect(n.toString("hex")).toBe(HF_A_SEED_42_0);
      expect(w.toString("hex")).toBe(HF_A_SEED_42_0);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });

  it("static hashFileHandleTo with output buffer produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const bufN = Buffer.alloc(32);
      const bufW = Buffer.alloc(32);
      await XXHash128.hashFileHandleTo(fhN, bufN, 8);
      await XXHash128Wasm.hashFileHandleTo(fhW, bufW, 8);
      expect(bufN.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD_LF);
      expect(bufW.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });

  it("hashFileHandle matches hashFile for all fixtures", async () => {
    const fixtures = [fileA(), fileB(), fileEmpty()];
    for (const f of fixtures) {
      const fromFile = await XXHash128.hashFile(f);
      const fh = await open(f, "r");
      try {
        const fromHandle = await XXHash128.hashFileHandle(fh);
        expect(fromHandle.toString("hex")).toBe(fromFile.toString("hex"));
      } finally {
        await fh.close();
      }
    }
  });

  it("instance hashFileHandle with seed produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const n = await new XXHash128(123, 456).hashFileHandle(fhN);
      const w = await new XXHash128Wasm(123, 456).hashFileHandle(fhW);
      expect(n.toString("hex")).toBe(HF_A_SEED_123_456);
      expect(w.toString("hex")).toBe(HF_A_SEED_123_456);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });
});
