import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hashesToHexArray, XXHash128, XXHash128Wasm } from "../../packages/fast-fs-hash/src/index";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/hash-fixture");

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

const FIXTURE_PER_FILE: Record<string, string> = {
  "a.txt": "eefac9d87100cd1336b2e733a5484425",
  "b.txt": "472e10c9821c728278f31afb08378f2f",
  "subdir/c.txt": "83aa87b8500caa36868059af27b50144",
  "empty.txt": "99aa06d3014798d86001c324468d497f",
  "binary.bin": "e0194ecd93d341fbbf695305fea38fdf",
  "data-4k.bin": "ec46ab05c6f72ef0a63b8d1b62060cea",
  "unicode.txt": "65536faef932efb92ad89e94e0a02223",
};

const ALL_COMBINED = "7ee7d0543ef1f9dab996f42490a51f13";

const EXPECTED_HEX_ARRAY = ALL_FIXTURE_FILES.map((f) => {
  const name = path.relative(FIXTURE_DIR, f).replaceAll("\\", "/");
  return FIXTURE_PER_FILE[name];
});

beforeAll(async () => {
  await XXHash128Wasm.init();
  await XXHash128.init();
});

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
