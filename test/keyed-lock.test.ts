import { KeyedLock } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

describe("KeyedLock", () => {
  it("acquires and releases a lock", async () => {
    const lock = await KeyedLock.acquire("a");
    expect(lock.ownsLock).toBe(true);
    expect(lock.locked).toBe(true);
    expect(lock.key).toBe("a");
    expect(lock.promise).toBeInstanceOf(Promise);
    expect(KeyedLock.isLocked("a")).toBe(true);
    expect(KeyedLock.count).toBe(1);

    expect(lock.release()).toBe(true);
    expect(lock.ownsLock).toBe(false);
    expect(lock.locked).toBe(false);
    expect(lock.key).toBe("a");
    expect(lock.promise).toBeUndefined();
    expect(KeyedLock.isLocked("a")).toBe(false);
    expect(KeyedLock.count).toBe(0);
  });

  it("release returns false on double release", async () => {
    const lock = await KeyedLock.acquire("b");
    expect(lock.release()).toBe(true);
    expect(lock.release()).toBe(false);
  });

  it("serializes concurrent acquires on the same key", async () => {
    const order: number[] = [];

    const task = async (id: number) => {
      const lock = await KeyedLock.acquire("shared");
      order.push(id);
      await new Promise<void>((r) => {
        setTimeout(r, 5);
      });
      lock.release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(KeyedLock.count).toBe(0);
  });

  it("allows concurrent acquires on different keys", async () => {
    const lock1 = await KeyedLock.acquire("x");
    const lock2 = await KeyedLock.acquire("y");
    expect(KeyedLock.count).toBe(2);
    expect(lock1.ownsLock).toBe(true);
    expect(lock2.ownsLock).toBe(true);
    expect(lock1.locked).toBe(true);
    expect(lock2.locked).toBe(true);
    expect(KeyedLock.isLocked("x")).toBe(true);
    expect(KeyedLock.isLocked("y")).toBe(true);

    lock1.release();
    lock2.release();
    expect(KeyedLock.count).toBe(0);
  });

  it("works with await using", async () => {
    {
      await using lock = await KeyedLock.acquire("disposable");
      expect(lock.ownsLock).toBe(true);
      expect(lock.locked).toBe(true);
      expect(KeyedLock.isLocked("disposable")).toBe(true);
    }
    expect(KeyedLock.isLocked("disposable")).toBe(false);
    expect(KeyedLock.count).toBe(0);
  });

  it("accepts non-string keys", async () => {
    const objKey = { id: 42 };
    const numKey = 123;
    const lock1 = await KeyedLock.acquire(objKey);
    const lock2 = await KeyedLock.acquire(numKey);
    expect(lock1.ownsLock).toBe(true);
    expect(lock2.ownsLock).toBe(true);
    expect(KeyedLock.isLocked(objKey)).toBe(true);
    expect(KeyedLock.isLocked(numKey)).toBe(true);
    expect(KeyedLock.isLocked({ id: 42 })).toBe(false);

    lock1.release();
    lock2.release();
    expect(KeyedLock.count).toBe(0);
  });

  it("works with a custom map", async () => {
    const customMap = new Map<string, KeyedLock>();
    const lock = await KeyedLock.acquire("custom", customMap);
    expect(lock.ownsLock).toBe(true);
    expect(lock.locked).toBe(true);
    expect(customMap.has("custom")).toBe(true);
    // Default map unaffected
    expect(KeyedLock.isLocked("custom")).toBe(false);
    expect(KeyedLock.count).toBe(0);

    lock.release();
    expect(customMap.size).toBe(0);
    expect(lock.locked).toBe(false);
  });

  it("custom map serializes correctly", async () => {
    const customMap = new Map<string, KeyedLock>();
    const order: number[] = [];

    const task = async (id: number) => {
      const lock = await KeyedLock.acquire("k", customMap);
      order.push(id);
      await new Promise<void>((r) => {
        setTimeout(r, 5);
      });
      lock.release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(customMap.size).toBe(0);
  });

  it("frees default map memory when all locks released", async () => {
    const lock1 = await KeyedLock.acquire("mem1");
    const lock2 = await KeyedLock.acquire("mem2");
    expect(KeyedLock.count).toBe(2);

    lock1.release();
    expect(KeyedLock.count).toBe(1);

    lock2.release();
    expect(KeyedLock.count).toBe(0);
  });

  it("instance acquire/release flow", async () => {
    const lock = new KeyedLock("instance");
    expect(lock.ownsLock).toBe(false);
    expect(lock.locked).toBe(false);
    expect(lock.promise).toBeUndefined();
    expect(lock.key).toBe("instance");

    await lock.acquire();
    expect(lock.ownsLock).toBe(true);
    expect(lock.locked).toBe(true);
    expect(lock.promise).toBeInstanceOf(Promise);
    expect(KeyedLock.isLocked("instance")).toBe(true);

    lock.release();
    expect(lock.ownsLock).toBe(false);
    expect(lock.locked).toBe(false);
    expect(lock.promise).toBeUndefined();
    expect(KeyedLock.isLocked("instance")).toBe(false);
  });

  it("throws on double acquire without release", async () => {
    const lock = await KeyedLock.acquire("double");
    await expect(lock.acquire()).rejects.toThrow("already acquired");
    lock.release();
  });

  it("can re-acquire after release", async () => {
    const lock = new KeyedLock("reuse");
    await lock.acquire();
    lock.release();
    await lock.acquire();
    expect(lock.ownsLock).toBe(true);
    lock.release();
    expect(KeyedLock.count).toBe(0);
  });

  it("acquire-release-acquire-release cycle", async () => {
    const lock = new KeyedLock("cycle");

    await lock.acquire();
    expect(lock.ownsLock).toBe(true);
    expect(lock.locked).toBe(true);
    expect(lock.release()).toBe(true);
    expect(lock.ownsLock).toBe(false);
    expect(lock.locked).toBe(false);

    await lock.acquire();
    expect(lock.ownsLock).toBe(true);
    expect(lock.locked).toBe(true);
    expect(lock.release()).toBe(true);
    expect(lock.ownsLock).toBe(false);
    expect(lock.locked).toBe(false);

    expect(KeyedLock.count).toBe(0);
  });

  it("locked reflects other holders", async () => {
    const lock1 = new KeyedLock("same-key");
    const lock2 = new KeyedLock("same-key");

    await lock1.acquire();
    expect(lock1.ownsLock).toBe(true);
    expect(lock1.locked).toBe(true);
    // lock2 doesn't own it, but the key is locked
    expect(lock2.ownsLock).toBe(false);
    expect(lock2.locked).toBe(true);

    lock1.release();
    expect(lock2.locked).toBe(false);
  });

  it("promise is undefined when not acquired", () => {
    const lock = new KeyedLock("lazy");
    expect(lock.promise).toBeUndefined();
    expect(lock.ownsLock).toBe(false);
  });

  it("promise resolves when released", async () => {
    const lock = await KeyedLock.acquire("promise-test");
    const p = lock.promise;
    expect(p).toBeInstanceOf(Promise);

    let resolved = false;
    p?.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    lock.release();
    await p;
    expect(resolved).toBe(true);
    expect(lock.promise).toBeUndefined();
  });

  describe("stress", () => {
    it("handles many concurrent acquires on the same key", async () => {
      let counter = 0;
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const task = async () => {
        await using _lock = await KeyedLock.acquire("stress");
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) {
          maxConcurrent = currentConcurrent;
        }
        counter++;
        await new Promise<void>((r) => {
          setTimeout(r, 0);
        });
        currentConcurrent--;
      };

      const tasks = Array.from({ length: 50 }, () => task());
      await Promise.all(tasks);

      expect(counter).toBe(50);
      expect(maxConcurrent).toBe(1);
      expect(KeyedLock.count).toBe(0);
    });
  });
});
