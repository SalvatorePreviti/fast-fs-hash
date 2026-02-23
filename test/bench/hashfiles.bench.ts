/**
 * Benchmark: hashFilesBulk (static) vs updateFilesBulk (instance) vs Node.js crypto,
 * with and without per-file output.
 *
 * Uses deterministic fixture files in test/bench/raw-data/.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { bench, describe } from "vitest";
import { XXHash128, XXHash128Wasm } from "../../packages/fast-fs-hash/src/index";

const { generate } = require("./generate-raw-data.cjs") as {
  generate: () => { files: string[]; modFilePath: string; cacheDir: string };
};

async function rawNodeCryptoHash(files: string[], perFile: boolean): Promise<string> {
  const master = createHash("md5");
  const hashes = perFile ? new Array<string>(files.length) : null;
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
        if (hashes) {
          hashes[idx] = digest.toString("hex");
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, () => worker()));
  return master.digest("hex");
}

describe("hashFilesBulk", async () => {
  const { files } = generate();
  await XXHash128.init();
  await XXHash128Wasm.init();

  // Pre-warm the OS page cache so the first benchmark doesn't pay cold-read
  // costs that unfairly penalize it relative to later benchmarks in the group.
  await Promise.all(files.map((f) => readFile(f)));

  bench("native (hashFilesBulk)", async () => {
    await XXHash128.hashFilesBulk({ files });
  });

  bench("native (hashFilesBulk + per file)", async () => {
    await XXHash128.hashFilesBulk({ files, outputMode: "all" });
  });

  bench("WASM (hashFilesBulk)", async () => {
    await XXHash128Wasm.hashFilesBulk({ files });
  });

  bench("WASM (hashFilesBulk + per file)", async () => {
    await XXHash128Wasm.hashFilesBulk({ files, outputMode: "all" });
  });

  bench("Node.js crypto (md5)", async () => {
    await rawNodeCryptoHash(files, false);
  });

  bench("Node.js crypto (md5, per file)", async () => {
    await rawNodeCryptoHash(files, true);
  });
});
