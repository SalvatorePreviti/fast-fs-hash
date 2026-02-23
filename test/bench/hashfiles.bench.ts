/**
 *
 * Uses deterministic fixture files in test/bench/raw-data/.
 *
 * Run `npm run build:all` before benchmarking to ensure the compiled output is up to date.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as native from "fast-fs-hash";
import { bench, describe } from "vitest";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

async function rawNodeCryptoHash(files: string[]): Promise<string> {
  const master = createHash("md5");
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= files.length) {
        break;
      }
      try {
        const digest = createHash("md5")
          .update(await readFile(files[idx]))
          .digest();
        master.update(digest);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, () => worker()));
  return master.digest("hex");
}

describe("digestFilesParallel", async () => {
  const { files } = generate();

  // Pre-warm the OS page cache
  await Promise.all(files.map((f) => readFile(f)));

  bench("native", async () => {
    await native.digestFilesParallel(files);
  });

  bench("Node.js crypto (md5)", async () => {
    await rawNodeCryptoHash(files);
  });
});
