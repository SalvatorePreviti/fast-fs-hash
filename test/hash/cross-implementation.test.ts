import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_BACKENDS } from "../xxhash128/_helpers_new";

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

describe.each(ALL_BACKENDS)("%s backend — persistent fixtures", (_name, backend) => {
  const { digestBuffer, digestFile, digestFilesParallel } = backend;

  it("combined digest matches", async () => {
    const aggregate = await digestFilesParallel(ALL_FIXTURE_FILES);
    expect(aggregate.toString("hex")).toBe(ALL_COMBINED);
  });

  for (const [name, expected] of Object.entries(FIXTURE_PER_FILE)) {
    it(`individual file matches: ${name}`, () => {
      const content = readFileSync(fp(name));
      const hash = digestBuffer(content).toString("hex");
      expect(hash).toBe(expected);
    });
  }

  for (const [name, expected] of Object.entries(FIXTURE_PER_FILE)) {
    it(`individual file via digestFile matches: ${name}`, async () => {
      const hash = await digestFile(fp(name));
      expect(hash.toString("hex")).toBe(expected);
    });
  }
});
