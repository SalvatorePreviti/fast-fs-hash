/**
 * Tests for static hashFilesBulk and unbound static methods.
 */

import { encodeFilePaths, hashesToHexArray } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

import {
  fileA,
  fileB,
  H_EMPTY,
  H_GOODBYE_WORLD_LF,
  H_HELLO_WORLD,
  H_HELLO_WORLD_LF,
  H_HW_SEED_42_0,
  H_ZERO,
  HF_A_MISSING_COMBINED,
  HF_AB_COMBINED,
  HF_BA_COMBINED,
  implementations,
  setupXXHash128Fixtures,
} from "./_helpers";

setupXXHash128Fixtures();

//  - Static hashFilesBulk

describe.each(implementations)("%s — static hashFilesBulk", (_name, Hasher) => {
  it("outputMode=digest returns 16-byte aggregate", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "digest" });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
    expect(result.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("default (outputMode=digest) returns 16-byte aggregate", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
    expect(result.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("outputMode=all returns digest + per-file hashes", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all" });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16 + 32);
    expect(result.subarray(0, 16).toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("outputMode=files returns only per-file hashes", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "files" });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(32);
    expect(hashesToHexArray(result)).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("explicit outputMode=digest matches default", async () => {
    const def = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    const dig = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "digest" });
    expect(def.toString("hex")).toBe(dig.toString("hex"));
  });

  it("order matters", async () => {
    const ab = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    const ba = await Hasher.hashFilesBulk({ files: [fileB(), fileA()] });
    expect(ab.toString("hex")).toBe(HF_AB_COMBINED);
    expect(ba.toString("hex")).toBe(HF_BA_COMBINED);
  });

  it("missing file produces zero hash", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA(), "/no/such/file.txt"], outputMode: "all" });
    expect(result.subarray(0, 16).toString("hex")).toBe(HF_A_MISSING_COMBINED);
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF, H_ZERO]);
  });

  it("empty list (digest)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [] });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
  });

  it("empty list (all)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [], outputMode: "all" });
    expect(result.length).toBe(16);
  });

  it("empty list (files)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [], outputMode: "files" });
    expect(result.length).toBe(0);
  });

  it("single file (all)", async () => {
    const result = await Hasher.hashFilesBulk({ files: [fileA()], outputMode: "all" });
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF]);
  });

  it("matches instance-based updateFilesBulk+digest", async () => {
    const h = new Hasher();
    await h.updateFilesBulk([fileA(), fileB()]);
    const instanceDigest = h.digest().toString("hex");
    const staticDigest = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    expect(staticDigest.toString("hex")).toBe(instanceDigest);
  });

  it("accepts Uint8Array of null-terminated paths", async () => {
    const result = await Hasher.hashFilesBulk({
      files: encodeFilePaths([fileA(), fileB()]),
    });
    expect(result.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("with pre-allocated Buffer (all mode) via hashFilesBulkTo", async () => {
    const buf = Buffer.alloc(100);
    await Hasher.hashFilesBulkTo(
      {
        files: [fileA(), fileB()],
        outputMode: "all",
      },
      buf,
      10
    );
    expect(buf.subarray(10, 26).toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(buf.subarray(26, 58))).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("with pre-allocated Uint8Array (all mode) via hashFilesBulkTo", async () => {
    const buf = new Uint8Array(100);
    await Hasher.hashFilesBulkTo(
      {
        files: [fileA(), fileB()],
        outputMode: "all",
      },
      buf,
      10
    );
    expect(Buffer.from(buf.buffer, buf.byteOffset + 10, 16).toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("with pre-allocated Buffer (digest mode) via hashFilesBulkTo", async () => {
    const buf = Buffer.alloc(64);
    await Hasher.hashFilesBulkTo(
      {
        files: [fileA(), fileB()],
      },
      buf,
      4
    );
    expect(buf.subarray(4, 20).toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("with seed changes aggregate but not per-file hashes", async () => {
    const seeded = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all", seedLow: 42 });
    const unseeded = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all" });
    expect(seeded.subarray(0, 16).toString("hex")).not.toBe(unseeded.subarray(0, 16).toString("hex"));
    expect(hashesToHexArray(seeded.subarray(16))).toEqual(hashesToHexArray(unseeded.subarray(16)));
  });

  it("seeded digest matches instance approach", async () => {
    const seeded = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], seedLow: 42 });
    const h = new Hasher(42, 0);
    await h.updateFilesBulk([fileA(), fileB()]);
    expect(seeded.toString("hex")).toBe(h.digest().toString("hex"));
  });

  it("throws if outputBuffer is too small for hashFilesBulkTo", async () => {
    await expect(Hasher.hashFilesBulkTo({ files: [fileA(), fileB()] }, Buffer.alloc(10))).rejects.toThrow(RangeError);
  });

  it("concurrency=1 produces same result", async () => {
    const normal = await Hasher.hashFilesBulk({ files: [fileA(), fileB()] });
    const single = await Hasher.hashFilesBulk({ files: [fileA(), fileB()], concurrency: 1 });
    expect(normal.toString("hex")).toBe(single.toString("hex"));
  });
});

//  - Unbound static methods (destructured, no `this`)

describe.each(implementations)("%s — unbound static methods", (_name, Hasher) => {
  it("hash() works when destructured", () => {
    const { hash } = Hasher;
    expect(hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
  });

  it("hash() works when assigned to a variable", () => {
    const hash = Hasher.hash;
    expect(hash("hello world").toString("hex")).toBe(H_HELLO_WORLD);
    expect(hash("").toString("hex")).toBe(H_EMPTY);
  });

  it("hash() with seed works when destructured", () => {
    const { hash } = Hasher;
    expect(hash("hello world", 42, 0).toString("hex")).toBe(H_HW_SEED_42_0);
  });

  it("hashFilesBulk() works when destructured", async () => {
    const { hashFilesBulk } = Hasher;
    const digest = await hashFilesBulk({ files: [fileA(), fileB()] });
    expect(digest.toString("hex")).toBe(HF_AB_COMBINED);
  });

  it("hashFilesBulk() all mode works when destructured", async () => {
    const { hashFilesBulk } = Hasher;
    const result = await hashFilesBulk({ files: [fileA(), fileB()], outputMode: "all" });
    expect(result.subarray(0, 16).toString("hex")).toBe(HF_AB_COMBINED);
    expect(hashesToHexArray(result.subarray(16))).toEqual([H_HELLO_WORLD_LF, H_GOODBYE_WORLD_LF]);
  });

  it("init() works when destructured", async () => {
    const { init } = Hasher;
    await expect(init()).resolves.toBeUndefined();
  });
});
