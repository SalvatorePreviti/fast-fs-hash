/**
 * Tests: Non-blocking lock behavior (lockTimeoutMs=0, cross-process).
 *
 * Verifies that open() and overwrite() with lockTimeoutMs=0 return immediately
 * when a lock is held by another process.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupChildren, killChild, lockInChild } from "./_child-lock-utils";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-lock-nonblk");
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
  writeFileSync(fixtureFile("a.txt"), "lock-nonblocking-test\n");
});

afterEach(cleanupChildren);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Non-blocking lock (lockTimeoutMs=0)", () => {
  it("open() returns lockFailed when lock is held", async () => {
    const cp = cachePath("nonblocking");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    try {
      expect(acquired).toBe(true);

      using session = await new FileHashCache({
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

  it("overwrite() returns false when lock is held", async () => {
    const cp = cachePath("overwrite-nonblocking");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
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
});
