/**
 * Tests for updateFilesBulk with persistent fixtures (test/fixtures/hash-fixture/).
 * These fixtures are checked into git and never change, so we can hard-code
 * the expected hash values.
 *
 * Fixture layout:
 *   a.txt         "hello world\n"
 *   b.txt         "goodbye world\n"
 *   subdir/c.txt  "nested file\n"
 *   empty.txt     ""
 *   binary.bin    16 bytes  [0x00–0x0f]
 *   data-4k.bin   4096 bytes [0x00..0xff × 16]
 *   unicode.txt   "日本語テスト 🚀 émojis\n"
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hashesToHexArray, XXHash128, XXHash128Wasm } from "../packages/fast-fs-hash/src/index";

// ── Persistent fixture paths ─────────────────────────────────────────────

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/hash-fixture");

const fp = (name: string) => path.join(FIXTURE_DIR, name);

const ALL_FIXTURE_FILES = [
  fp("a.txt"),
  fp("b.txt"),
  fp("subdir/c.txt"),
  fp("empty.txt"),
  fp("binary.bin"),
  fp("data-4k.bin"),
  fp("unicode.txt"),
];

// ── Known expected values (xxHash3-128, seed 0) ──────────────────────────

/** Per-file digests in the order listed in ALL_FIXTURE_FILES */
const FIXTURE_PER_FILE: Record<string, string> = {
  "a.txt": "eefac9d87100cd1336b2e733a5484425",
  "b.txt": "472e10c9821c728278f31afb08378f2f",
  "subdir/c.txt": "83aa87b8500caa36868059af27b50144",
  "empty.txt": "99aa06d3014798d86001c324468d497f",
  "binary.bin": "e0194ecd93d341fbbf695305fea38fdf",
  "data-4k.bin": "ec46ab05c6f72ef0a63b8d1b62060cea",
  "unicode.txt": "65536faef932efb92ad89e94e0a02223",
};

/** Combined digest of ALL 7 fixture files (in the order above) */
const ALL_COMBINED = "7ee7d0543ef1f9dab996f42490a51f13";

const EXPECTED_HEX_ARRAY = ALL_FIXTURE_FILES.map((f) => {
  const name = path.relative(FIXTURE_DIR, f).replaceAll("\\", "/");
  return FIXTURE_PER_FILE[name];
});

// Zero hash for missing files
const H_ZERO = "0".repeat(32);

// ── Init ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await XXHash128Wasm.init();
  await XXHash128.init();
});

// ── Test both implementations ────────────────────────────────────────────

type HasherClass = typeof XXHash128 | typeof XXHash128Wasm;

const implementations: [string, HasherClass][] = [
  ["XXHash128 (native)", XXHash128],
  ["XXHash128Wasm", XXHash128Wasm],
];

describe.each(implementations)("%s — persistent fixtures", (_name, Hasher) => {
  // ── All 7 files ────────────────────────────────────────────────────

  it("7 files combined digest", async () => {
    const h = new Hasher();
    await h.updateFilesBulk(ALL_FIXTURE_FILES);
    expect(h.digest().toString("hex")).toBe(ALL_COMBINED);
  });

  it("7 files per-file hashes", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk(ALL_FIXTURE_FILES, true);
    expect(h.digest().toString("hex")).toBe(ALL_COMBINED);
    expect(hashesToHexArray(pf as Uint8Array)).toEqual(EXPECTED_HEX_ARRAY);
  });

  it("7 files per-file into pre-allocated Buffer", async () => {
    const h = new Hasher();
    const out = Buffer.alloc(ALL_FIXTURE_FILES.length * 16);
    const result = await h.updateFilesBulk(ALL_FIXTURE_FILES, out);
    expect(result).toBe(out);
    expect(hashesToHexArray(out)).toEqual(EXPECTED_HEX_ARRAY);
    expect(h.digest().toString("hex")).toBe(ALL_COMBINED);
  });

  // ── Individual files ───────────────────────────────────────────────

  for (const [name, expected] of Object.entries(FIXTURE_PER_FILE)) {
    it(`individual file: ${name}`, async () => {
      const h = new Hasher();
      const pf = await h.updateFilesBulk([fp(name)], true);
      expect(hashesToHexArray(pf as Uint8Array)).toEqual([expected]);
    });
  }

  // ── Subset & ordering ─────────────────────────────────────────────

  it("subset: a.txt + b.txt", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk([fp("a.txt"), fp("b.txt")], true);
    expect(hashesToHexArray(pf as Uint8Array)).toEqual([FIXTURE_PER_FILE["a.txt"], FIXTURE_PER_FILE["b.txt"]]);
    expect(h.digest().toString("hex")).toBe("14cb7b529dbb3358999291d5315f9ec8");
  });

  it("subset: b.txt + a.txt (reversed)", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk([fp("b.txt"), fp("a.txt")], true);
    expect(hashesToHexArray(pf as Uint8Array)).toEqual([FIXTURE_PER_FILE["b.txt"], FIXTURE_PER_FILE["a.txt"]]);
    expect(h.digest().toString("hex")).toBe("b96712ebc4252558f427015fab836b59");
  });

  it("subset: a.txt + b.txt + subdir/c.txt", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk([fp("a.txt"), fp("b.txt"), fp("subdir/c.txt")], true);
    expect(hashesToHexArray(pf as Uint8Array)).toEqual([
      FIXTURE_PER_FILE["a.txt"],
      FIXTURE_PER_FILE["b.txt"],
      FIXTURE_PER_FILE["subdir/c.txt"],
    ]);
    expect(h.digest().toString("hex")).toBe("310258854c72a729c6d3151d057d20bb");
  });

  // ── Missing files (zero hashes) ───────────────────────────────────

  it("missing file produces zero hash in per-file output", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk([fp("a.txt"), "/no/such/file.txt"], true);
    expect(hashesToHexArray(pf as Uint8Array)).toEqual([FIXTURE_PER_FILE["a.txt"], H_ZERO]);
    expect(h.digest().toString("hex")).toBe("3bd4a3acde4c43af41d10b55b7dcc098");
  });

  // ── Empty list ────────────────────────────────────────────────────

  it("empty list with allFiles=true returns empty buffer", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk([], true);
    expect(pf).not.toBeNull();
    expect((pf as Buffer).length).toBe(0);
  });

  // ── Single empty file ─────────────────────────────────────────────

  it("single empty file", async () => {
    const h = new Hasher();
    const pf = await h.updateFilesBulk([fp("empty.txt")], true);
    expect(hashesToHexArray(pf as Uint8Array)).toEqual([FIXTURE_PER_FILE["empty.txt"]]);
    expect(h.digest().toString("hex")).toBe("88dffc9e4422ed4caabe9acf44c07a05");
  });

  // ── Determinism ───────────────────────────────────────────────────

  it("deterministic across calls", async () => {
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const h = new Hasher();
      await h.updateFilesBulk(ALL_FIXTURE_FILES);
      results.push(h.digest().toString("hex"));
    }
    for (const r of results) {
      expect(r).toBe(ALL_COMBINED);
    }
  });
});

// ── Cross-implementation for persistent fixtures ─────────────────────────

describe("Native ↔ WASM — persistent fixtures", () => {
  it("combined digest matches", async () => {
    const hn = new XXHash128();
    const hw = new XXHash128Wasm();
    await hn.updateFilesBulk(ALL_FIXTURE_FILES);
    await hw.updateFilesBulk(ALL_FIXTURE_FILES);
    expect(hn.digest().toString("hex")).toBe(ALL_COMBINED);
    expect(hw.digest().toString("hex")).toBe(ALL_COMBINED);
  });

  it("all per-file hashes match", async () => {
    const hn = new XXHash128();
    const nPf = await hn.updateFilesBulk(ALL_FIXTURE_FILES, true);
    const hw = new XXHash128Wasm();
    const wPf = await hw.updateFilesBulk(ALL_FIXTURE_FILES, true);
    const nHex = hashesToHexArray(nPf as Uint8Array);
    const wHex = hashesToHexArray(wPf as Uint8Array);
    expect(nHex).toEqual(EXPECTED_HEX_ARRAY);
    expect(wHex).toEqual(EXPECTED_HEX_ARRAY);
  });

  for (const [name, expected] of Object.entries(FIXTURE_PER_FILE)) {
    it(`individual file matches: ${name}`, () => {
      const content = readFileSync(fp(name));
      const nativeHash = XXHash128.hash(content).toString("hex");
      const wasmHash = XXHash128Wasm.hash(content).toString("hex");
      expect(nativeHash).toBe(expected);
      expect(wasmHash).toBe(expected);
    });
  }
});
