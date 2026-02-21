/**
 * Benchmark: updateFilesBulk — native vs WASM vs Node.js crypto,
 * with and without per-file output.
 *
 * Uses deterministic fixture files in test/bench/raw-data/.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bench, describe } from "vitest";
import { XXHash128, XXHash128Wasm } from "../../packages/fast-fs-hash/src/index";

const RAW_DATA_DIR = path.resolve(import.meta.dirname, "raw-data");
const LIST_JSON = path.join(RAW_DATA_DIR, "list.json");

function ensureRawData(): void {
  if (!existsSync(LIST_JSON)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { generate } = require("./generate-raw-data.cjs") as { generate: () => void };
    generate();
  }
}

function loadFileList(): string[] {
  const raw = readFileSync(LIST_JSON, "utf-8");
  return (JSON.parse(raw) as string[]).map((rel) => path.join(RAW_DATA_DIR, rel));
}

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

describe("updateFilesBulk", async () => {
  ensureRawData();
  const files = loadFileList();
  await XXHash128.init();
  await XXHash128Wasm.init();

  bench("native", async () => {
    const h = new XXHash128();
    await h.updateFilesBulk(files);
    h.digest();
  });

  // bench("WASM", async () => {
  //   const h = new XXHash128Wasm();
  //   await h.updateFilesBulk(files);
  //   h.digest();
  // });

  // bench("Node.js crypto (md5)", async () => {
  //   await rawNodeCryptoHash(files, false);
  // });

  // bench("native (per file output)", async () => {
  //   const h = new XXHash128();
  //   await h.updateFilesBulk(files, true);
  //   h.digest();
  // });

  // bench("WASM (per file output)", async () => {
  //   const h = new XXHash128Wasm();
  //   await h.updateFilesBulk(files, true);
  //   h.digest();
  // });

  // bench("Node.js crypto (per file output)", async () => {
  //   await rawNodeCryptoHash(files, true);
  // });
});
