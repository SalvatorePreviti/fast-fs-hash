import { execFile } from "node:child_process";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { ProcessLock } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

// Windows uses kernel-managed named mutexes with different cross-process semantics
// (auto-released, re-entrant) — these tests validate POSIX shm-based locking.
const isWindows = process.platform === "win32";
const describeUnix = isWindows ? describe.skip : describe;

/** Run a JS snippet in a child process. Returns stdout. */
function runChild(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", code],
      { timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
      (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

const IMPORT = 'import { ProcessLock } from "./packages/fast-fs-hash/dist/index.mjs";';

describeUnix("ProcessLock cross-process", () => {
  it("child process can acquire after parent releases", async () => {
    const key = `cross-test-${Date.now()}`;
    const lock = await ProcessLock.acquire(key);

    // Child tries to acquire with timeout=0 — should fail because parent holds it
    const failResult = await runChild(`
      ${IMPORT}
      try {
        await ProcessLock.acquire("${key}", { timeout: 0 });
        console.log("acquired");
      } catch {
        console.log("failed");
      }
    `);
    expect(failResult).toBe("failed");

    // Release parent lock
    lock.release();

    // Child should now succeed
    const successResult = await runChild(`
      ${IMPORT}
      try {
        const lock = await ProcessLock.acquire("${key}", { timeout: 1000 });
        console.log("acquired");
        lock.release();
      } catch {
        console.log("failed");
      }
    `);
    expect(successResult).toBe("acquired");
  });

  it("recovers from crashed child process", async () => {
    const key = `crash-test-${Date.now()}`;

    // Child acquires lock and exits without releasing (simulates crash)
    await runChild(`
      ${IMPORT}
      await ProcessLock.acquire("${key}");
      // Exit without releasing — simulates crash
      process.exit(0);
    `);

    // Parent should recover the stale lock and acquire
    const lock = await ProcessLock.acquire(key, { timeout: 2000 });
    expect(lock.ownsLock).toBe(true);
    lock.release();
  });

  it("serializes across two child processes", async () => {
    const key = `serial-test-${Date.now()}`;

    // Pre-create the shm segment from the parent so children don't race on creation
    const setup = await ProcessLock.acquire(key);
    setup.release();

    const [r1, r2] = await Promise.all([
      runChild(`
        ${IMPORT}
        const lock = await ProcessLock.acquire("${key}", { timeout: 5000 });
        await new Promise(r => setTimeout(r, 50));
        console.log("child1");
        lock.release();
      `),
      runChild(`
        ${IMPORT}
        const lock = await ProcessLock.acquire("${key}", { timeout: 5000 });
        console.log("child2");
        lock.release();
      `),
    ]);

    expect(r1).toBe("child1");
    expect(r2).toBe("child2");
  });
});

const WORKER_HELPER = path.resolve(import.meta.dirname, "_worker-thread-helper.mjs");

describeUnix("ProcessLock worker thread", () => {
  it("lock is released when worker is terminated", async () => {
    const key = `worker-term-${Date.now()}`;

    // Spawn worker that acquires lock and hangs
    const worker = new Worker(WORKER_HELPER, {
      workerData: { mode: "lock-and-hang", lockKey: key },
    });

    // Wait for worker to signal it acquired the lock
    const msg = await new Promise<{ acquired: boolean }>((resolve) => {
      worker.on("message", resolve);
    });
    expect(msg.acquired).toBe(true);

    // Lock should be held
    expect(ProcessLock.isLocked(key)).toBe(true);

    // Terminate the worker (does NOT run finally blocks)
    await worker.terminate();

    // The addon cleanup hook should have released the lock.
    // Give it a moment for async cleanup to propagate.
    await new Promise<void>((r) => {
      setTimeout(r, 100);
    });

    // Now we should be able to acquire the lock
    const lock = await ProcessLock.acquire(key, { timeout: 2000 });
    expect(lock.ownsLock).toBe(true);
    lock.release();
  });
});
