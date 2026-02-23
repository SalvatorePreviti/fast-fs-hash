/**
 * Lock acquisition benchmarks — uncontended fast path.
 */

import { KeyedLock, ProcessLock } from "fast-fs-hash";
import { bench, describe } from "vitest";

describe("lock — uncontended acquire + release", () => {
  bench("KeyedLock", async () => {
    const lock = await KeyedLock.acquire("bench-keyed");
    lock.release();
  });

  bench("ProcessLock", async () => {
    const lock = await ProcessLock.acquire("bench-process");
    lock.release();
  });
});
