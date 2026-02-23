/**
 * Tests: Lock release within timeout (cross-process).
 *
 * Verifies that open() succeeds when the lock is released before the timeout expires.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupChildren, killChild, lockInChild, releaseChild } from "./_child-lock-utils";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-lock-release");
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
  writeFileSync(fixtureFile("a.txt"), "lock-release-test\n");
});

afterEach(cleanupChildren);

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Lock release within timeout", () => {
  it("open() succeeds after lock is released within timeout", async () => {
    const cp = cachePath("release-in-time");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    expect(acquired).toBe(true);

    const openPromise = new FileHashCache({
      cachePath: cp,
      files,
      rootPath: FIXTURE_DIR,
      version: 1,
      lockTimeoutMs: 20_000,
    }).open();

    await releaseChild(child);
    await killChild(child);

    using session = await openPromise;
    expect(session.status).not.toBe("lockFailed");
    expect(session.disposed).toBe(false);
  }, 30_000);

  it("open() with infinite timeout succeeds when lock is eventually released", async () => {
    const cp = cachePath("infinite-release");
    const files = [fixtureFile("a.txt")];

    const { child, acquired } = await lockInChild(cp, files, FIXTURE_DIR);
    expect(acquired).toBe(true);

    const openPromise = new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();

    await releaseChild(child);
    await killChild(child);

    using session = await openPromise;
    expect(session.status).not.toBe("lockFailed");
    expect(session.disposed).toBe(false);
  }, 30_000);
});
