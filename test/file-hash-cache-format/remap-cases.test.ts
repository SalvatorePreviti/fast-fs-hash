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

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-format-remap");
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
  it("remove file from start: indices shift correctly (old[1]->new[0], old[2]->new[1])", async () => {
    const cp = cachePath("rm-start");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
    const files2 = [fixtureFile("b.txt"), fixtureFile("c.txt")]; // a removed

    {
      await using c = new Ctor(cp, { version: 4, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    {
      await using c = new Ctor(cp, { version: 4, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 4, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 4 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("add file at start: indices shift correctly (old[0]->new[1], old[1]->new[2])", async () => {
    const cp = cachePath("add-start");
    const files1 = [fixtureFile("b.txt"), fixtureFile("c.txt")];
    const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")]; // a added at start

    {
      await using c = new Ctor(cp, { version: 6, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    {
      await using c = new Ctor(cp, { version: 6, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 6, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 6 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("interleaved add+remove: old[a,c,e] -> new[b,c,d] (only c survives)", async () => {
    const cp = cachePath("interleave");
    const files1 = [fixtureFile("a.txt"), fixtureFile("c.txt"), fixtureFile("e.txt")];
    const files2 = [fixtureFile("b.txt"), fixtureFile("c.txt"), fixtureFile("d.txt")];

    {
      await using c = new Ctor(cp, { version: 2, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

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

  it("no overlap replacement: old[a,b] -> new[d,e] (all entries fresh)", async () => {
    const cp = cachePath("no-overlap");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    const files2 = [fixtureFile("d.txt"), fixtureFile("e.txt")]; // completely disjoint

    {
      await using c = new Ctor(cp, { version: 3, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    {
      await using c = new Ctor(cp, { version: 3, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 3, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 3 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("grow from 1 to 5: single file remapped among 4 new files", async () => {
    const cp = cachePath("grow-1-5");
    const files1 = [fixtureFile("c.txt")]; // c sorts in the middle
    const files2 = [
      fixtureFile("a.txt"),
      fixtureFile("b.txt"),
      fixtureFile("c.txt"),
      fixtureFile("d.txt"),
      fixtureFile("e.txt"),
    ];

    {
      await using c = new Ctor(cp, { version: 8, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    {
      await using c = new Ctor(cp, { version: 8, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 8, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 8 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("shrink from 5 to 1: only surviving file remapped correctly", async () => {
    const cp = cachePath("shrink-5-1");
    const files1 = [
      fixtureFile("a.txt"),
      fixtureFile("b.txt"),
      fixtureFile("c.txt"),
      fixtureFile("d.txt"),
      fixtureFile("e.txt"),
    ];
    const files2 = [fixtureFile("c.txt")]; // c was at old index 2, new index 0

    {
      await using c = new Ctor(cp, { version: 9, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    {
      await using c = new Ctor(cp, { version: 9, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 9, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 9 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("modified file + remap: F_HAS_OLD entry with changed stat forces rehash", async () => {
    const cp = cachePath("mod-remap");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    // Write initial cache.
    {
      await using c = new Ctor(cp, { version: 11, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Modify a.txt — stat will differ from old cache entry.
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(fixtureFile("a.txt"), "hello world modified\n");

    // Add c.txt and reopen -> remap gives a F_HAS_OLD (stat changed->rehash),
    // b F_HAS_OLD (unchanged->keep), c F_NOT_CHECKED (fresh).
    const files2 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
    {
      await using c = new Ctor(cp, { version: 11, writable: true });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({ wasmBit, version: 11, files: sorted, stats, hashes });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 11 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }

    // Restore original content for other tests.
    writeFileSync(fixtureFile("a.txt"), "hello world\n");
  });

  it("multiple consecutive remaps: state correctly reset between operations", async () => {
    const cp = cachePath("multi-remap");

    // Step 1: cache [a, b, c, d, e]
    const all5 = [
      fixtureFile("a.txt"),
      fixtureFile("b.txt"),
      fixtureFile("c.txt"),
      fixtureFile("d.txt"),
      fixtureFile("e.txt"),
    ];
    {
      await using c = new Ctor(cp, { version: 20, writable: true });
      c.setFiles(all5);
      await c.validate();
      await c.serialize();
    }

    // Step 2: shrink to [b, d] — a(removed), b(1->0), c(removed), d(3->1), e(removed)
    const bd = [fixtureFile("b.txt"), fixtureFile("d.txt")];
    {
      await using c = new Ctor(cp, { version: 20, writable: true });
      c.setFiles(bd);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }
    {
      const sorted = [...bd].sort();
      const { stats, hashes } = await statAndHash(sorted);
      const expected = buildExpected({ wasmBit, version: 20, files: sorted, stats, hashes });
      expect(readFileSync(cp)).toEqual(expected);
    }

    // Step 3: grow to [a, c, e] — no overlap with [b, d], all fresh
    const ace = [fixtureFile("a.txt"), fixtureFile("c.txt"), fixtureFile("e.txt")];
    {
      await using c = new Ctor(cp, { version: 20, writable: true });
      c.setFiles(ace);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }
    {
      const sorted = [...ace].sort();
      const { stats, hashes } = await statAndHash(sorted);
      const expected = buildExpected({ wasmBit, version: 20, files: sorted, stats, hashes });
      expect(readFileSync(cp)).toEqual(expected);
    }

    // Step 4: grow back to [a, b, c, d, e] — a(0->0), c(1->2), e(2->4), b+d fresh
    {
      await using c = new Ctor(cp, { version: 20, writable: true });
      c.setFiles(all5);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }
    {
      const sorted = [...all5].sort();
      const { stats, hashes } = await statAndHash(sorted);
      const expected = buildExpected({ wasmBit, version: 20, files: sorted, stats, hashes });
      expect(readFileSync(cp)).toEqual(expected);
    }

    // Step 5: validate succeeds with the final file list.
    {
      await using c = new Ctor(cp, { version: 20 });
      c.setFiles(all5);
      expect(await c.validate()).toBe(true);
    }
  });

  it("reverse order remap: old[a,b,c] -> new[c,b,a] (same sorted set, no remap)", async () => {
    const cp = cachePath("reverse");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt"), fixtureFile("c.txt")];
    // Providing in reverse order — setFiles sorts, so the actual set is identical.
    const files2 = [fixtureFile("c.txt"), fixtureFile("b.txt"), fixtureFile("a.txt")];

    {
      await using c = new Ctor(cp, { version: 7, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Same files in different input order -> validate should PASS (sorted set matches).
    {
      await using c = new Ctor(cp, { version: 7 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("remap with fingerprint: remapped entries correct despite fingerprint mismatch skipping remap", async () => {
    const cp = cachePath("fp-mismatch");
    const fp1 = new Uint8Array(16);
    fp1.fill(0x11);
    const fp2 = new Uint8Array(16);
    fp2.fill(0x22);

    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    const files2 = [fixtureFile("b.txt"), fixtureFile("c.txt")];

    // Write with fp1.
    {
      await using c = new Ctor(cp, { version: 1, writable: true, fingerprint: fp1 });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Open with fp2 + different files -> fingerprint mismatch blocks remap.
    // All entries must be computed from scratch.
    {
      await using c = new Ctor(cp, { version: 1, writable: true, fingerprint: fp2 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(false);
      await c.serialize();
    }

    const sorted = [...files2].sort();
    const { stats, hashes } = await statAndHash(sorted);
    const expected = buildExpected({
      wasmBit,
      version: 1,
      files: sorted,
      stats,
      hashes,
      fingerprint: fp2,
    });
    const actual = readFileSync(cp);
    expect(actual).toEqual(expected);

    {
      await using c = new Ctor(cp, { version: 1, fingerprint: fp2 });
      c.setFiles(files2);
      expect(await c.validate()).toBe(true);
    }
  });

  it("remap with version mismatch: no remap, all entries computed fresh", async () => {
    const cp = cachePath("ver-mismatch");
    const files1 = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    const files2 = [fixtureFile("b.txt"), fixtureFile("c.txt")];

    {
      await using c = new Ctor(cp, { version: 1, writable: true });
      c.setFiles(files1);
      await c.validate();
      await c.serialize();
    }

    // Different version -> magic/version check fails -> no remap, no old entries.
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
});
