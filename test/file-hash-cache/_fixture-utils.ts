import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

export interface CacheTestDirs {
  TEST_DIR: string;
  FIXTURE_DIR: string;
  CACHE_DIR: string;
  cachePath: (label?: string, subdir?: string) => string;
  fixtureFile: (name: string) => string;
}

/**
 * Per-test-file fixture scaffolding. Registers vitest `beforeAll`/`afterAll`
 * hooks to create and tear down `tmp/<label>/{fixtures,cache}`, and returns
 * helpers:
 *   - `cachePath(label?, subdir?)` — unique cache file path; `subdir` (e.g.
 *     `"nested/deep"`) is created on demand under CACHE_DIR.
 *   - `fixtureFile(name)` — absolute path under FIXTURE_DIR.
 *
 * Callers add their own `beforeAll` to write fixture file contents.
 */
export function setupCacheTestDir(label: string): CacheTestDirs {
  const TEST_DIR = path.resolve(import.meta.dirname, "tmp", label);
  const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
  const CACHE_DIR = path.join(TEST_DIR, "cache");

  let counter = 0;
  const cachePath = (name = "test", subdir?: string): string => {
    const dir = subdir ? path.join(CACHE_DIR, subdir) : CACHE_DIR;
    return path.join(dir, `${name}-${++counter}.cache`);
  };
  const fixtureFile = (name: string): string => path.join(FIXTURE_DIR, name);

  beforeAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });
    mkdirSync(CACHE_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  return { TEST_DIR, FIXTURE_DIR, CACHE_DIR, cachePath, fixtureFile };
}
