import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestFile, digestFilesToHexArray, digestFileToHex, hashToHex } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_DIR = join(__dirname, "..", "tmp", "digest-file-hex");

beforeAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function tmpFile(name: string, content: Buffer | string): string {
  const p = join(TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

describe("digestFileToHex", () => {
  it("returns a 32-character hex string", async () => {
    const path = tmpFile("hex-basic.txt", "hello world");
    const hex = await digestFileToHex(path);

    expect(hex).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches digestFile + hashToHex", async () => {
    const path = tmpFile("hex-match.txt", "consistency check");
    const [hex, digest] = await Promise.all([digestFileToHex(path), digestFile(path)]);

    expect(hex).toBe(hashToHex(digest));
  });

  it("returns different hashes for different content", async () => {
    const path1 = tmpFile("hex-diff-1.txt", "content A");
    const path2 = tmpFile("hex-diff-2.txt", "content B");

    const [hex1, hex2] = await Promise.all([digestFileToHex(path1), digestFileToHex(path2)]);
    expect(hex1).not.toBe(hex2);
  });

  it("handles empty file", async () => {
    const path = tmpFile("hex-empty.txt", "");
    const hex = await digestFileToHex(path);

    expect(hex).toMatch(/^[0-9a-f]{32}$/);
  });

  it("throws on non-existent file by default", async () => {
    await expect(digestFileToHex(join(TMP_DIR, "does-not-exist.txt"))).rejects.toThrow();
  });

  it("returns zero hash on error when throwOnError=false", async () => {
    const hex = await digestFileToHex(join(TMP_DIR, "does-not-exist.txt"), false);
    expect(hex).toBe("00000000000000000000000000000000");
  });
});

describe("digestFilesToHexArray", () => {
  it("returns per-file hex strings", async () => {
    const paths = [
      tmpFile("arr-1.txt", "file one"),
      tmpFile("arr-2.txt", "file two"),
      tmpFile("arr-3.txt", "file three"),
    ];

    const hexes = await digestFilesToHexArray(paths);

    expect(hexes).toHaveLength(3);
    for (const hex of hexes) {
      expect(hex).toMatch(/^[0-9a-f]{32}$/);
    }
    // All different content → all different hashes
    expect(new Set(hexes).size).toBe(3);
  });

  it("matches individual digestFileToHex calls", async () => {
    const paths = [tmpFile("arr-match-1.txt", "alpha"), tmpFile("arr-match-2.txt", "beta")];

    const [array, hex1, hex2] = await Promise.all([
      digestFilesToHexArray(paths),
      digestFileToHex(paths[0]),
      digestFileToHex(paths[1]),
    ]);

    expect(array[0]).toBe(hex1);
    expect(array[1]).toBe(hex2);
  });

  it("returns empty array for empty input", async () => {
    const result = await digestFilesToHexArray([]);
    expect(result).toEqual([]);
  });

  it("handles single file", async () => {
    const path = tmpFile("arr-single.txt", "only one");
    const result = await digestFilesToHexArray([path]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("preserves order", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => tmpFile(`arr-order-${i}.txt`, `content-${i}`));

    const hexes = await digestFilesToHexArray(paths);
    const individual = await Promise.all(paths.map((p) => digestFileToHex(p)));

    expect(hexes).toEqual(individual);
  });

  it("respects concurrency parameter", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => tmpFile(`arr-conc-${i}.txt`, `data-${i}`));

    const [hex1, hex2] = await Promise.all([digestFilesToHexArray(paths, 1), digestFilesToHexArray(paths, 16)]);

    expect(hex1).toEqual(hex2);
  });

  it("handles duplicate paths", async () => {
    const path = tmpFile("arr-dup.txt", "duplicate");
    const result = await digestFilesToHexArray([path, path, path]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(result[1]);
    expect(result[1]).toBe(result[2]);
  });

  it("throws on non-existent file by default", async () => {
    const paths = [tmpFile("arr-err-ok.txt", "ok"), join(TMP_DIR, "arr-err-missing.txt")];
    await expect(digestFilesToHexArray(paths)).rejects.toThrow();
  });

  it("returns zero hash for missing files when throwOnError=false", async () => {
    const goodPath = tmpFile("arr-nothrow-ok.txt", "ok");
    const paths = [goodPath, join(TMP_DIR, "arr-nothrow-missing.txt")];

    const result = await digestFilesToHexArray(paths, undefined, false);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(result[0]).not.toBe("00000000000000000000000000000000");
    expect(result[1]).toBe("00000000000000000000000000000000");
  });
});
