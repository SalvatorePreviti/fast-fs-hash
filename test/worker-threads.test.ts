/**
 * Tests that fast-fs-hash works correctly inside Node.js Worker Threads.
 *
 * The native addon uses N-API (context-aware), so each Worker Thread gets
 * its own module instance. This test verifies:
 *   1. The native binding loads and initializes in a Worker Thread.
 *   2. Hashing produces correct results (matching main-thread values).
 *   3. Multiple Workers can hash concurrently without interference.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { digestFilesParallel, FileHashCache, XxHash128Stream } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

//  - Known values (same as xxhash128.test.ts)

const H_HELLO_WORLD = "df8d09e93f874900a99b8775cc15b6c7";
const H_HELLO_WORLD_LF = "eefac9d87100cd1336b2e733a5484425";

//  - Fixtures

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures-worker-threads");
const fileA = () => path.join(FIXTURES_DIR, "a.txt");

const WORKER_SCRIPT = path.resolve(import.meta.dirname, "_worker-thread-helper.mjs");

beforeAll(async () => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(fileA(), "hello world\n");
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

//  - Helper to run code in a Worker Thread

interface WorkerResult {
  hashHex: string;
  fileHashHex: string;
  impl: string;
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

//  - Tests

describe("Worker Threads", () => {
  it("should produce correct hashes in a Worker Thread", async () => {
    const result = await runInWorker(FIXTURES_DIR);

    expect(result.hashHex).toBe(H_HELLO_WORLD);
    expect(result.fileHashHex).toBe(H_HELLO_WORLD_LF);
  });

  it("should produce correct hashes in the main thread (baseline)", async () => {
    const h1 = new XxHash128Stream();
    h1.addBuffer(Buffer.from("hello world"));
    expect(h1.digest().toString("hex")).toBe(H_HELLO_WORLD);

    const h2 = new XxHash128Stream();
    await h2.addFile(fileA());
    expect(h2.digest().toString("hex")).toBe(H_HELLO_WORLD_LF);
  });

  it("should work with multiple concurrent Workers", async () => {
    const WORKERS = 4;
    const results = await Promise.all(Array.from({ length: WORKERS }, () => runInWorker(FIXTURES_DIR)));

    for (const result of results) {
      expect(result.hashHex).toBe(H_HELLO_WORLD);
      expect(result.fileHashHex).toBe(H_HELLO_WORLD_LF);
    }
  });

  it("should work with concurrent bulk hashing across Workers and main thread", async () => {
    // All threads (main + workers) doing addFilesParallel simultaneously.
    const WORKERS = 4;

    const workerPromises = Array.from({ length: WORKERS }, () => runBulkInWorker(FIXTURES_DIR, 50));

    // Also do it on the main thread concurrently
    const files = Array.from({ length: 50 }, () => fileA());
    const mainPromise = digestFilesParallel(files).then((buf) => buf.toString("hex"));

    const [mainHex, ...workerResults] = await Promise.all([mainPromise, ...workerPromises]);

    // All should produce the same digest (same files, same order, same seed)
    for (const result of workerResults) {
      expect(result.hex).toBe(mainHex);
    }
  });

  // - Cross-thread FileHashCache lock serialization
  //
  // Regression test for the worker_threads correctness bug:
  //   POSIX fcntl byte-range locks are PER-PROCESS — two threads in the same
  //   process can both "acquire" the lock simultaneously and corrupt the cache.
  //   We use flock(2) on POSIX (and LockFileEx on Windows), both of which are
  //   per-OFD / per-handle, so two open() calls in the same process get
  //   independent OFDs and serialize correctly.
  //
  // This test would have silently passed against the old fcntl impl while
  // racing both holders into the same critical section.

  describe("FileHashCache lock serialization across threads", () => {
    function lockInWorker(cachePath: string, files: string[], rootPath: string) {
      return new Promise<{ worker: Worker; acquired: boolean }>((resolve, reject) => {
        const worker = new Worker(WORKER_SCRIPT, {
          workerData: { mode: "lock-then-release", cachePath, files, rootPath },
        });
        worker.once("message", (msg: { acquired: boolean }) => {
          resolve({ worker, acquired: msg.acquired });
        });
        worker.on("error", reject);
      });
    }

    function releaseAndTerminate(worker: Worker): Promise<void> {
      return new Promise((resolve) => {
        const onMsg = (msg: { released?: boolean }) => {
          if (msg.released) {
            worker.removeListener("message", onMsg);
            void worker.terminate().then(() => resolve());
          }
        };
        worker.on("message", onMsg);
        worker.postMessage("release");
      });
    }

    it("main thread observes lockFailed while a worker holds the lock", async () => {
      const cp = path.join(FIXTURES_DIR, "thread-serialize-1.cache");
      const files = [fileA()];

      const { worker, acquired } = await lockInWorker(cp, files, FIXTURES_DIR);
      try {
        expect(acquired).toBe(true);

        // While the worker holds the lock, a non-blocking try from the main
        // thread MUST observe lockFailed. With the old per-process fcntl
        // impl, the kernel would silently grant the lock to the main thread
        // and we'd race two writers.
        const cache = new FileHashCache({
          cachePath: cp,
          files,
          rootPath: FIXTURES_DIR,
          version: 1,
          lockTimeoutMs: 0,
        });
        using s = await cache.open();
        expect(s.status).toBe("lockFailed");
      } finally {
        await releaseAndTerminate(worker);
      }

      // After release, the main thread can take the lock normally.
      const cache2 = new FileHashCache({ cachePath: cp, files, rootPath: FIXTURES_DIR, version: 1 });
      using s2 = await cache2.open();
      expect(s2.status).not.toBe("lockFailed");
    }, 30_000);

    it("FileHashCache.isLocked sees a lock held by a sibling worker", async () => {
      const cp = path.join(FIXTURES_DIR, "thread-serialize-2.cache");
      const files = [fileA()];

      const { worker, acquired } = await lockInWorker(cp, files, FIXTURES_DIR);
      try {
        expect(acquired).toBe(true);
        // The static checker uses a fresh OFD; flock(LOCK_EX|LOCK_NB) should
        // fail because the worker's OFD already holds the lock.
        expect(FileHashCache.isLocked(cp)).toBe(true);
      } finally {
        await releaseAndTerminate(worker);
      }

      expect(FileHashCache.isLocked(cp)).toBe(false);
    }, 30_000);

    it("main-thread open blocks until the worker releases (default timeout)", async () => {
      const cp = path.join(FIXTURES_DIR, "thread-serialize-3.cache");
      const files = [fileA()];

      const { worker, acquired } = await lockInWorker(cp, files, FIXTURES_DIR);
      expect(acquired).toBe(true);

      // Default lockTimeoutMs = -1: blocks until the worker releases.
      const cache = new FileHashCache({ cachePath: cp, files, rootPath: FIXTURES_DIR, version: 1 });
      const openPromise = cache.open();

      // Give the open() a moment — it must NOT have resolved yet, because
      // the worker still holds the lock.
      let resolvedEarly = false;
      const guard = openPromise.then(
        () => {
          resolvedEarly = true;
        },
        () => {
          resolvedEarly = true;
        }
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(resolvedEarly).toBe(false);

      // Now release. open() should resolve.
      await releaseAndTerminate(worker);
      const session = await openPromise;
      await guard;
      expect(session.status).not.toBe("lockFailed");
      session.close();
    }, 30_000);
  });
});
