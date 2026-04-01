/**
 * Tests for multi-file digest functions:
 * - digestFilesSequential / digestFilesSequentialTo
 *
 * Key scenarios:
 * - Empty array → digest of empty data (single 16-byte hash)
 * - Single file
 * - Multiple files of varying sizes (including boundary sizes)
 * - Missing files reject (throwOnError is always on)
 * - Order matters
 */

import { describe, expect, it } from "vitest";

import { ALL_BACKENDS, hex, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("digest-files");

const BUF = 131072;
const READ_BUF = 131072;

//  - Known xxHash3-128 digests (seed 0,0)

const H_EMPTY = "99aa06d3014798d86001c324468d497f";

/**
 * Sequential hashes: hash of concatenated raw file content.
 */
const H_SEQ_SINGLE_1024 = "83885e853bb6640ca870f92984398d22";
const H_SEQ_TWO = "566a4946706f44e7584078dc902184da"; // makeBuffer(500,1) || makeBuffer(800,2)
const H_SEQ_BOUNDARY = "2aad1ca0eb3da3335a7867702c017e99"; // concat of all boundary sizes
const H_SEQ_MANY = "eba0db9bb4a5661438ba69ea6040bcc5"; // 20 files concatenated
const H_SEQ_ORDER_AB = "25288886c3e4cf52831592ff424f8605"; // makeBuffer(500,10) || makeBuffer(800,20)
const H_SEQ_ORDER_BA = "27ff0e4ddd6a29ed32c91d6f8aa898e2"; // makeBuffer(800,20) || makeBuffer(500,10)
const H_SEQ_10FILES = "18dcd3d5e0ce162420153b4ad38ca290"; // 10 files concat

/** Sequential To hashes */
const H_SEQ_TO_500 = "56dd5682fe04888bc12fd3e43ffdd5a1";
const H_SEQ_TO_300S1_400S2 = "843259e5c80977a3f01319c5930d2a67"; // makeBuffer(300,1) || makeBuffer(400,2)

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { digestFilesSequential, digestFilesSequentialTo, digestFilesParallel, digestFilesParallelTo } = backend;

  //  - digestFilesSequential

  describe("digestFilesSequential", () => {
    it("empty array → digest of empty data", async () => {
      const result = await digestFilesSequential([]);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("single file", async () => {
      const path = writeFixture("seq-single.bin", makeBuffer(1024));
      const result = await digestFilesSequential([path]);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_SEQ_SINGLE_1024);
    });

    it("two files → hash of concatenated content", async () => {
      const p1 = writeFixture("seq-two-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("seq-two-b.bin", makeBuffer(800, 2));
      const result = await digestFilesSequential([p1, p2]);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_SEQ_TWO);
    });

    it("missing file rejects", async () => {
      const p1 = writeFixture("seq-throw.bin", makeBuffer(200));
      await expect(digestFilesSequential([p1, "/tmp/no-such-file.bin"])).rejects.toThrow();
    });

    it("all missing rejects", async () => {
      await expect(digestFilesSequential(["/no/a", "/no/b"])).rejects.toThrow();
    });

    it("files at boundary sizes", async () => {
      const sizes = [0, 1, 254, 255, 256, BUF - 1, BUF, BUF + 1, READ_BUF, 1048576];
      const paths: string[] = [];
      for (const size of sizes) {
        paths.push(writeFixture(`seq-boundary-${size}.bin`, makeBuffer(size)));
      }
      const result = await digestFilesSequential(paths);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_SEQ_BOUNDARY);
    });

    it("many files (> 8 concurrent lanes)", async () => {
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(writeFixture(`seq-many-${i}.bin`, makeBuffer(100 + i * 50, i)));
      }
      const result = await digestFilesSequential(paths);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_SEQ_MANY);
    });

    it("order matters: [a,b] ≠ [b,a]", async () => {
      const p1 = writeFixture("seq-order-a.bin", makeBuffer(500, 10));
      const p2 = writeFixture("seq-order-b.bin", makeBuffer(800, 20));
      const ab = hex(await digestFilesSequential([p1, p2]));
      const ba = hex(await digestFilesSequential([p2, p1]));
      expect(ab).toBe(H_SEQ_ORDER_AB);
      expect(ba).toBe(H_SEQ_ORDER_BA);
      expect(ab).not.toBe(ba);
    });

    it("10 files sequential", async () => {
      const paths: string[] = [];
      for (let i = 0; i < 10; i++) {
        paths.push(writeFixture(`seq-10f-${i}.bin`, makeBuffer(200 + i * 30, i)));
      }
      const result = await digestFilesSequential(paths);
      expect(hex(result)).toBe(H_SEQ_10FILES);
    });
  });

  //  - digestFilesSequentialTo

  describe("digestFilesSequentialTo", () => {
    it("empty array → writes empty-data digest", async () => {
      const out = Buffer.alloc(32);
      await digestFilesSequentialTo([], out, 4);
      expect(hex(out.subarray(4, 20))).toBe(H_EMPTY);
    });

    it("writes digest at offset 0", async () => {
      const p = writeFixture("seqto-0.bin", makeBuffer(500));
      const out = Buffer.alloc(16);
      await digestFilesSequentialTo([p], out);
      expect(hex(out)).toBe(H_SEQ_TO_500);
    });

    it("writes at custom offset", async () => {
      const p1 = writeFixture("seqto-off-a.bin", makeBuffer(300, 1));
      const p2 = writeFixture("seqto-off-b.bin", makeBuffer(400, 2));
      const out = Buffer.alloc(32);
      await digestFilesSequentialTo([p1, p2], out, 8);
      expect(hex(out.subarray(8, 24))).toBe(H_SEQ_TO_300S1_400S2);
    });

    it("missing file rejects digestFilesSequentialTo", async () => {
      const p1 = writeFixture("seqto-throw.bin", makeBuffer(300, 1));
      const out = Buffer.alloc(16);
      await expect(digestFilesSequentialTo([p1, "/no/such/file"], out)).rejects.toThrow();
    });
  });

  //  - digestFilesParallel

  describe("digestFilesParallel", () => {
    it("empty array → digest of empty data", async () => {
      const result = await digestFilesParallel([]);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(hex(result)).toBe(H_EMPTY);
    });

    it("single file", async () => {
      const p = writeFixture("par-single.bin", makeBuffer(1024));
      const result = await digestFilesParallel([p]);
      expect(result.length).toBe(16);
    });

    it("two files produce consistent result", async () => {
      const p1 = writeFixture("par-two-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("par-two-b.bin", makeBuffer(800, 2));
      const r1 = hex(await digestFilesParallel([p1, p2]));
      const r2 = hex(await digestFilesParallel([p1, p2]));
      expect(r1).toBe(r2);
    });

    it("missing file rejects with throwOnError=true (default)", async () => {
      const p1 = writeFixture("par-throw.bin", makeBuffer(200));
      await expect(digestFilesParallel([p1, "/tmp/no-such-file.bin"])).rejects.toThrow();
    });

    it("missing file produces a deterministic result (zero hash for failed file)", async () => {
      const p1 = writeFixture("par-throw-det.bin", makeBuffer(200));
      const r1 = hex(await digestFilesParallel([p1, "/tmp/no-such-file.bin"], 0, false));
      const r2 = hex(await digestFilesParallel([p1, "/tmp/no-such-file.bin"], 0, false));
      expect(r1).toBe(r2);
    });

    it("order matters: [a,b] ≠ [b,a]", async () => {
      const p1 = writeFixture("par-order-a.bin", makeBuffer(500, 10));
      const p2 = writeFixture("par-order-b.bin", makeBuffer(800, 20));
      const ab = hex(await digestFilesParallel([p1, p2]));
      const ba = hex(await digestFilesParallel([p2, p1]));
      expect(ab).not.toBe(ba);
    });

    it("many files (> 8 concurrent lanes)", async () => {
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(writeFixture(`par-many-${i}.bin`, makeBuffer(100 + i * 50, i)));
      }
      const r1 = hex(await digestFilesParallel(paths));
      const r2 = hex(await digestFilesParallel(paths));
      expect(r1).toBe(r2);
    });

    it("matches stream addFilesParallel", async () => {
      const p1 = writeFixture("par-match-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("par-match-b.bin", makeBuffer(800, 2));
      const standalone = hex(await digestFilesParallel([p1, p2]));
      const { XxHash128Stream } = backend;
      const stream = new XxHash128Stream();
      await stream.addFilesParallel([p1, p2]);
      expect(standalone).toBe(hex(stream.digest()));
    });

    it("sequential ≠ parallel (different hashing scheme)", async () => {
      const p1 = writeFixture("par-vs-seq-a.bin", makeBuffer(500, 1));
      const p2 = writeFixture("par-vs-seq-b.bin", makeBuffer(800, 2));
      const par = hex(await digestFilesParallel([p1, p2]));
      const seq = hex(await digestFilesSequential([p1, p2]));
      expect(par).not.toBe(seq);
    });
  });

  //  - digestFilesParallelTo

  describe("digestFilesParallelTo", () => {
    it("writes at offset 0", async () => {
      const p = writeFixture("parto-0.bin", makeBuffer(500));
      const out = Buffer.alloc(16);
      await digestFilesParallelTo([p], out);
      expect(hex(out)).toBe(hex(await digestFilesParallel([p])));
    });

    it("writes at custom offset", async () => {
      const p1 = writeFixture("parto-off-a.bin", makeBuffer(300, 1));
      const p2 = writeFixture("parto-off-b.bin", makeBuffer(400, 2));
      const out = Buffer.alloc(32);
      await digestFilesParallelTo([p1, p2], out, 8);
      const expected = hex(await digestFilesParallel([p1, p2]));
      expect(hex(out.subarray(8, 24))).toBe(expected);
    });

    it("empty array", async () => {
      const out = Buffer.alloc(32);
      await digestFilesParallelTo([], out, 4);
      expect(hex(out.subarray(4, 20))).toBe(H_EMPTY);
    });

    it("missing file rejects with throwOnError=true (default)", async () => {
      const p1 = writeFixture("parto-throw.bin", makeBuffer(300, 1));
      const out = Buffer.alloc(16);
      await expect(digestFilesParallelTo([p1, "/no/such/file"], out)).rejects.toThrow();
    });

    it("missing file produces a deterministic result (throwOnError=false)", async () => {
      const p1 = writeFixture("parto-throw-det.bin", makeBuffer(300, 1));
      const out1 = Buffer.alloc(16);
      const out2 = Buffer.alloc(16);
      await digestFilesParallelTo([p1, "/no/such/file"], out1, undefined, 0, false);
      await digestFilesParallelTo([p1, "/no/such/file"], out2, undefined, 0, false);
      expect(hex(out1)).toBe(hex(out2));
    });
  });
});
