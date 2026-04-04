/**
 * Tests: threadPoolTrim — basic functionality (no child processes).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache, threadPoolTrim } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-trim");
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
  writeFileSync(fixtureFile("b.txt"), "goodbye world\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

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

    {
      await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
      await session.write();
    }

    threadPoolTrim();

    {
      await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
      expect(session.status).toBe("upToDate");
    }
  });

  it("pool recovers after trim (new work spawns threads)", async () => {
    threadPoolTrim();
    await new Promise((r) => setTimeout(r, 5));

    const cp = cachePath("post-trim-heavy");
    const files = [fixtureFile("a.txt"), fixtureFile("b.txt")];
    const ok = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite();
    expect(ok).toBe(true);

    await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 0 }).open();
    expect(session.status).toBe("upToDate");
  });
});
