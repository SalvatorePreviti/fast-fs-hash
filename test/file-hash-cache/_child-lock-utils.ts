/**
 * Shared utilities for cross-process lock tests.
 *
 * Provides helpers to fork a child that acquires a cache file lock,
 * release it via IPC, and kill it cleanly.
 */

import type { ChildProcess } from "node:child_process";

import { fork } from "node:child_process";
import path from "node:path";

const CHILD_SCRIPT = path.resolve(import.meta.dirname, "../_child-process-helper.mjs");

/** Set of active children — call cleanupChildren() in afterEach. */
export const activeChildren: Set<ChildProcess> = new Set();

/** Kill all active children. Use in afterEach(). */
export function cleanupChildren(): void {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  activeChildren.clear();
}

/** Spawn a child process that acquires an exclusive lock and signals when ready. */
export function lockInChild(
  cp: string,
  files: string[],
  rootPath: string
): Promise<{ child: ChildProcess; acquired: boolean }> {
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ mode: "lock-and-hang", cachePath: cp, rootPath, files });
    const child = fork(CHILD_SCRIPT, [args], { stdio: "pipe" });
    activeChildren.add(child);
    child.on("message", (msg: { acquired: boolean }) => {
      resolve({ child, acquired: msg.acquired });
    });
    child.on("error", reject);
    child.on("exit", () => {
      activeChildren.delete(child);
    });
  });
}

/** Ask a child to release its lock via IPC and wait for confirmation. */
export function releaseChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (msg: { released?: boolean }) => {
      if (msg.released) {
        child.removeListener("message", onMsg);
        resolve();
      }
    };
    child.on("message", onMsg);
    child.on("exit", () => {
      activeChildren.delete(child);
      resolve();
    });
    child.send("release");
  });
}

/** Kill a child process and wait for it to exit. */
export function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      activeChildren.delete(child);
      resolve();
      return;
    }
    child.on("exit", () => {
      activeChildren.delete(child);
      resolve();
    });
    child.kill("SIGKILL");
  });
}
