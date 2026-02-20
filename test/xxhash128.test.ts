/**
 * Tests for the XXHash128 class hierarchy:
 *  - XXHash128Wasm (WASM backend)
 *  - XXHash128 (native backend, falls back to WASM)
 *
 * Verifies: init, static hash, streaming, reset, digestTo, updateFile,
 * hashFiles, seed support, determinism, error handling, libraryStatus,
 * and cross-implementation byte-compatibility.
 *
 * Every hash assertion checks the exact expected hex value to catch
 * any algorithmic drift or encoding regression.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFilePaths, hashesToHexArray, XXHash128, XXHash128Wasm } from "../packages/fast-fs-hash/src/index";

// ── Known xxHash3-128 values (seed 0 unless noted) ──────────────────────

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
/** hash("test") */
const H_TEST = "6c78e0e3bd51d358d01e758642b85fb8";
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

/** hashFiles([a,b]) combined digest */
const HF_AB_COMBINED = "14cb7b529dbb3358999291d5315f9ec8";
/** hashFiles([b,a]) combined digest */
const HF_BA_COMBINED = "b96712ebc4252558f427015fab836b59";
/** hashFiles([a, missing]) combined digest */
const HF_A_MISSING_COMBINED = "3bd4a3acde4c43af41d10b55b7dcc098";
/** Zero hash (unreadable / missing file) */
const H_ZERO = "0".repeat(32);

// ── Test fixtures ────────────────────────────────────────────────────────

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

// ── Pre-init behavior ────────────────────────────────────────────────────

describe("pre-init behavior", () => {
  it("base class exists and is exported", async () => {
    const { XXHash128Base } = await import("../packages/fast-fs-hash/src/xxhash128-base");
    expect(typeof XXHash128Base).toBe("function");
    expect(new XXHash128() instanceof XXHash128Base).toBe(true);
    expect(new XXHash128Wasm() instanceof XXHash128Base).toBe(true);
  });
});

// ── Helper: run tests for both implementations ──────────────────────────

type HasherClass = typeof XXHash128 | typeof XXHash128Wasm;

const implementations: [string, HasherClass][] = [
  ["XXHash128 (native)", XXHash128],
  ["XXHash128Wasm", XXHash128Wasm],
];

// ── Tests ────────────────────────────────────────────────────────────────

describe.each(implementations)("%s", (_name, Hasher) => {
  // ── libraryStatus ──────────────────────────────────────────────────

  describe("libraryStatus", () => {
    it("returns a valid status after init", () => {
      const h = new Hasher();
      expect(["native", "wasm"]).toContain(h.libraryStatus);
    });

    it("XXHash128Wasm always reports wasm", () => {
      expect(new XXHash128Wasm().libraryStatus).toBe("wasm");
    });
  });

  // ── Static hash ────────────────────────────────────────────────────

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

  // ── Streaming update + digest ──────────────────────────────────────

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

  // ── reset ──────────────────────────────────────────────────────────

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

  // ── digestTo ───────────────────────────────────────────────────────

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

  // ── updateFile ─────────────────────────────────────────────────────

  describe("updateFile()", () => {
    it("reads a single file and feeds contents into hash", async () => {
      const h = new Hasher();
      const count = await h.updateFile(fileA());
      expect(count).toBe(1);
      expect(h.digest().toString("hex")).toBe(Hasher.hash("hello world\n").toString("hex"));
    });

    it("reads multiple files in order", async () => {
      const h = new Hasher();
      const count = await h.updateFile([fileA(), fileB()]);
      expect(count).toBe(2);

      const h2 = new Hasher();
      h2.update("hello world\n");
      h2.update("goodbye world\n");
      expect(h.digest().toString("hex")).toBe(h2.digest().toString("hex"));
    });

    it("skips non-existent files and returns correct count", async () => {
      const h = new Hasher();
      const count = await h.updateFile([fileA(), "/no/such/file.txt", fileB()]);
      expect(count).toBe(2);
    });

    it("returns 0 for empty array", async () => {
      const h = new Hasher();
      const count = await h.updateFile([]);
      expect(count).toBe(0);
      expect(h.digest().toString("hex")).toBe(H_EMPTY);
    });

    it("handles empty files", async () => {
      const h = new Hasher();
      const count = await h.updateFile(fileEmpty());
      expect(count).toBe(1);
      expect(h.digest().toString("hex")).toBe(H_EMPTY);
    });

    it("accepts a single path string", async () => {
      const h = new Hasher();
      const count = await h.updateFile(fileA());
      expect(count).toBe(1);
      expect(h.digest().toString("hex")).toBe(Hasher.hash("hello world\n").toString("hex"));
    });
  });

  // ── hashFiles ──────────────────────────────────────────────────────

  describe("hashFiles()", () => {
    it("produces correct combined digest", async () => {
      const h = new Hasher();
      await h.hashFiles([fileA(), fileB()]);
      expect(h.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });

    it("returns null when allFiles is falsy", async () => {
      const h = new Hasher();
      const result = await h.hashFiles([fileA()]);
      expect(result).toBeNull();
    });

    it("returns correct per-file hashes when allFiles=true", async () => {
      const h = new Hasher();
      const result = await h.hashFiles([fileA(), fileB()], true);
      expect(result).not.toBeNull();
      expect(hashesToHexArray(result as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
      expect(h.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });

    it("writes per-file hashes into provided Uint8Array", async () => {
      const h = new Hasher();
      const out = new Uint8Array(2 * 16);
      const result = await h.hashFiles([fileA(), fileB()], out);
      expect(result).toBe(out);
      expect(hashesToHexArray(out)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
    });

    it("writes per-file hashes into provided Buffer", async () => {
      const h = new Hasher();
      const out = Buffer.alloc(2 * 16);
      const result = await h.hashFiles([fileA(), fileB()], out);
      expect(result).toBe(out);
      expect(hashesToHexArray(out)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
    });

    it("throws if provided buffer is too small", async () => {
      const h = new Hasher();
      await expect(h.hashFiles([fileA(), fileB()], Buffer.alloc(8))).rejects.toThrow(RangeError);
    });

    it("empty file list returns empty Buffer with allFiles=true", async () => {
      const h = new Hasher();
      const result = await h.hashFiles([], true);
      expect(result).not.toBeNull();
      expect((result as Buffer).length).toBe(0);
    });

    it("empty file list returns null with allFiles=false", async () => {
      const h = new Hasher();
      expect(await h.hashFiles([])).toBeNull();
    });

    it("unreadable files produce zero hashes", async () => {
      const h = new Hasher();
      const result = await h.hashFiles([fileA(), "/no/such/file.txt"], true);
      expect(hashesToHexArray(result as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_ZERO]);
      expect(h.digest().toString("hex")).toBe(HF_A_MISSING_COMBINED);
    });

    it("accepts Uint8Array of null-terminated paths", async () => {
      const h = new Hasher();
      await h.hashFiles(encodeFilePaths([fileA(), fileB()]));
      expect(h.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });

    it("produces deterministic results", async () => {
      const h1 = new Hasher();
      const pf1 = await h1.hashFiles([fileA(), fileB()], true);
      const h2 = new Hasher();
      const pf2 = await h2.hashFiles([fileA(), fileB()], true);
      expect(h1.digest().toString("hex")).toBe(HF_AB_COMBINED);
      expect(h2.digest().toString("hex")).toBe(HF_AB_COMBINED);
      expect(hashesToHexArray(pf1 as Uint8Array)).toEqual(hashesToHexArray(pf2 as Uint8Array));
    });

    it("order matters", async () => {
      const h1 = new Hasher();
      await h1.hashFiles([fileA(), fileB()]);
      expect(h1.digest().toString("hex")).toBe(HF_AB_COMBINED);

      const h2 = new Hasher();
      await h2.hashFiles([fileB(), fileA()]);
      expect(h2.digest().toString("hex")).toBe(HF_BA_COMBINED);
    });

    it("per-file hashes are swapped when order is reversed", async () => {
      const h1 = new Hasher();
      const ab = await h1.hashFiles([fileA(), fileB()], true);
      const h2 = new Hasher();
      const ba = await h2.hashFiles([fileB(), fileA()], true);
      expect(hashesToHexArray(ab as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
      expect(hashesToHexArray(ba as Uint8Array)).toEqual([H_GOODBYE_WORLD_LF, H_HELLO_WORLD_LF]);
    });

    it("concurrency=1 produces same result", async () => {
      const h1 = new Hasher();
      await h1.hashFiles([fileA(), fileB()]);
      const h2 = new Hasher();
      h2.concurrency = 1;
      await h2.hashFiles([fileA(), fileB()]);
      expect(h1.digest().toString("hex")).toBe(HF_AB_COMBINED);
      expect(h2.digest().toString("hex")).toBe(HF_AB_COMBINED);
    });
  });

  // ── Seed support ───────────────────────────────────────────────────

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

  // ── Determinism ────────────────────────────────────────────────────

  describe("determinism", () => {
    it("same inputs always produce the same hash", () => {
      for (let i = 0; i < 10; i++) {
        expect(Hasher.hash("deterministic test input").toString("hex")).toBe(H_DETERMINISTIC);
      }
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

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

// ── Cross-implementation compatibility ───────────────────────────────

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
    await hn.updateFile([fileA(), fileB()]);
    await hw.updateFile([fileA(), fileB()]);
    expect(hn.digest().toString("hex")).toBe(hw.digest().toString("hex"));
  });

  it("hashFiles produces identical combined and per-file output", async () => {
    const hn = new XXHash128();
    const nPerFile = await hn.hashFiles([fileA(), fileB()], true);
    const hw = new XXHash128Wasm();
    const wPerFile = await hw.hashFiles([fileA(), fileB()], true);

    expect(hn.digest().toString("hex")).toBe(HF_AB_COMBINED);
    expect(hw.digest().toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(nPerFile as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
    expect(hashesToHexArray(wPerFile as Uint8Array)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });
});
