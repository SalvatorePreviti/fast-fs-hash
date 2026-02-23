/**
 *
 * Tests digestBuffer, digestBufferTo, digestBufferRange, digestBufferRangeTo
 * across multiple input sizes.
 *
 * Run with: npx vitest bench test/bench/hashing/buffer-digest.bench.ts
 */

import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

const BENCH_OPTS = { time: 100, warmupTime: 50, warmupIterations: 3 } as const;
const b = (name: string, fn: () => void) => bench(name, fn, BENCH_OPTS);

const SMALL_BUF = Buffer.from("hello world xxhash128 benchmark");
const MEDIUM_BUF = Buffer.alloc(4096);
const LARGE_BUF = Buffer.alloc(256 * 1024);

for (let i = 0; i < MEDIUM_BUF.length; i++) {
  MEDIUM_BUF[i] = (i * 31 + 17) & 0xff;
}
for (let i = 0; i < LARGE_BUF.length; i++) {
  LARGE_BUF[i] = (i * 31 + 17) & 0xff;
}

const BUFFERS = [SMALL_BUF, MEDIUM_BUF, LARGE_BUF] as const;
const OUT_BUF = Buffer.alloc(16);
const OUT_BUF_32 = Buffer.alloc(32);

describe.each(BUFFERS)("digestBuffer", (buf) => {
  describe(buf.length + " B", () => {
    const n = native.digestBuffer;
    b("Native", () => {
      n(buf);
    });
  });
});

describe.each(BUFFERS)("digestBufferTo", (buf) => {
  describe(buf.length + " B", () => {
    const n = native.digestBufferTo;
    b("Native", () => {
      n(buf, OUT_BUF);
    });
  });
});

describe.each(BUFFERS)("digestBufferTo (with offset)", (buf) => {
  describe(buf.length + " B", () => {
    const n = native.digestBufferTo;
    b("Native", () => {
      n(buf, OUT_BUF_32, 8);
    });
  });
});

describe("digestBufferRange", () => {
  describe("16 B slice of 4 KB (offset 100)", () => {
    const n = native.digestBufferRange;
    b("Native", () => {
      n(MEDIUM_BUF, 100, 16);
    });
  });
  describe("2 KB slice of 4 KB (offset 512)", () => {
    const n = native.digestBufferRange;
    b("Native", () => {
      n(MEDIUM_BUF, 512, 2048);
    });
  });
});

describe("digestBufferRangeTo", () => {
  describe("16 B slice of 4 KB (offset 100)", () => {
    const n = native.digestBufferRangeTo;
    b("Native", () => {
      n(MEDIUM_BUF, 100, 16, OUT_BUF);
    });
  });
  describe("2 KB slice of 4 KB (offset 512)", () => {
    const n = native.digestBufferRangeTo;
    b("Native", () => {
      n(MEDIUM_BUF, 512, 2048, OUT_BUF);
    });
  });
});

describe("digestBufferRangeTo (with offset)", () => {
  describe("16 B slice of 4 KB (offset 100), out offset 8", () => {
    const n = native.digestBufferRangeTo;
    b("Native", () => {
      n(MEDIUM_BUF, 100, 16, OUT_BUF_32, 8);
    });
  });
});
