/**
 * Tests: Lock cancellation and timeout behavior (cross-process).
 *
 * Verifies that:
 * - open() with lockTimeoutMs=0 returns status='lockFailed' when lock is held
 * - open() with a short lockTimeoutMs returns status='lockFailed' when lock is held
 * - overwrite() with a short lockTimeoutMs returns false when lock is held
 * - write() on a lockFailed instance falls back to overwrite
 * - needsWrite is false for lockFailed status
 * - waitUnlocked() with lockTimeoutMs=0 returns false when lock is held
 * - AbortSignal cancellation during cross-process lock wait
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

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-lock-cancel");
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

const activeChildren: Set<ChildProcess> = new Set();

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(fixtureFile("a.txt"), "lock-cancel-test\n");
  writeFileSync(fixtureFile("b.txt"), "another file\n");
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
    child.on("exit", () => {
      activeChildren.delete(child);
      resolve();
    });
    child.send("release");
  });
}

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

describe("Lock cancellation and timeout", () => {
  it("open() with lockTimeoutMs=0 returns lockFailed when lock is held", async () => {
    const cp = cachePath("nonblocking");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      await using session = await new FileHashCache({
        cachePath: cp,
        files,
        rootPath: FIXTURE_DIR,
        version: 1,
        lockTimeoutMs: 0,
      }).open();
      expect(session.status).toBe("lockFailed");
      expect(session.needsWrite).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("open() with short lockTimeoutMs returns lockFailed on timeout", async () => {
    const cp = cachePath("short-timeout");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      await using session = await new FileHashCache({
        cachePath: cp,
        files,
        rootPath: FIXTURE_DIR,
        version: 1,
        lockTimeoutMs: 100,
      }).open();
      expect(session.status).toBe("lockFailed");
      expect(session.needsWrite).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("open() succeeds after lock is released within timeout", async () => {
    const cp = cachePath("release-in-time");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    expect(acquired).toBe(true);

    // Start open with generous timeout — will block on the lock
    const openPromise = new FileHashCache({
      cachePath: cp,
      files,
      rootPath: FIXTURE_DIR,
      version: 1,
      lockTimeoutMs: 20_000,
    }).open();

    // Gracefully release the lock via IPC — deterministic, no guessing
    await releaseChild(child);
    await killChild(child);

    await using session = await openPromise;
    expect(session.status).not.toBe("lockFailed");
    expect(session.disposed).toBe(false);
  }, 30_000);

  it("overwrite() with lockTimeoutMs=0 returns false when lock is held", async () => {
    const cp = cachePath("write-new-nonblocking");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      const result = await new FileHashCache({
        cachePath: cp,
        files,
        rootPath: FIXTURE_DIR,
        lockTimeoutMs: 0,
      }).overwrite();
      expect(result).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("overwrite() with short lockTimeoutMs returns false on timeout", async () => {
    const cp = cachePath("write-new-timeout");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      const result = await new FileHashCache({
        cachePath: cp,
        files,
        rootPath: FIXTURE_DIR,
        lockTimeoutMs: 100,
      }).overwrite();
      expect(result).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("open() with infinite timeout succeeds when lock is eventually released", async () => {
    const cp = cachePath("infinite-release");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    expect(acquired).toBe(true);

    // Start open with infinite timeout (-1, the default)
    const openPromise = new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();

    // Gracefully release the lock via IPC
    await releaseChild(child);
    await killChild(child);

    await using session = await openPromise;
    expect(session.status).not.toBe("lockFailed");
    expect(session.disposed).toBe(false);
  }, 30_000);

  it("write() on lockFailed instance falls back to overwrite after lock is released", async () => {
    const cp = cachePath("write-fallback");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    expect(acquired).toBe(true);

    // Open with non-blocking — gets lockFailed
    const session = await new FileHashCache({
      cachePath: cp,
      files,
      rootPath: FIXTURE_DIR,
      version: 1,
      lockTimeoutMs: 0,
    }).open();
    expect(session.status).toBe("lockFailed");
    expect(session.needsWrite).toBe(false);

    // Gracefully release the lock so write() -> overwrite can acquire it
    await releaseChild(child);
    await killChild(child);

    // write() should fall back to overwrite and succeed
    const result = await session.write();
    expect(result).toBe(true);
    expect(session.disposed).toBe(true);

    // Verify the cache was actually written by re-opening it
    await using verify = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    expect(verify.status).toBe("upToDate");
  }, 30_000);

  it("write() on lockFailed instance returns false when lock is still held", async () => {
    const cp = cachePath("write-fallback-fail");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      // Open with non-blocking — gets lockFailed
      const session = await new FileHashCache({
        cachePath: cp,
        files,
        rootPath: FIXTURE_DIR,
        version: 1,
        lockTimeoutMs: 0,
      }).open();
      expect(session.status).toBe("lockFailed");

      // write() falls back to overwrite which also can't acquire the lock
      const result = await session.write();
      expect(result).toBe(false);
      expect(session.disposed).toBe(true);
    } finally {
      await killChild(child);
    }
  }, 30_000);
});

describe("AbortSignal cancellation (cross-process)", () => {
  it("open() with signal aborted during lock wait returns lockFailed", async () => {
    const cp = cachePath("abort-during");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      const ac = new AbortController();
      // Abort on next tick — native poll loop (100ms) picks it up promptly
      setTimeout(() => ac.abort(), 0);

      await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open(
        ac.signal
      );
      expect(session.status).toBe("lockFailed");
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("overwrite() with signal aborted during lock wait returns false", async () => {
    const cp = cachePath("abort-writenew-during");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 0);

      const result = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
        lockTimeoutMs: -1,
        signal: ac.signal,
      });
      expect(result).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("waitUnlocked() with already-aborted signal returns false immediately", async () => {
    const cp = cachePath("abort-wait-pre");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      const ac = new AbortController();
      ac.abort();

      const start = Date.now();
      const result = await FileHashCache.waitUnlocked(cp, -1, ac.signal);
      const elapsed = Date.now() - start;
      expect(result).toBe(false);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("waitUnlocked() with signal aborted during wait returns false", async () => {
    const cp = cachePath("abort-wait-during");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files);
    try {
      expect(acquired).toBe(true);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 0);

      const result = await FileHashCache.waitUnlocked(cp, -1, ac.signal);
      expect(result).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);
});
