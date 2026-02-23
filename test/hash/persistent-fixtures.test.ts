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

// Two-level aggregate: hash of concatenated per-file hashes.
// digestFilesParallel replicates this scheme.
const ALL_COMBINED = "7ee7d0543ef1f9dab996f42490a51f13";

describe.each(ALL_BACKENDS)("%s — persistent fixtures", (_name, backend) => {
  const { digestFile, digestFilesParallel, digestFilesParallelTo, XxHash128Stream } = backend;

  it("7 files combined digest via digestFilesParallel", async () => {
    const aggregate = await digestFilesParallel(ALL_FIXTURE_FILES);
    expect(aggregate.toString("hex")).toBe(ALL_COMBINED);
  });

  it("7 files combined digest via digestFilesParallelTo", async () => {
    const out = Buffer.alloc(16);
    await digestFilesParallelTo(ALL_FIXTURE_FILES, out);
    expect(out.toString("hex")).toBe(ALL_COMBINED);
  });

  for (const [name, expected] of Object.entries(FIXTURE_PER_FILE)) {
    it(`individual file digest: ${name}`, async () => {
      const hash = await digestFile(fp(name));
      expect(hash.toString("hex")).toBe(expected);
    });
  }

  it("subset: a.txt + b.txt", async () => {
    const aggregate = await digestFilesParallel([fp("a.txt"), fp("b.txt")]);
    expect(aggregate.toString("hex")).toBe("14cb7b529dbb3358999291d5315f9ec8");
  });

  it("subset: b.txt + a.txt (reversed)", async () => {
    const aggregate = await digestFilesParallel([fp("b.txt"), fp("a.txt")]);
    expect(aggregate.toString("hex")).toBe("b96712ebc4252558f427015fab836b59");
  });

  it("subset: a.txt + b.txt + subdir/c.txt", async () => {
    const aggregate = await digestFilesParallel([fp("a.txt"), fp("b.txt"), fp("subdir/c.txt")]);
    expect(aggregate.toString("hex")).toBe("310258854c72a729c6d3151d057d20bb");
  });

  it("empty list returns zero digest", async () => {
    const aggregate = await digestFilesParallel([]);
    expect(aggregate.length).toBe(16);
  });

  it("single empty file", async () => {
    const aggregate = await digestFilesParallel([fp("empty.txt")]);
    expect(aggregate.toString("hex")).toBe("88dffc9e4422ed4caabe9acf44c07a05");
  });

  it("deterministic across calls", async () => {
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const aggregate = await digestFilesParallel(ALL_FIXTURE_FILES);
      results.push(aggregate.toString("hex"));
    }
    for (const r of results) {
      expect(r).toBe(ALL_COMBINED);
    }
  });

  it("digestFilesParallel matches stream addFilesParallel", async () => {
    const standalone = await digestFilesParallel(ALL_FIXTURE_FILES);
    const stream = new XxHash128Stream();
    await stream.addFilesParallel(ALL_FIXTURE_FILES);
    expect(standalone.toString("hex")).toBe(stream.digest().toString("hex"));
  });

  describe("XxHash128Stream — persistent fixtures", () => {
    it("7 files combined digest via addFilesParallel stream", async () => {
      const stream = new XxHash128Stream();
      await stream.addFilesParallel(ALL_FIXTURE_FILES);
      expect(stream.digest().toString("hex")).toBe(ALL_COMBINED);
    });

    it("missing file produces zero hash (throwOnError = false)", async () => {
      const stream = new XxHash128Stream();
      await stream.addFilesParallel([fp("a.txt"), "/no/such/file.txt"], 0, false);
      expect(stream.digest().toString("hex")).toBe("3bd4a3acde4c43af41d10b55b7dcc098");
    });
  });
});
