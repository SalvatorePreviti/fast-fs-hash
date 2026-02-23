/**
 * All methods write into a pre-allocated output buffer so the comparison is fair
 * (no allocation overhead in the measured loop).
 *
 * Tests three buffer sizes:
 * - Small   (2 KB)
 * - Medium  (64 KB)
 * - Large   (1 MB)
 *
 * Run `npm run build:all` before benchmarking to ensure the compiled output is up to date.
 */

import { createHash, randomBytes } from "node:crypto";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

function nodeCryptoMd5To(data: Buffer, out: Buffer): void {
  createHash("md5").update(data).digest().copy(out);
}

describe("digestBufferTo() — in-memory buffer", () => {
  const small = randomBytes(2048);
  const medium = randomBytes(64 * 1024);
  const large = randomBytes(1024 * 1024);
  const out = Buffer.alloc(16);

  describe("2 KB buffer", () => {
    bench("native XXH3-128", () => {
      native.digestBufferTo(small, out);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5To(small, out);
    });
  });

  describe("64 KB buffer", () => {
    bench("native XXH3-128", () => {
      native.digestBufferTo(medium, out);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5To(medium, out);
    });
  });

  describe("1 MB buffer", () => {
    bench("native XXH3-128", () => {
      native.digestBufferTo(large, out);
    });

    bench("Node.js crypto md5", () => {
      nodeCryptoMd5To(large, out);
    });
  });
});
