/**
 * Tests for static hashFileHandle, instance hashFileHandle, and
 * cross-implementation hashFileHandle compatibility.
 */

import { open } from "node:fs/promises";
import { XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

import {
  fileA,
  fileB,
  fileEmpty,
  H_EMPTY,
  H_GOODBYE_WORLD_LF,
  H_HELLO_WORLD_LF,
  HF_A_SEED_0_42,
  HF_A_SEED_42_0,
  HF_A_SEED_123_456,
  implementations,
  setupXXHash128Fixtures,
} from "./_helpers";

setupXXHash128Fixtures("handle");

//  - Static hashFileHandle

describe.each(implementations)("%s — static hashFileHandle", (_name, Hasher) => {
  it("returns correct 16-byte Buffer for a.txt", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(result.toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("returns correct hash for b.txt", async () => {
    const fh = await open(fileB(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh);
      expect(result.toString("hex")).toBe(H_GOODBYE_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("returns correct hash for empty file", async () => {
    const fh = await open(fileEmpty(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh);
      expect(result.toString("hex")).toBe(H_EMPTY);
    } finally {
      await fh.close();
    }
  });

  it("writes into pre-allocated Buffer", async () => {
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(32);
      await Hasher.hashFileHandleTo(fh, buf);
      expect(buf.subarray(0, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("writes at specified offset", async () => {
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(64);
      await Hasher.hashFileHandleTo(fh, buf, 10);
      expect(buf.subarray(10, 26).toString("hex")).toBe(H_HELLO_WORLD_LF);
      expect(buf.subarray(0, 10).every((b) => b === 0)).toBe(true);
      expect(buf.subarray(26, 64).every((b) => b === 0)).toBe(true);
    } finally {
      await fh.close();
    }
  });

  it("seedLow changes digest", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh, 42);
      expect(result.toString("hex")).toBe(HF_A_SEED_42_0);
    } finally {
      await fh.close();
    }
  });

  it("seedHigh changes digest", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh, 0, 42);
      expect(result.toString("hex")).toBe(HF_A_SEED_0_42);
    } finally {
      await fh.close();
    }
  });

  it("both seed parts produce correct digest", async () => {
    const fh = await open(fileA(), "r");
    try {
      const result = await Hasher.hashFileHandle(fh, 123, 456);
      expect(result.toString("hex")).toBe(HF_A_SEED_123_456);
    } finally {
      await fh.close();
    }
  });

  it("produces identical results on repeated calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const fh = await open(fileA(), "r");
        try {
          return await Hasher.hashFileHandle(fh);
        } finally {
          await fh.close();
        }
      })
    );
    for (const r of results) {
      expect(r.toString("hex")).toBe(H_HELLO_WORLD_LF);
    }
  });

  it("matches hashFile result (same content, same seed)", async () => {
    const fromFile = await Hasher.hashFile(fileA());
    const fh = await open(fileA(), "r");
    try {
      const fromHandle = await Hasher.hashFileHandle(fh);
      expect(fromHandle.toString("hex")).toBe(fromFile.toString("hex"));
    } finally {
      await fh.close();
    }
  });
});

//  - Instance hashFileHandle

describe.each(implementations)("%s — instance hashFileHandle", (_name, Hasher) => {
  it("returns correct 16-byte Buffer for a.txt (seed 0)", async () => {
    const h = new Hasher();
    const fh = await open(fileA(), "r");
    try {
      const result = await h.hashFileHandle(fh);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(16);
      expect(result.toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("uses the instance seed", async () => {
    const h = new Hasher(42, 0);
    const fh = await open(fileA(), "r");
    try {
      const result = await h.hashFileHandle(fh);
      expect(result.toString("hex")).toBe(HF_A_SEED_42_0);
    } finally {
      await fh.close();
    }
  });

  it("writes into output buffer", async () => {
    const h = new Hasher();
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(32);
      await h.hashFileHandleTo(fh, buf);
      expect(buf.subarray(0, 16).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });

  it("writes at offset into output buffer", async () => {
    const h = new Hasher();
    const fh = await open(fileA(), "r");
    try {
      const buf = Buffer.alloc(64);
      await h.hashFileHandleTo(fh, buf, 20);
      expect(buf.subarray(20, 36).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fh.close();
    }
  });
});

//  - Cross-implementation hashFileHandle compatibility

describe("Native ↔ WASM hashFileHandle compatibility", () => {
  it("static hashFileHandle produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const n = await XXHash128.hashFileHandle(fhN);
      const w = await XXHash128Wasm.hashFileHandle(fhW);
      expect(n.toString("hex")).toBe(H_HELLO_WORLD_LF);
      expect(w.toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });

  it("static hashFileHandle with seed produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const n = await XXHash128.hashFileHandle(fhN, 42, 0);
      const w = await XXHash128Wasm.hashFileHandle(fhW, 42, 0);
      expect(n.toString("hex")).toBe(HF_A_SEED_42_0);
      expect(w.toString("hex")).toBe(HF_A_SEED_42_0);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });

  it("static hashFileHandleTo with output buffer produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const bufN = Buffer.alloc(32);
      const bufW = Buffer.alloc(32);
      await XXHash128.hashFileHandleTo(fhN, bufN, 8);
      await XXHash128Wasm.hashFileHandleTo(fhW, bufW, 8);
      expect(bufN.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD_LF);
      expect(bufW.subarray(8, 24).toString("hex")).toBe(H_HELLO_WORLD_LF);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });

  it("hashFileHandle matches hashFile for all fixtures", async () => {
    const fixtures = [fileA(), fileB(), fileEmpty()];
    for (const f of fixtures) {
      const fromFile = await XXHash128.hashFile(f);
      const fh = await open(f, "r");
      try {
        const fromHandle = await XXHash128.hashFileHandle(fh);
        expect(fromHandle.toString("hex")).toBe(fromFile.toString("hex"));
      } finally {
        await fh.close();
      }
    }
  });

  it("instance hashFileHandle with seed produces identical results", async () => {
    const fhN = await open(fileA(), "r");
    const fhW = await open(fileA(), "r");
    try {
      const n = await new XXHash128(123, 456).hashFileHandle(fhN);
      const w = await new XXHash128Wasm(123, 456).hashFileHandle(fhW);
      expect(n.toString("hex")).toBe(HF_A_SEED_123_456);
      expect(w.toString("hex")).toBe(HF_A_SEED_123_456);
    } finally {
      await fhN.close();
      await fhW.close();
    }
  });
});
