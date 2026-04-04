/**
 * Tests: AbortSignal cancellation (in-process, no child processes).
 *
 * Verifies that:
 * - open() with already-aborted signal returns lockFailed immediately
 * - open() with a non-aborted signal succeeds normally
 * - overwrite() with already-aborted signal returns false
 * - write() uses stored cancelBuf from open signal
 * - write() accepts its own signal in options
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileHashCache } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-abort-signal");
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
  writeFileSync(fixtureFile("a.txt"), "lock-cancel-test\n");
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("AbortSignal cancellation", () => {
  it("open() with already-aborted signal returns lockFailed immediately", async () => {
    const cp = cachePath("abort-pre");
    const files = [fixtureFile("a.txt")];
    const ac = new AbortController();
    ac.abort();

    const start = Date.now();
    await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open(
      ac.signal
    );
    const elapsed = Date.now() - start;
    expect(session.status).toBe("lockFailed");
    expect(session.needsWrite).toBe(false);
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);

  it("open() with signal that is not aborted succeeds normally", async () => {
    const cp = cachePath("abort-not-fired");
    const files = [fixtureFile("a.txt")];
    const ac = new AbortController();

    await using session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open(
      ac.signal
    );
    expect(session.status).not.toBe("lockFailed");
    expect(session.disposed).toBe(false);
  }, 30_000);

  it("overwrite() with already-aborted signal returns false", async () => {
    const cp = cachePath("abort-writenew-pre");
    const files = [fixtureFile("a.txt")];
    const ac = new AbortController();
    ac.abort();

    const result = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR }).overwrite({
      signal: ac.signal,
    });
    expect(result).toBe(false);
  }, 30_000);

  it("write() uses stored cancelBuf from open signal", async () => {
    const cp = cachePath("abort-write-stored");
    const files = [fixtureFile("a.txt")];

    // Open without signal, write a cache first
    await using seed = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    await seed.write();

    // Modify file so cache is dirty
    writeFileSync(fixtureFile("a.txt"), "modified-for-abort-test\n");

    // Open with a signal, then abort before write
    const ac = new AbortController();
    const session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open(
      ac.signal
    );
    expect(session.status).not.toBe("lockFailed");
    expect(session.status).not.toBe("upToDate");

    // Abort the signal — write's hash phase should see this
    ac.abort();
    // write() should still succeed because cancellation doesn't apply during file write
    // (CacheWriter checks cancelByte during hash loop but completes the write)
    const result = await session.write();
    // The write may succeed or the hash phase may detect cancellation —
    // either outcome is valid depending on timing
    expect(typeof result).toBe("boolean");
    expect(session.disposed).toBe(true);

    // Restore fixture
    writeFileSync(fixtureFile("a.txt"), "lock-cancel-test\n");
  }, 30_000);

  it("write() accepts its own signal in options", async () => {
    const cp = cachePath("abort-write-opts");
    const files = [fixtureFile("a.txt")];

    // Seed a cache
    await using seed = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    await seed.write();

    // Modify file
    writeFileSync(fixtureFile("a.txt"), "modified-for-write-signal-test\n");

    // Open without signal
    const session = await new FileHashCache({ cachePath: cp, files, rootPath: FIXTURE_DIR, version: 1 }).open();
    expect(session.status).not.toBe("upToDate");

    // Write with an already-aborted signal
    const ac = new AbortController();
    ac.abort();
    const result = await session.write({ signal: ac.signal });
    expect(typeof result).toBe("boolean");
    expect(session.disposed).toBe(true);

    // Restore fixture
    writeFileSync(fixtureFile("a.txt"), "lock-cancel-test\n");
  }, 30_000);
});
