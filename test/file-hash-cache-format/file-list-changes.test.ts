import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileHashCache } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache";
import type { FileHashCacheBase } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-base";
import {
  ENTRY_STRIDE,
  H_FILE_COUNT,
  H_FINGERPRINT_BYTE,
  H_MAGIC,
  H_PATHS_LEN,
  H_USER,
  H_VERSION,
  HEADER_SIZE,
  MAGIC,
} from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-base";
import { FileHashCacheWasm } from "../../packages/fast-fs-hash/src/file-cache/file-hash-cache-wasm";
import type { FileHashCacheOptions } from "../../packages/fast-fs-hash/src/file-cache/types";
import { encodeFilePaths } from "../../packages/fast-fs-hash/src/functions";
import { XXHash128 } from "../../packages/fast-fs-hash/src/xxhash128/xxhash128";

//  - Fixture setup

type CacheCtor = new (filePath: string, options?: FileHashCacheOptions) => FileHashCacheBase;

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-format-file-list");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "fmt"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

beforeAll(async () => {
  await XXHash128.init();
  await FileHashCacheWasm.init();
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  writeFileSync(fixtureFile("a.txt"), "hello world\n");
  writeFileSync(fixtureFile("b.txt"), "goodbye world\n");
  writeFileSync(fixtureFile("c.txt"), "third file\n");
  writeFileSync(fixtureFile("d.txt"), "fourth file\n");
  writeFileSync(fixtureFile("e.txt"), "fifth file\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

//  - Expected-binary builder

/**
 * Build the exact expected binary output for a cache file from its components.
 *
 * Constructs the full byte sequence: header(64) + entries(N×48) + paths + userData.
 */
function buildExpected(opts: {
  version: number;
  wasmBit?: number;
  userValues?: [number, number, number, number];
  fingerprint?: Uint8Array;
  /** Sorted file paths. */
  files: string[];
  /** Stats for each file (same order as files, i.e. sorted). */
  stats: ReturnType<typeof statSync>[];
  /** Hashes for each file (same order as files, i.e. sorted). */
  hashes: Buffer[];
  userData?: Buffer;
}): Buffer {
  const n = opts.files.length;
  const wasmBit = opts.wasmBit ?? 0;
  const pathsBuf = n > 0 ? encodeFilePaths(opts.files) : Buffer.alloc(0);
  const pathsLen = pathsBuf.length;
  const entriesLen = n * ENTRY_STRIDE;
  const coreLen = HEADER_SIZE + entriesLen + pathsLen;
  const userDataLen = opts.userData ? opts.userData.length : 0;
  const totalLen = coreLen + userDataLen;

  const buf = Buffer.alloc(totalLen);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  //  - Header (64 bytes)
  dv.setUint32(H_MAGIC * 4, MAGIC, true);
  dv.setUint32(H_VERSION * 4, opts.version, true);
  const uv = opts.userValues ?? [0, 0, 0, 0];
  dv.setUint32((H_USER + 0) * 4, uv[0], true);
  dv.setUint32((H_USER + 1) * 4, uv[1], true);
  dv.setUint32((H_USER + 2) * 4, uv[2], true);
  dv.setUint32((H_USER + 3) * 4, uv[3], true);
  // file count with wasm bit: (count << 1) | wasmBit
  dv.setUint32(H_FILE_COUNT * 4, (n << 1) | wasmBit, true);
  if (opts.fingerprint) {
    buf.set(opts.fingerprint, H_FINGERPRINT_BYTE);
  }
  // else: already zero from Buffer.alloc
  dv.setUint32(H_PATHS_LEN * 4, pathsLen, true);
  // Slots 12-15 reserved = 0 (already zero)

  //  - Entries (N × 48 bytes)
  for (let i = 0; i < n; i++) {
    const off = HEADER_SIZE + i * ENTRY_STRIDE;
    const s = opts.stats[i] as ReturnType<typeof statSync> & {
      ino: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
      size: bigint;
    };
    dv.setBigUint64(off + 0, s.ino, true);
    dv.setBigUint64(off + 8, s.mtimeNs, true);
    dv.setBigUint64(off + 16, s.ctimeNs, true);
    dv.setBigUint64(off + 24, s.size, true);
    buf.set(opts.hashes[i], off + 32);
  }

  //  - Paths
  if (pathsLen > 0) {
    buf.set(pathsBuf, HEADER_SIZE + entriesLen);
  }

  //  - User data
  if (opts.userData && userDataLen > 0) {
    buf.set(opts.userData, coreLen);
  }

  return buf;
}

/** Stat files (bigint) and hash them, returning parallel arrays in the given order. */
async function statAndHash(files: string[]): Promise<{ stats: ReturnType<typeof statSync>[]; hashes: Buffer[] }> {
  const stats = files.map((f) => statSync(f, { bigint: true }));
  const hashes = await Promise.all(files.map((f) => XXHash128.hashFile(f)));
  return { stats, hashes };
}

//  - Tests

const backends = [
  { name: "native", Ctor: FileHashCache as CacheCtor, wasmBit: 0 },
  { name: "wasm", Ctor: FileHashCacheWasm as CacheCtor, wasmBit: 1 },
] as const;

describe.each(backends)("FileHashCache binary format ($name)", ({ Ctor, wasmBit }) => {
  it("add file at end: serialize produces correct byte-for-byte output", async () => {
    const cp = cachePath("add-end");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

    // Write initial cache with 2 files.
    {
      await using c = new Ctor(cp, { version: 10, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Add file at end -> validate fails, serialize rewrites.
    {
      await using c = new Ctor(cp, { version: 10, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    // Verify the binary matches expected format byte-for-byte.
    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 10, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    // Re-validate succeeds.
    {
      await using c = new Ctor(cp, { version: 10 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("add file in middle: serialize produces correct byte-for-byte output", async () => {
    const cp = cachePath("add-mid");
    const files1 = [fixtureFile("a.txt"), fixtureFile("c.txt")];
    // b.txt sorts between a.txt and c.txt.
    const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];

    // Write initial cache with 2 files (a, c).
    {
      await using c = new Ctor(cp, { version: 7, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Add file in middle -> validate fails, serialize rewrites.
    {
      await using c = new Ctor(cp, { version: 7, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    // Verify byte-for-byte.
    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 7, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    // Re-validate succeeds.
    {
      await using c = new Ctor(cp, { version: 7 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("remove file from middle: serialize produces correct byte-for-byte output", async () => {
    const cp = cachePath("rm-mid");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
    const files2 = [fixtureFile("a.txt"), fixtureFile("c.txt")];

    // Write initial cache with 3 files.
    {
      await using c = new Ctor(cp, { version: 3, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Remove file from middle -> validate fails, serialize rewrites.
    {
      await using c = new Ctor(cp, { version: 3, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    // Verify byte-for-byte.
    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 3, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    // Re-validate succeeds.
    {
      await using c = new Ctor(cp, { version: 3 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("remove file from end: serialize produces correct byte-for-byte output", async () => {
    const cp = cachePath("rm-end");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
    const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    {
      await using c = new Ctor(cp, { version: 1, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    {
      await using c = new Ctor(cp, { version: 1, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 1, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 1 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("replace entire file list: serialize produces correct byte-for-byte output", async () => {
    const cp = cachePath("replace-all");

    // Write initial cache with a.txt only.
    {
      await using c = new Ctor(cp, { version: 2, writable: true });
      c.setFiles([fixtureFile("a.txt")]);
      await c.validate();
      await c.serialize();
    }

    // Replace with completely different files.
    const files2 = [fixtureFile("b.txt"), fixtureFile("c.txt")];
    {
      await using c = new Ctor(cp, { version: 2, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 2, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 2 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("serialize without prior validate: correct output from scratch", async () => {
    const cp = cachePath("no-validate");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    // Skip validate, go straight to serialize.
    {
      await using c = new Ctor(cp, { version: 5, writable: true });
      c.setFiles(files);
      await c.serialize();
    }

    const sorted = [...files].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 5, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 5 });
      c.setFiles(files);
      expect(await c.validate()).toBe(true);
    }
  });

  //  - Remap correctness: thorough index remapping tests
});
