/**
 * Tests: AbortSignal cancellation during cross-process lock wait.
 *
 * Verifies that open(), overwrite(), and waitUnlocked() respect AbortSignal
 * when another process holds the lock.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupChildren, killChild, lockInChild } from "./_child-lock-utils";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-lock-abort");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CACHE_DIR = path.join(TEST_DIR, "cache");

let cacheCounter = 0;
function cachePath(label = "test"): string {
  return path.join(CACHE_DIR, `${label}-${++cacheCounter}.cache`);
}

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(fixtureFile("a.txt"), "abort-signal-test\n");
});

afterEach(cleanupChildren);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("AbortSignal cancellation (cross-process)", () => {
  it("open() with signal aborted during lock wait returns lockFailed", async () => {
    const cp = cachePath("abort-during");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    try {
      expect(acquired).toBe(true);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 0);

      using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open(
        ac.signal
      );
      expect(session.status).toBe("lockFailed");
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("overwrite() with signal aborted during lock wait returns false", async () => {
    const cp = cachePath("abort-overwrite-during");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
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

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
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

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
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
