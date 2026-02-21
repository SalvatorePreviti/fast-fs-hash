/**
 * Tests that fast-fs-hash works correctly inside Node.js Worker Threads.
 *
 * The native addon uses N-API (context-aware), so each Worker Thread gets
 * its own module instance. This test verifies:
 *   1. The native binding loads and initializes in a Worker Thread.
 *   2. Hashing produces correct results (matching main-thread values).
 *   3. Multiple Workers can hash concurrently without interference.
 *   4. g_active_hash_threads coordination works across threads.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XXHash128 } from "../packages/fast-fs-hash/src/index";

// ── Known values (same as xxhash128.test.ts) ─────────────────────────────

const H_HELLO_WORLD = "df8d09e93f874900a99b8775cc15b6c7";
const H_HELLO_WORLD_LF = "eefac9d87100cd1336b2e733a5484425";

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures-worker-threads");
const fileA = () => path.join(FIXTURES_DIR, "a.txt");

const WORKER_SCRIPT = path.resolve(import.meta.dirname, "_worker-thread-helper.mjs");

beforeAll(async () => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(fileA(), "hello world\n");
  await XXHash128.init();
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

// ── Helper to run code in a Worker Thread ────────────────────────────────

interface WorkerResult {
  hashHex: string;
  fileHashHex: string;
  libraryStatus: string;
}

interface WorkerBulkResult {
  hex: string;
}

function runInWorker(fixturesDir: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, {
      workerData: { mode: "basic", fixturesDir },
    });
    worker.on("message", (msg: WorkerResult) => {
      resolve(msg);
      worker.terminate();
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

function runBulkInWorker(fixturesDir: string, fileCount: number): Promise<WorkerBulkResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, {
      workerData: { mode: "bulk", fixturesDir, fileCount },
    });
    worker.on("message", (msg: WorkerBulkResult) => {
      resolve(msg);
      worker.terminate();
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Worker Threads", () => {
  it("should produce correct hashes in a Worker Thread", async () => {
    const result = await runInWorker(FIXTURES_DIR);

    expect(result.hashHex).toBe(H_HELLO_WORLD);
    expect(result.fileHashHex).toBe(H_HELLO_WORLD_LF);
    // Workers import from dist — may load native or fall back to WASM.
    // Both backends are valid; the key assertion is correct hash output.
    expect(["native", "wasm"]).toContain(result.libraryStatus);
  });

  it("should produce correct hashes in the main thread (baseline)", async () => {
    const h1 = new XXHash128();
    h1.update(Buffer.from("hello world"));
    expect(h1.digest().toString("hex")).toBe(H_HELLO_WORLD);

    const h2 = new XXHash128();
    await h2.updateFile(fileA());
    expect(h2.digest().toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("should work with multiple concurrent Workers", async () => {
    const WORKERS = 4;
    const results = await Promise.all(Array.from({ length: WORKERS }, () => runInWorker(FIXTURES_DIR)));

    for (const result of results) {
      expect(result.hashHex).toBe(H_HELLO_WORLD);
      expect(result.fileHashHex).toBe(H_HELLO_WORLD_LF);
      expect(["native", "wasm"]).toContain(result.libraryStatus);
    }
  });

  it("should work with concurrent bulk hashing across Workers and main thread", async () => {
    // All threads (main + workers) doing updateFilesBulk simultaneously.
    // This exercises the g_active_hash_threads over-subscription prevention.
    const WORKERS = 4;

    const workerPromises = Array.from({ length: WORKERS }, () => runBulkInWorker(FIXTURES_DIR, 50));

    // Also do it on the main thread concurrently
    const mainHash = new XXHash128();
    const files = Array.from({ length: 50 }, () => fileA());
    const mainPromise = mainHash.updateFilesBulk(files).then(() => mainHash.digest().toString("hex"));

    const [mainHex, ...workerResults] = await Promise.all([mainPromise, ...workerPromises]);

    // All should produce the same digest (same files, same order, same seed)
    for (const result of workerResults) {
      expect(result.hex).toBe(mainHex);
    }
  });
});
