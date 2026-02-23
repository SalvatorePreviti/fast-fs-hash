/**
 * Tests: threadPoolTrim race condition (child-process-dependent).
 *
 * Verifies that new work is not stranded while idle threads self-terminate.
 * Uses a child process with FAST_FS_HASH_POOL_IDLE_TIMEOUT_MS=1 to force
 * rapid thread lifecycle turnover.
 */

import type { ChildProcess } from "node:child_process";

import { fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.resolve(import.meta.dirname, "tmp/fhc-trim-race");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures");
const CHILD_SCRIPT = path.resolve(import.meta.dirname, "../_child-process-helper.mjs");

const activeChildren: Set<ChildProcess> = new Set();

function fixtureFile(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixtureFile("a.txt"), "hello world\n");
});

afterEach(() => {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  activeChildren.clear();
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function runTrimRaceInChild(filePath: string, iterations = 200): Promise<{ ok: boolean; iterations: number }> {
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ mode: "trim-race", filePath, iterations, pauseMs: 5, waveSize: 3 });
    const child = fork(CHILD_SCRIPT, [args], {
      stdio: "pipe",
      env: {
        ...process.env,
        FAST_FS_HASH_POOL_IDLE_TIMEOUT_MS: "1",
      },
    });
    activeChildren.add(child);

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("trim-race child timed out"));
    }, 15_000);

    child.on("message", (msg: { ok: boolean; iterations: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(msg);
      child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      activeChildren.delete(child);
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0 || code === null || signal === "SIGTERM") {
        return;
      }
      reject(new Error(`trim-race child exited with code ${code}`));
    });
  });
}

describe("threadPoolTrim", () => {
  it("does not strand new work while idle threads self-terminate", async () => {
    const result = await runTrimRaceInChild(fixtureFile("a.txt"), 50);
    expect(result.ok).toBe(true);
  }, 30_000);
});
