/**
 * Tests: FileHashCache.waitUnlocked (fast, in-process only).
 *
 * No child process fork needed for these tests.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-wait-unlocked");
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

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileHashCache.waitUnlocked", () => {
  it("resolves true immediately for non-existent file", async () => {
    const result = await FileHashCache.waitUnlocked(cachePath("no-exist-wait"));
    expect(result).toBe(true);
  });

  it("resolves true immediately for unlocked file", async () => {
    const cp = cachePath("unlocked-wait");
    const files = [fixtureFile("a.txt")];

    using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    await session.write();

    const result = await FileHashCache.waitUnlocked(cp);
    expect(result).toBe(true);
  });
});
