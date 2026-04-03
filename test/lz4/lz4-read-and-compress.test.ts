import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lz4DecompressAndWrite, lz4DecompressBlock, lz4ReadAndCompress } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_DIR = join(__dirname, "..", "tmp", "lz4-read-and-compress");

beforeAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function tmpFile(name: string, content: Buffer): string {
  const p = join(TMP_DIR, name);
  writeFileSync(p, content);
  return p;
}

describe("lz4ReadAndCompress", () => {
  it("compresses a file and round-trips correctly", async () => {
    const data = Buffer.from("Hello, LZ4 file compression! ".repeat(500));
    const path = tmpFile("roundtrip.bin", data);

    const result = await lz4ReadAndCompress(path);

    expect(result.uncompressedSize).toBe(data.length);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.length).toBeLessThan(data.length);

    const decompressed = lz4DecompressBlock(result.data, result.uncompressedSize);
    expect(Buffer.from(decompressed)).toEqual(data);
  });

  it("handles empty file", async () => {
    const path = tmpFile("empty.bin", Buffer.alloc(0));

    const result = await lz4ReadAndCompress(path);

    expect(result.uncompressedSize).toBe(0);
    expect(result.data.length).toBe(0);
  });

  it("handles small file (1 byte)", async () => {
    const data = Buffer.from([0x42]);
    const path = tmpFile("tiny.bin", data);

    const result = await lz4ReadAndCompress(path);

    expect(result.uncompressedSize).toBe(1);
    expect(result.data.length).toBeGreaterThan(0);

    const decompressed = lz4DecompressBlock(result.data, result.uncompressedSize);
    expect(Buffer.from(decompressed)).toEqual(data);
  });

  it("handles incompressible data", async () => {
    const data = Buffer.alloc(4096);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 131 + 17) & 0xff;
    }
    const path = tmpFile("random.bin", data);

    const result = await lz4ReadAndCompress(path);

    expect(result.uncompressedSize).toBe(data.length);
    const decompressed = lz4DecompressBlock(result.data, result.uncompressedSize);
    expect(Buffer.from(decompressed)).toEqual(data);
  });

  it("handles large file (> 128 KiB)", async () => {
    const size = 256 * 1024;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4) {
      data.writeUInt32LE((i * 7 + 3) & 0xffffffff, i);
    }
    const path = tmpFile("large.bin", data);

    const result = await lz4ReadAndCompress(path);

    expect(result.uncompressedSize).toBe(size);
    const decompressed = lz4DecompressBlock(result.data, result.uncompressedSize);
    expect(Buffer.from(decompressed)).toEqual(data);
  }, 30_000);

  it("throws on non-existent file", async () => {
    await expect(lz4ReadAndCompress(join(TMP_DIR, "does-not-exist.bin"))).rejects.toThrow();
  });

  it("returns result with data as Buffer", async () => {
    const data = Buffer.from("test content");
    const path = tmpFile("type-check.bin", data);

    const result = await lz4ReadAndCompress(path);

    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(typeof result.uncompressedSize).toBe("number");
  });

  it("can compress multiple files concurrently", async () => {
    const files = Array.from({ length: 5 }, (_, i) => {
      const content = Buffer.from(`file-${i}-content `.repeat(100));
      return tmpFile(`conc-${i}.bin`, content);
    });

    const results = await Promise.all(files.map((f) => lz4ReadAndCompress(f)));

    for (const result of results) {
      expect(result.uncompressedSize).toBeGreaterThan(0);
      expect(result.data.length).toBeGreaterThan(0);
    }
  });
});

describe("lz4DecompressAndWrite", () => {
  it("round-trips with lz4ReadAndCompress", async () => {
    const data = Buffer.from("Hello, LZ4 decompress and write! ".repeat(200));
    const srcPath = tmpFile("dw-src.bin", data);

    const compressed = await lz4ReadAndCompress(srcPath);
    const outPath = join(TMP_DIR, "dw-roundtrip.bin");

    const result = await lz4DecompressAndWrite(compressed.data, compressed.uncompressedSize, outPath);
    expect(result).toBe(true);

    const written = readFileSync(outPath);
    expect(written).toEqual(data);
  });

  it("handles empty data", async () => {
    const outPath = join(TMP_DIR, "dw-empty.bin");
    const result = await lz4DecompressAndWrite(Buffer.alloc(0), 0, outPath);
    expect(result).toBe(true);

    const written = readFileSync(outPath);
    expect(written.length).toBe(0);
  });

  it("creates parent directories", async () => {
    const data = Buffer.from("nested dir test");
    const srcPath = tmpFile("dw-nested-src.bin", data);
    const compressed = await lz4ReadAndCompress(srcPath);

    const outPath = join(TMP_DIR, "nested", "deep", "dw-nested.bin");
    const result = await lz4DecompressAndWrite(compressed.data, compressed.uncompressedSize, outPath);
    expect(result).toBe(true);

    const written = readFileSync(outPath);
    expect(written).toEqual(data);
  });

  it("overwrites existing file", async () => {
    const outPath = join(TMP_DIR, "dw-overwrite.bin");
    writeFileSync(outPath, "old content that should be replaced entirely");

    const data = Buffer.from("new");
    const srcPath = tmpFile("dw-overwrite-src.bin", data);
    const compressed = await lz4ReadAndCompress(srcPath);

    await lz4DecompressAndWrite(compressed.data, compressed.uncompressedSize, outPath);
    const written = readFileSync(outPath);
    expect(written).toEqual(data);
  });

  it("handles small file (1 byte)", async () => {
    const data = Buffer.from([0xab]);
    const srcPath = tmpFile("dw-tiny-src.bin", data);
    const compressed = await lz4ReadAndCompress(srcPath);

    const outPath = join(TMP_DIR, "dw-tiny.bin");
    await lz4DecompressAndWrite(compressed.data, compressed.uncompressedSize, outPath);

    const written = readFileSync(outPath);
    expect(written).toEqual(data);
  });

  it("handles large file (> 128 KiB)", async () => {
    const size = 256 * 1024;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4) {
      data.writeUInt32LE((i * 13 + 7) & 0xffffffff, i);
    }
    const srcPath = tmpFile("dw-large-src.bin", data);
    const compressed = await lz4ReadAndCompress(srcPath);

    const outPath = join(TMP_DIR, "dw-large.bin");
    await lz4DecompressAndWrite(compressed.data, compressed.uncompressedSize, outPath);

    const written = readFileSync(outPath);
    expect(written).toEqual(data);
  }, 30_000);

  it("can write multiple files concurrently", async () => {
    const pairs = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const content = Buffer.from(`conc-write-${i} `.repeat(100));
        const srcPath = tmpFile(`dw-conc-src-${i}.bin`, content);
        const compressed = await lz4ReadAndCompress(srcPath);
        return { content, compressed, outPath: join(TMP_DIR, `dw-conc-out-${i}.bin`) };
      })
    );

    await Promise.all(
      pairs.map((p) => lz4DecompressAndWrite(p.compressed.data, p.compressed.uncompressedSize, p.outPath))
    );

    for (const p of pairs) {
      expect(readFileSync(p.outPath)).toEqual(p.content);
    }
  });
});
