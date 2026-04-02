/**
 * Child Process helper for locking tests.
 *
 * Plain .mjs file so Node.js child_process.fork() can load it directly
 * without any TypeScript transform.
 *
 * Modes:
 *   lock-and-hang: opens a cache (acquiring exclusive lock), sends { acquired: true },
 *                  then waits for a "release" message from the parent to close/dispose
 *                  the cache and send { released: true }. If no release message arrives,
 *                  the process hangs until killed — the OS releases the lock on exit.
 */

import { FileHashCache } from "fast-fs-hash";

const args = JSON.parse(process.argv[2]);

if (args.mode === "lock-and-hang") {
  const cache = await FileHashCache.open(args.cachePath, args.rootPath, args.files, 1);
  process.send({ acquired: true, disposed: cache.disposed });

  // Listen for parent's "release" command to gracefully close the cache
  process.on("message", async (msg) => {
    if (msg === "release") {
      await cache[Symbol.asyncDispose]();
      process.send({ released: true });
    }
  });

  // Hang forever — parent will either send "release" or kill us.
  setTimeout(() => {}, 2147483647);
}
