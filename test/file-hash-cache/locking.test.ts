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
import { FileHashCache, threadPoolTrim } from "fast-fs-hash";
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

//  - isLocked

describe("FileHashCache.isLocked", () => {
  it("returns false for non-existent file", () => {
    expect(FileHashCache.isLocked(cachePath("no-exist"))).toBe(false);
  });

  it("returns false for an unlocked cache file", async () => {
    const cp = cachePath("unlocked");
    const files = [fixtureFile("a.txt")];

    await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
    await ctx.write();
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
    await using _ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
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

    await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
    await ctx.write();

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

//  - threadPoolTrim

describe("threadPoolTrim", () => {
  it("does not throw and is callable", () => {
    expect(() => threadPoolTrim()).not.toThrow();
  });

  it("can be called multiple times without error", () => {
    threadPoolTrim();
    threadPoolTrim();
    threadPoolTrim();
  });

  it("does not break subsequent cache operations", async () => {
    const cp = cachePath("post-trim");
    const files = [fixtureFile("a.txt")];

    // Seed cache
    {
      await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      await ctx.write();
    }

    // Trim idle threads
    threadPoolTrim();

    // Cache operations should still work
    {
      await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 1);
      expect(ctx.status).toBe("upToDate");
    }
  }, 30_000);

  it("pool recovers after trim (new work spawns threads)", async () => {
    threadPoolTrim();

    // Wait a bit for threads to self-terminate
    await new Promise((r) => setTimeout(r, 50));

    // New heavy work should still succeed
    const cp = cachePath("post-trim-heavy");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    const ok = await FileHashCache.writeNew(cp, FIXTURE_DIR, files);
    expect(ok).toBe(true);

    await using ctx = await FileHashCache.open(cp, FIXTURE_DIR, files, 0);
    expect(ctx.status).toBe("upToDate");
  }, 30_000);
});
