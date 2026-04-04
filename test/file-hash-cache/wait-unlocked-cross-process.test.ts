/**
 * Tests: FileHashCache.waitUnlocked (cross-process).
 *
 * waitUnlocked detects locks held by OTHER processes (POSIX fcntl semantics).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupChildren, killChild, lockInChild, releaseChild } from "./_child-lock-utils";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-wait-unlocked-xp");
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
  writeFileSync(fixtureFile("a.txt"), "hello world\n");
});

afterEach(cleanupChildren);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileHashCache.waitUnlocked (cross-process)", () => {
  it("resolves false on timeout when file is locked by another process", async () => {
    const cp = cachePath("timeout-wait");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    try {
      expect(acquired).toBe(true);

      const result0 = await FileHashCache.waitUnlocked(cp, 0);
      expect(result0).toBe(false);

      const result = await FileHashCache.waitUnlocked(cp, 10);
      expect(result).toBe(false);
    } finally {
      await killChild(child);
    }
  }, 30_000);

  it("resolves true when lock is released before timeout", async () => {
    const cp = cachePath("release-wait");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    expect(acquired).toBe(true);

    const waitPromise = FileHashCache.waitUnlocked(cp, 20_000);

    await releaseChild(child);
    await killChild(child);

    const result = await waitPromise;
    expect(result).toBe(true);
  }, 30_000);

  it("resolves true for infinite wait when lock is released", async () => {
    const cp = cachePath("infinite-wait");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    expect(acquired).toBe(true);

    const waitPromise = FileHashCache.waitUnlocked(cp, -1);

    await releaseChild(child);
    await killChild(child);

    const result = await waitPromise;
    expect(result).toBe(true);
  }, 30_000);
});
