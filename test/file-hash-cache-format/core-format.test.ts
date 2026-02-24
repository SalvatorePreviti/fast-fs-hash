import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileHashCacheBase, FileHashCacheOptions } from "fast-fs-hash";
import { encodeFilePaths, FileHashCache, FileHashCacheWasm, XXHash128 } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

//  - Fixture setup

type CacheCtor = new (rootPath: string, filePath: string, options?: FileHashCacheOptions) => FileHashCacheBase;

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-format-core");
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
  dv.setUint32(H_FILE_COUNT * 4, n, true);
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

/** Convert absolute file paths to paths relative to the test fixture dir. */
function toRelPaths(absPaths: string[]): string[] {
  return absPaths.map((f) => path.relative(FIXTURE_DIR, f));
}

//  - Tests

const backends = [
  { name: "native", Ctor: FileHashCache as CacheCtor },
  { name: "wasm", Ctor: FileHashCacheWasm as CacheCtor },
] as const;

describe.each(backends)("FileHashCache binary format ($name)", (backend) => {
  const { Ctor } = backend;

  it("zero files: serialize returns 'deleted' and removes old cache", async () => {
    const cp = cachePath();
    // First, create a cache file with some content.
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 1 });
      cache.setFiles([fixtureFile("a.txt")]);
      await cache.validate();
      await cache.serialize();
    }
    expect(existsSync(cp)).toBe(true);

    // Now serialize with zero files — should delete the cache.
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 1 });
      cache.setFiles([]);
      await cache.validate();
      const result = await cache.serialize();
      expect(result).toBe("deleted");
    }
    expect(existsSync(cp)).toBe(false);
  });

  it("single file: every byte matches expected header + entry + path", async () => {
    const cp = cachePath();
    const file = fixtureFile("a.txt");
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 42 });
      cache.setFiles([file]);
      await cache.validate();
      await cache.serialize();
    }

    const sorted = [file];
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ version: 42, files: toRelPaths(sorted), stats, hashes });

    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);
  });

  it("three files (unsorted input): sorted entries and paths match byte-for-byte", async () => {
    const cp = cachePath();
    const files = [fixtureFile("c.txt"), fixtureFile("a.txt"), fixtureFile("b.txt")];
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 7 });
      cache.setFiles(files);
      await cache.validate();
      await cache.serialize();
    }

    const sorted = [...files].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ version: 7, files: toRelPaths(sorted), stats, hashes });

    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);
  });

  it("fingerprint: 16 bytes at offset 28 match byte-for-byte", async () => {
    const fp = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      fp[i] = (i + 1) * 0x11;
    }
    const cp = cachePath();
    const file = fixtureFile("b.txt");
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 5, fingerprint: fp });
      cache.setFiles([file]);
      await cache.validate();
      await cache.serialize();
    }

    const sorted = [file];
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ version: 5, files: toRelPaths(sorted), stats, hashes, fingerprint: fp });

    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);
  });

  it("userValue0-3: slots 2-5 match byte-for-byte", async () => {
    const cp = cachePath();
    const file = fixtureFile("a.txt");
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 3 });
      cache.setFiles([file]);
      await cache.validate();
      cache.userValue0 = 0xdeadbeef;
      cache.userValue1 = 0xcafebabe;
      cache.userValue2 = 0x12345678;
      cache.userValue3 = 0xaabbccdd;
      await cache.serialize();
    }

    const sorted = [file];
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({
      version: 3,
      files: toRelPaths(sorted),
      stats,
      hashes,
      userValues: [0xdeadbeef, 0xcafebabe, 0x12345678, 0xaabbccdd],
    });

    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);
  });

  it("all options combined: version + fingerprint + userValue0-3 + 3 files", async () => {
    const fp = new Uint8Array(16);
    fp.fill(0xab);
    const cp = cachePath();
    const files = [fixtureFile("b.txt"), fixtureFile("c.txt"), fixtureFile("a.txt")];
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 99, fingerprint: fp });
      cache.setFiles(files);
      await cache.validate();
      cache.userValue0 = 1;
      cache.userValue1 = 2;
      cache.userValue2 = 3;
      cache.userValue3 = 4;
      await cache.serialize();
    }

    const sorted = [...files].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({
      version: 99,
      files: toRelPaths(sorted),
      stats,
      hashes,
      fingerprint: fp,
      userValues: [1, 2, 3, 4],
    });

    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);
  });

  it("with user data: core + appended payload match byte-for-byte", async () => {
    const cp = cachePath();
    const file = fixtureFile("a.txt");
    const userData = Buffer.from("my custom payload\x00\xff\xfe");
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 1 });
      cache.setFiles([file]);
      await cache.validate();
      await cache.serialize();
      await cache.write(userData);
      cache.position += userData.length;
    }

    const sorted = [file];
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ version: 1, files: toRelPaths(sorted), stats, hashes, userData });

    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);
  });

  it("user data readable via FileHashCache.read() round-trip", async () => {
    const cp = cachePath();
    const file = fixtureFile("a.txt");
    const payload = Buffer.from("readable-payload");
    {
      await using cache = new Ctor(FIXTURE_DIR, cp, { version: 1 });
      cache.setFiles([file]);
      await cache.validate();
      await cache.serialize();
      await cache.write(payload);
      cache.position += payload.length;
    }

    await using reader = new Ctor(FIXTURE_DIR, cp, { version: 1 });
    reader.setFiles([file]);
    expect(await reader.validate()).toBe(true);

    const buf = Buffer.alloc(payload.length);
    const n = await reader.read(buf);
    expect(n).toBe(payload.length);
    expect(buf).toEqual(payload);
  });

  it("writing twice produces identical bytes", async () => {
    const cp1 = cachePath();
    const cp2 = cachePath();
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    {
      await using c1 = new Ctor(FIXTURE_DIR, cp1, { version: 7 });
      c1.setFiles(files);
      await c1.validate();
      await c1.serialize();
    }
    {
      await using c2 = new Ctor(FIXTURE_DIR, cp2, { version: 7 });
      c2.setFiles(files);
      await c2.validate();
      await c2.serialize();
    }
    expect(readFileSync(cp1)).toEqual(readFileSync(cp2));
  });

  it("constants match documented values", () => {
    expect(MAGIC).toBe(0x00485346);
    expect(HEADER_SIZE).toBe(64);
    expect(ENTRY_STRIDE).toBe(48);
    expect(H_MAGIC).toBe(0);
    expect(H_VERSION).toBe(1);
    expect(H_USER).toBe(2);
    expect(H_FILE_COUNT).toBe(6);
    expect(H_FINGERPRINT_BYTE).toBe(28);
    expect(H_PATHS_LEN).toBe(11);
  });

  //  - File list changes: add/remove files, verify format correctness
});
