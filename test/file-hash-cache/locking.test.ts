/**
 * Tests: FileHashCache locking — isLocked, waitUnlocked, threadPoolTrim.
 *
 * isLocked and waitUnlocked detect locks held by OTHER processes (POSIX fcntl
 * semantics: F_GETLK never reports the calling process's own locks). These
 * tests use child_process.fork() to hold locks from a separate process.
 *
 * Coordination uses IPC messages for deterministic signaling:
 * - Child sends { acquired: true } when it holds the lock
 * - Parent sends "release" when it wants the child to drop the lock
 * - Child sends { released: true } after disposing the cache
 */

import type { ChildProcess } from "node:child_process";

import { fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

//  - Fixture setup

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-locking");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

const CHILD_SCRIPT = path.resolve(import.meta.dirname, "../_child-process-helper.mjs");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

// Track spawned children for cleanup
const activeChildren: Set<ChildProcess> = new Set();

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  writeFileSync(fixtureFile("a.txt"), "hello world\n");
  writeFileSync(fixtureFile("b.txt"), "goodbye world\n");
});

afterEach(() => {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  activeChildren.clear();
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Spawn a child process that acquires an exclusive lock and signals when ready. */
function lockInChild(cp: string, files: string[]): Promise<{ child: ChildProcess; acquired: boolean }> {
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ mode: "lock-and-hang", cachePath: cp, rootPath: FIXTURE_DIR, files });
    const child = fork(CHILD_SCRIPT, [args], { stdio: "pipe" });
    activeChildren.add(child);
    child.on("message", (msg: { acquired: boolean }) => {
      resolve({ child, acquired: msg.acquired });
    });
    child.on("error", reject);
    child.on("exit", () => {
      activeChildren.delete(child);
    });
  });
}

/** Ask a child to release its lock via IPC and wait for confirmation. */
function releaseChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (msg: { released?: boolean }) => {
      if (msg.released) {
        child.removeListener("message", onMsg);
        resolve();
      }
    };
    child.on("message", onMsg);
    // If the child dies before confirming, resolve anyway (lock is released by OS)
    child.on("exit", () => {
      activeChildren.delete(child);
      resolve();
    });
    child.send("release");
  });
}

/** Kill a child process and wait for it to exit. */
function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      activeChildren.delete(child);
      resolve();
      return;
    }
    child.on("exit", () => {
      activeChildren.delete(child);
      resolve();
    });
    child.kill("SIGKILL");
  });
}

function runTrimRaceInChild(filePath: string, iterations = 200): Promise<{ ok: boolean; iterations: number }> {
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ mode: "trim-race", filePath, iterations, pauseMs: 5, waveSize: 3 });
    const child = fork(CHILD_SCRIPT, [args], {
      stdio: "pipe",
      env: {
        ...process.env,
        FAST_FS_HASH_POOL_IDLE_TIMEOUT_MS: "1",
      },
    });
    activeChildren.add(child);

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("trim-race child timed out"));
    }, 15_000);

    child.on("message", (msg: { ok: boolean; iterations: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(msg);
      child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      activeChildren.delete(child);
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0 || code === null || signal === "SIGTERM") {
        return;
      }
      reject(new Error(`trim-race child exited with code ${code}`));
    });
  });
}

//  - isLocked

describe("FileHashCache.isLocked", () => {
  it("returns false for non-existent file", () => {
    expect(FileHashCache.isLocked(cachePath("no-exist"))).toBe(false);
  });

  it("returns false for an unlocked cache file", async () => {
    const cp = cachePath("unlocked");
    const files = [fixtureFile("a.txt")];

    await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    await session.write();
    // write() releases the lock
    expect(FileHashCache.isLocked(cp)).toBe(false);
  });

  it("returns true while a cache is locked by another process", async () => {
    const cp = cachePath("held-open");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);
      expect(FileHashCache.isLocked(cp)).toBe(true);
    } finally {
      // Gracefully release, then verify unlocked
      await releaseChild(child);
      await killChild(child);
    }

    expect(FileHashCache.isLocked(cp)).toBe(false);
  }, 30_000);

  it("returns false on POSIX (fcntl limitation) and true on Windows when checking own process lock", async () => {
    const cp = cachePath("own-lock");
    const files = [fixtureFile("a.txt")];

    // POSIX: fcntl F_GETLK never reports the calling process's own locks → false
    // Windows: LockFileEx on a separate handle sees the lock even within the same process → true
    await using _session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    const expected = process.platform === "win32";
    expect(FileHashCache.isLocked(cp)).toBe(expected);
  });
});

//  - waitUnlocked

describe("FileHashCache.waitUnlocked", () => {
  it("resolves true immediately for non-existent file", async () => {
    const result = await FileHashCache.waitUnlocked(cachePath("no-exist-wait"));
    expect(result).toBe(true);
  });

  it("resolves true immediately for unlocked file", async () => {
    const cp = cachePath("unlocked-wait");
    const files = [fixtureFile("a.txt")];

    await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    await session.write();

    const result = await FileHashCache.waitUnlocked(cp);
    expect(result).toBe(true);
  });

  it("resolves false on timeout when file is locked by another process", async () => {
    const cp = cachePath("timeout-wait");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      // 0ms timeout = non-blocking check, should fail
      const result0 = await FileHashCache.waitUnlocked(cp, 0);
      expect(result0).toBe(false);

      // Short timeout — file is still locked
      const result = await FileHashCache.waitUnlocked(cp, 100);
      expect(result).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("resolves true when lock is released before timeout", async () => {
    const cp = cachePath("release-wait");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    expect(acquired).toBe(true);

    // Start waiting with a generous timeout
    const waitPromise = FileHashCache.waitUnlocked(cp, 20_000);

    // Gracefully release the lock via IPC
    await releaseChild(child);
    await killChild(child);

    const result = await waitPromise;
    expect(result).toBe(true);
  }, 30_000);

  it("resolves true for infinite wait when lock is released", async () => {
    const cp = cachePath("infinite-wait");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    expect(acquired).toBe(true);

    // Start waiting with -1 (infinite)
    const waitPromise = FileHashCache.waitUnlocked(cp, -1);

    // Gracefully release the lock via IPC
    await releaseChild(child);
    await killChild(child);

    const result = await waitPromise;
    expect(result).toBe(true);
  }, 30_000);
});

//  - threadPoolTrim (child-process-dependent test only; basic tests in thread-pool-trim.test.ts)

describe("threadPoolTrim", () => {
  it("does not strand new work while idle threads self-terminate", async () => {
    const result = await runTrimRaceInChild(fixtureFile("a.txt"), 50);
    expect(result.ok).toBe(true);
  }, 30_000);
});
