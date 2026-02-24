/**
 * Tests for unbound (destructured) static methods.
 */

import { hashesToHexArray } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

import {
  fileA,
  fileB,
  H_EMPTY,
  H_GOODBYE_WORLD_LF,
  H_HELLO_WORLD,
  H_HELLO_WORLD_LF,
  H_HW_SEED_42_0,
  HF_AB_COMBINED,
  implementations,
  setupXXHash128Fixtures,
} from "./_helpers";

setupXXHash128Fixtures("unbound");

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
