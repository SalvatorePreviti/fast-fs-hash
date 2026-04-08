/**
 * Tests: FileHashCache.isLocked.
 *
 * isLocked detects locks held by any holder, including the calling process,
 * because flock(2) on POSIX is per-open-file-description (per-OFD): a fresh
 * open() in the checker correctly competes with all existing OFDs, in this
 * process and others. On Windows the per-handle LockFileEx semantics give
 * the same result.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupChildren, killChild, lockInChild, releaseChild } from "./_child-lock-utils";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-is-locked");
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

describe("FileHashCache.isLocked", () => {
  it("returns false for non-existent file", () => {
    expect(FileHashCache.isLocked(cachePath("no-exist"))).toBe(false);
  });

  it("returns false for an unlocked cache file", async () => {
    const cp = cachePath("unlocked");
    const files = [fixtureFile("a.txt")];

    using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    await session.write();
    expect(FileHashCache.isLocked(cp)).toBe(false);
  });

  it("returns true while a cache is locked by another process", async () => {
    const cp = cachePath("held-open");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    try {
      expect(acquired).toBe(true);
      expect(FileHashCache.isLocked(cp)).toBe(true);
    } finally {
      await releaseChild(child);
      await killChild(child);
    }

    expect(FileHashCache.isLocked(cp)).toBe(false);
  }, 30_000);

  it("returns true when checking a lock held by the same process", async () => {
    // flock(2) per-OFD semantics on POSIX (matching Windows LockFileEx) make
    // the checker's fresh open() compete with our own held OFD, so we observe
    // our own lock — which is the correct, useful behavior for worker_threads.
    const cp = cachePath("own-lock");
    const files = [fixtureFile("a.txt")];

    using _session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    expect(FileHashCache.isLocked(cp)).toBe(true);
  });
});
