/**
 * Benchmark: filesEqual — native vs Node.js file comparison.
 *
 * Tests three scenarios:
 * - Equal files (same content)
 * - Different files (same size, different content)
 * - Different sizes (early exit)
 *
 * Uses deterministic fixture files from raw-data/.
 */

import { copyFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

/** Pick a file closest to a target size. */
function pickFileBySize(files: string[], targetBytes: number): { file: string; size: number } {
  let best = files[0];
  let bestDelta = Infinity;
  for (const f of files) {
    const sz = statSync(f).size;
    const delta = Math.abs(sz - targetBytes);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = f;
    }
  }
  return { file: best, size: statSync(best).size };
}

/**
 * Node.js file comparison using fs.open + read + Buffer.compare.
 * Returns false if either file can't be opened/read or sizes differ.
 */
async function nodeFilesEqual(pathA: string, pathB: string): Promise<boolean> {
  let fhA: Awaited<ReturnType<typeof open>> | undefined;
  let fhB: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fhA = await open(pathA, "r");
    fhB = await open(pathB, "r");

    const statA = await fhA.stat();
    const statB = await fhB.stat();
    if (statA.size !== statB.size) {
      return false;
    }
    if (statA.size === 0) {
      return true;
    }

    const CHUNK = 64 * 1024;
    const bufA = Buffer.allocUnsafe(CHUNK);
    const bufB = Buffer.allocUnsafe(CHUNK);

    let offset = 0;
    while (offset < statA.size) {
      const toRead = Math.min(CHUNK, statA.size - offset);
      const [rA, rB] = await Promise.all([fhA.read(bufA, 0, toRead, offset), fhB.read(bufB, 0, toRead, offset)]);
      if (rA.bytesRead !== rB.bytesRead) {
        return false;
      }
      if (bufA.compare(bufB, 0, rA.bytesRead, 0, rA.bytesRead) !== 0) {
        return false;
      }
      offset += rA.bytesRead;
    }
    return true;
  } catch {
    return false;
  } finally {
    await fhA?.close();
    await fhB?.close();
  }
}

describe("filesEqual", async () => {
  const { files } = generate();
  const rawDataDir = join(__dirname, "raw-data");

  const medium = pickFileBySize(files, 50 * 1024);
  const large = pickFileBySize(files, 200 * 1024);

  // Create copies (equal content) for equal-file tests
  const mediumCopy = join(rawDataDir, "medium-copy.bin");
  const largeCopy = join(rawDataDir, "large-copy.bin");
  copyFileSync(medium.file, mediumCopy);
  copyFileSync(large.file, largeCopy);

  // Create same-size-different-content files
  const mediumDiff = join(rawDataDir, "medium-diff.bin");
  const largeDiff = join(rawDataDir, "large-diff.bin");
  writeFileSync(mediumDiff, Buffer.alloc(statSync(medium.file).size, 0xff));
  writeFileSync(largeDiff, Buffer.alloc(statSync(large.file).size, 0xff));

  // -- Equal files (medium)

  describe(`equal files (~${(medium.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await native.filesEqual(medium.file, mediumCopy);
    });

    bench("Node.js (fs.open + read + compare)", async () => {
      await nodeFilesEqual(medium.file, mediumCopy);
    });
  });

  // -- Equal files (large)

  describe(`equal files (~${(large.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await native.filesEqual(large.file, largeCopy);
    });

    bench("Node.js (fs.open + read + compare)", async () => {
      await nodeFilesEqual(large.file, largeCopy);
    });
  });

  // -- Different content, same size (medium)

  describe(`different content, same size (~${(medium.size / 1024).toFixed(1)} KB)`, () => {
    bench("native", async () => {
      await native.filesEqual(medium.file, mediumDiff);
    });

    bench("Node.js (fs.open + read + compare)", async () => {
      await nodeFilesEqual(medium.file, mediumDiff);
    });
  });

  // -- Different sizes (early exit)

  describe("different sizes (early exit)", () => {
    bench("native", async () => {
      await native.filesEqual(medium.file, large.file);
    });

    bench("Node.js (fs.open + read + compare)", async () => {
      await nodeFilesEqual(medium.file, large.file);
    });
  });
});
