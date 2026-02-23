import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filesEqual } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_DIR = join(__dirname, "..", "tmp", "files-equal");

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

describe("filesEqual", () => {
  it("returns true for identical files", async () => {
    const data = Buffer.alloc(10000, 0xab);
    const a = tmpFile("eq-a.bin", data);
    const b = tmpFile("eq-b.bin", data);
    expect(await filesEqual(a, b)).toBe(true);
  });

  it("returns true for same file path", async () => {
    const a = tmpFile("same.bin", Buffer.alloc(5000, 0x42));
    expect(await filesEqual(a, a)).toBe(true);
  });

  it("returns true for both empty files", async () => {
    const a = tmpFile("empty-a.bin", Buffer.alloc(0));
    const b = tmpFile("empty-b.bin", Buffer.alloc(0));
    expect(await filesEqual(a, b)).toBe(true);
  });

  it("returns false when sizes differ", async () => {
    const a = tmpFile("sz-a.bin", Buffer.alloc(100, 0x11));
    const b = tmpFile("sz-b.bin", Buffer.alloc(200, 0x11));
    expect(await filesEqual(a, b)).toBe(false);
  });

  it("returns false when content differs (same size)", async () => {
    const a = tmpFile("diff-a.bin", Buffer.alloc(10000, 0xaa));
    const b = tmpFile("diff-b.bin", Buffer.alloc(10000, 0xbb));
    expect(await filesEqual(a, b)).toBe(false);
  });

  it("returns false when content differs only at the end", async () => {
    const bufA = Buffer.alloc(200000, 0xcc);
    const bufB = Buffer.from(bufA);
    bufB[bufB.length - 1] = 0xdd;
    const a = tmpFile("tail-a.bin", bufA);
    const b = tmpFile("tail-b.bin", bufB);
    expect(await filesEqual(a, b)).toBe(false);
  });

  it("returns false when first file does not exist", async () => {
    const b = tmpFile("exists.bin", Buffer.alloc(100));
    expect(await filesEqual(join(TMP_DIR, "nonexistent.bin"), b)).toBe(false);
  });

  it("returns false when second file does not exist", async () => {
    const a = tmpFile("exists2.bin", Buffer.alloc(100));
    expect(await filesEqual(a, join(TMP_DIR, "nonexistent2.bin"))).toBe(false);
  });

  it("returns false when both files do not exist", async () => {
    expect(await filesEqual(join(TMP_DIR, "nope1.bin"), join(TMP_DIR, "nope2.bin"))).toBe(false);
  });

  it("handles small files (1 byte)", async () => {
    const a = tmpFile("one-a.bin", Buffer.from([0x42]));
    const b = tmpFile("one-b.bin", Buffer.from([0x42]));
    const c = tmpFile("one-c.bin", Buffer.from([0x43]));
    expect(await filesEqual(a, b)).toBe(true);
    expect(await filesEqual(a, c)).toBe(false);
  });

  it("handles large files (> 128 KiB read buffer)", async () => {
    const size = 256 * 1024;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4) {
      data.writeUInt32LE(i * 7 + 3, i);
    }
    const a = tmpFile("large-a.bin", data);
    const b = tmpFile("large-b.bin", data);
    expect(await filesEqual(a, b)).toBe(true);

    const diffData = Buffer.from(data);
    diffData[size - 1] ^= 0xff;
    const c = tmpFile("large-c.bin", diffData);
    expect(await filesEqual(a, c)).toBe(false);
  });

  it("can run multiple comparisons concurrently", async () => {
    const data = Buffer.alloc(50000, 0x55);
    const a = tmpFile("conc-a.bin", data);
    const b = tmpFile("conc-b.bin", data);
    const c = tmpFile("conc-c.bin", Buffer.alloc(50000, 0x66));

    const results = await Promise.all([filesEqual(a, b), filesEqual(a, c), filesEqual(b, c), filesEqual(a, a)]);
    expect(results).toEqual([true, false, false, true]);
  });
});
