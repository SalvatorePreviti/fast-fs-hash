/**
 * Tests for file verification via per-file hashing.
 *
 * Key scenarios:
 * - Empty arrays → always true
 * - Length mismatch between paths/expectedHashes → false
 * - All files match → true
 * - One file mismatch → false
 * - Missing file with zero expected hash → match (zero == zero)
 * - Missing file with nonzero expected hash → mismatch
 * - Mix of existing and missing files
 * - Multiple files, all correct
 * - Multiple files, one wrong
 * - Early termination on mismatch
 * - Files at boundary sizes
 */

import { describe, expect, it } from "vitest";

import { ALL_BACKENDS, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("verify-files");

const BUF = 131072;
const READ_BUF = 131072;

//  - Known xxHash3-128 digests (seed 0,0)

/** makeBuffer(100, 0) */
const H_100 = "da95ef16fd9566f329b20ba5f03ec01e";
/** makeBuffer(1024, 0) */
const H_1024 = "83885e853bb6640ca870f92984398d22";
/** makeBuffer(512, 0) */
const H_512 = "111d5771df64cbcb1059105ad19bfa09";
/** makeBuffer(READ_BUF + 5000, 0) */
const H_READ_PLUS5000 = "914fa5ed8dad876a19a51d949704c197";

/** Boundary sizes for verify tests */
const H_VERIFY_BOUNDARY: Record<number, string> = {
  0: "99aa06d3014798d86001c324468d497f",
  1: "a6cd5e9392000f6ac44bdff4074eecdb",
  254: "5f1c718471269aa13293277bc8e5839a",
  255: "5914868aa80541d9b85fd37a0a050e63",
  256: "f1f8a93f50849ac39408a4433b952d71",
  [BUF - 1]: "0d8bc9f7c7a0ad547a1a6df4c883b693",
  [BUF]: "9507b6f5073d831d8e707008b17e014c",
  [BUF + 1]: "e4068c0fc25b3c45e39ce30528538126",
  1048576: "1b208d2839093774d36c0e13a3df139e",
};

/** many files: makeBuffer(100 + i*50, i) for i in 0..19 */
const H_VERIFY_MANY = [
  "da95ef16fd9566f329b20ba5f03ec01e",
  "137e8d96259217fc198928c68ee4a2e4",
  "2ac44bd1a43d79f3696ff975913af061",
  "57abee3e4bf3de06526ae0a8f3eaa5dd",
  "114b49467cddd5eed75bc32dfef624cb",
  "0119663e3218adab54e6396c476bd6e7",
  "08c918e6588254d1334cbc440fa08db5",
  "28512d09dd89ce9ecc18a9570ca8743f",
  "491a8460032205c0d56fcd343dc90620",
  "57db84a0bf69d73b48da7f215f59cdde",
  "69452d2fb803ca1911481b02f3b76dce",
  "76b6d15df222a464462648cbcd9e2249",
  "1b157d642f36809ec8edb1a9185b1d81",
  "35aa6297cb306389c925d10480c56027",
  "f3d54b71c4abae9d928a97950bc1a094",
  "728642ec065d3a8423feb72dd45d496e",
  "68601d3ddbcb29192888c41d42ad50f2",
  "5e62b91b7623ee7ef2a8143e5a7f66f8",
  "00f083e8d16942226da9ef163a0ae8fc",
  "d57a8ef71a1bcef98f334a9bb5cb63cf",
];

/** concurrency tests: makeBuffer(200 + i*100, i) for i in 0..4 */
const H_CONC1 = [
  "cb0395310643ba0edd97e9af3609d9f5",
  "f96206663aacfdd4f70f2c0a968c2c8b",
  "51d65c555c6bb8517dca57c99f965638",
  "766b4837f0e5abc9d8892e4f251d67ff",
  "190ec5b558c987d3a5377c931d05ee2d",
];

/** concurrency=2 tests: makeBuffer(200 + i*100, i) for i in 0..9 */
const H_CONC2 = [
  "cb0395310643ba0edd97e9af3609d9f5",
  "f96206663aacfdd4f70f2c0a968c2c8b",
  "51d65c555c6bb8517dca57c99f965638",
  "766b4837f0e5abc9d8892e4f251d67ff",
  "190ec5b558c987d3a5377c931d05ee2d",
  "321c0d8bbb15b615b4c3e6227300e159",
  "9a668b5d490f58087b2ce3a86f3d332c",
  "9005a4e6b3957441dd4117112a895524",
  "2bd03ae8a9850251b2591036d6911066",
  "c8958a1e1e4a3aeaaab869979b31276c",
];

/** Helper to decode a hex hash into a Buffer */
function hashBuf(h: string): Buffer {
  return Buffer.from(h, "hex");
}

//  - verifyFilesParallel

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { digestFile } = backend;

  /**
   * Verify that every file in `paths` hashes to the corresponding expected hash.
   *
   * @param paths          File paths to hash.
   * @param expectedHashes 16-byte Buffers with expected digests.
   * @param throwOnError   If false, missing/unreadable files produce a zero hash
   *                       instead of throwing. Default: true.
   * @param concurrency    Max parallel file reads (0 = default).
   * @returns true if all hashes match, false otherwise.
   */
  async function verifyFilesParallel(
    paths: readonly string[],
    expectedHashes: readonly Buffer[],
    throwOnError = true,
    concurrency = 0
  ): Promise<boolean> {
    if (paths.length !== expectedHashes.length) {
      return false;
    }
    if (paths.length === 0) {
      return true;
    }

    const zeroHash = Buffer.alloc(16);
    const effectiveConcurrency = concurrency > 0 ? concurrency : 8;

    // Hash all files with bounded concurrency
    const results: (Buffer | null)[] = new Array(paths.length).fill(null);
    let cursor = 0;

    const processNext = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= paths.length) {
          return;
        }
        try {
          results[idx] = await digestFile(paths[idx]);
        } catch {
          if (throwOnError) {
            throw new Error(`Failed to hash file: ${paths[idx]}`);
          }
          // Missing/unreadable file → zero hash
          results[idx] = zeroHash;
        }
      }
    };

    const lanes = Math.min(effectiveConcurrency, paths.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < lanes; i++) {
      workers.push(processNext());
    }
    await Promise.all(workers);

    for (let i = 0; i < paths.length; i++) {
      const result = results[i];
      if (!result?.equals(expectedHashes[i])) {
        return false;
      }
    }
    return true;
  }

  describe("verifyFilesParallel", () => {
    it("empty arrays → true", async () => {
      expect(await verifyFilesParallel([], [])).toBe(true);
    });

    it("paths.length !== expectedHashes.length → false", async () => {
      const p = writeFixture("len-mismatch.bin", makeBuffer(100));
      const hash = hashBuf(H_100);
      expect(await verifyFilesParallel([p], [hash, hash])).toBe(false);
      expect(await verifyFilesParallel([p, p], [hash])).toBe(false);
      expect(await verifyFilesParallel([], [hash])).toBe(false);
    });

    it("single file, correct hash → true", async () => {
      const path = writeFixture("verify-ok.bin", makeBuffer(1024));
      expect(await verifyFilesParallel([path], [hashBuf(H_1024)])).toBe(true);
    });

    it("single file, wrong hash → false", async () => {
      const path = writeFixture("verify-wrong.bin", makeBuffer(1024));
      expect(await verifyFilesParallel([path], [Buffer.alloc(16, 0xff)])).toBe(false);
    });

    it("single file, hash with one byte off → false", async () => {
      const path = writeFixture("verify-1off.bin", makeBuffer(1024));
      const hash = hashBuf(H_1024);
      hash[15] ^= 0x01;
      expect(await verifyFilesParallel([path], [hash])).toBe(false);
    });

    it("missing file with zero expected hash → true (throwOnError disabled)", async () => {
      expect(await verifyFilesParallel(["/no/such/file"], [Buffer.alloc(16)], false)).toBe(true);
    });

    it("missing file with nonzero expected hash → false (throwOnError disabled)", async () => {
      expect(await verifyFilesParallel(["/no/such/file"], [Buffer.alloc(16, 0x42)], false)).toBe(false);
    });

    it("multiple files, all correct → true", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        paths.push(writeFixture(`verify-multi-${i}.bin`, makeBuffer(200 + i * 100, i)));
        hashes.push(hashBuf(H_CONC1[i]));
      }
      expect(await verifyFilesParallel(paths, hashes)).toBe(true);
    });

    it("multiple files, last one wrong → false", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        paths.push(writeFixture(`verify-last-wrong-${i}.bin`, makeBuffer(200 + i * 100, i)));
        hashes.push(hashBuf(H_CONC1[i]));
      }
      hashes[4][0] ^= 0xff;
      expect(await verifyFilesParallel(paths, hashes)).toBe(false);
    });

    it("multiple files, first one wrong → false (early termination)", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        paths.push(writeFixture(`verify-first-wrong-${i}.bin`, makeBuffer(200 + i * 100, i)));
        hashes.push(hashBuf(H_CONC1[i]));
      }
      hashes[0][0] ^= 0xff;
      expect(await verifyFilesParallel(paths, hashes)).toBe(false);
    });

    it("mix: existing correct + missing with zero hash → true (throwOnError disabled)", async () => {
      const pExist = writeFixture("verify-mix-exist.bin", makeBuffer(512));
      const pMissing = "/tmp/verify-mix-missing-xyz.bin";
      expect(await verifyFilesParallel([pExist, pMissing], [hashBuf(H_512), Buffer.alloc(16)], false)).toBe(true);
    });

    it("mix: existing correct + missing with nonzero hash → false (throwOnError disabled)", async () => {
      const pExist = writeFixture("verify-mix-exist2.bin", makeBuffer(512));
      const pMissing = "/tmp/verify-mix-missing2-xyz.bin";
      expect(await verifyFilesParallel([pExist, pMissing], [hashBuf(H_512), Buffer.alloc(16, 0x42)], false)).toBe(
        false
      );
    });

    it("missing file rejects with throwOnError (default)", async () => {
      await expect(verifyFilesParallel(["/no/such/file"], [Buffer.alloc(16)])).rejects.toThrow();
    });

    it("mix: existing + missing rejects with throwOnError (default)", async () => {
      const pExist = writeFixture("verify-throw-mix.bin", makeBuffer(512));
      await expect(
        verifyFilesParallel([pExist, "/no/such/file"], [hashBuf(H_512), Buffer.alloc(16)])
      ).rejects.toThrow();
    });

    it("files at boundary sizes — all verified", async () => {
      const sizes = [0, 1, 254, 255, 256, BUF - 1, BUF, BUF + 1, READ_BUF - 1, READ_BUF, READ_BUF + 1, 1048576];
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (const size of sizes) {
        paths.push(writeFixture(`verify-boundary-${size}.bin`, makeBuffer(size)));
        hashes.push(hashBuf(H_VERIFY_BOUNDARY[size]));
      }
      expect(await verifyFilesParallel(paths, hashes)).toBe(true);
    });

    it("many files (> 8 concurrent lanes) all correct", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(writeFixture(`verify-many-${i}.bin`, makeBuffer(100 + i * 50, i)));
        hashes.push(hashBuf(H_VERIFY_MANY[i]));
      }
      expect(await verifyFilesParallel(paths, hashes)).toBe(true);
    });

    it("many files, middle one wrong → false", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(writeFixture(`verify-many-mid-${i}.bin`, makeBuffer(100 + i * 50, i)));
        hashes.push(hashBuf(H_VERIFY_MANY[i]));
      }
      hashes[10][8] ^= 0xff;
      expect(await verifyFilesParallel(paths, hashes)).toBe(false);
    });

    it("concurrency = 1: still works correctly", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        paths.push(writeFixture(`verify-conc1-${i}.bin`, makeBuffer(200 + i * 100, i)));
        hashes.push(hashBuf(H_CONC1[i]));
      }
      expect(await verifyFilesParallel(paths, hashes, true, 1)).toBe(true);
    });

    it("concurrency = 2: still works correctly", async () => {
      const paths: string[] = [];
      const hashes: Buffer[] = [];
      for (let i = 0; i < 10; i++) {
        paths.push(writeFixture(`verify-conc2-${i}.bin`, makeBuffer(200 + i * 100, i)));
        hashes.push(hashBuf(H_CONC2[i]));
      }
      expect(await verifyFilesParallel(paths, hashes, true, 2)).toBe(true);
    });

    it("large files (> READ_BUF_SIZE) verified correctly", async () => {
      const path = writeFixture("verify-large.bin", makeBuffer(READ_BUF + 5000));
      expect(await verifyFilesParallel([path], [hashBuf(H_READ_PLUS5000)])).toBe(true);
    });
  });
});
