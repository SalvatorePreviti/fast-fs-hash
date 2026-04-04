/**
 * Tests: write() fallback behavior on lockFailed (cross-process).
 *
 * Verifies that write() on a lockFailed session falls back to overwrite,
 * and returns false when the lock is still held.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupChildren, killChild, lockInChild, releaseChild } from "./_child-lock-utils";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-lock-write-fb");
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
  writeFileSync(fixtureFile("a.txt"), "write-fallback-test\n");
  writeFileSync(fixtureFile("b.txt"), "another file\n");
});

afterEach(cleanupChildren);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("write() fallback on lockFailed", () => {
  it("write() on lockFailed falls back to overwrite after lock is released", async () => {
    const cp = cachePath("write-fallback");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    expect(acquired).toBe(true);

    const session = await new FileHashCache({
      cachePath: cp,
      files,
      rootPath: FIXTURE_DIR,
      version: 1,
      lockTimeoutMs: 0,
    }).open();
    expect(session.status).toBe("lockFailed");
    expect(session.needsWrite).toBe(false);

    await releaseChild(child);
    await killChild(child);

    const result = await session.write();
    expect(result).toBe(true);
    expect(session.disposed).toBe(true);

    using verify = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    expect(verify.status).toBe("upToDate");
  }, 30_000);

  it("write() on lockFailed returns false when lock is still held", async () => {
    const cp = cachePath("write-fallback-fail");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    try {
      expect(acquired).toBe(true);

      const session = await new FileHashCache({
        cachePath: cp,
        files,
        rootPath: FIXTURE_DIR,
        version: 1,
        lockTimeoutMs: 0,
      }).open();
      expect(session.status).toBe("lockFailed");

      const result = await session.write();
      expect(result).toBe(false);
      expect(session.disposed).toBe(true);
    } finally {
      await killChild(child);
    }
  }, 30_000);
});
