/**
 * Child Process helper for locking tests.
 *
 * Plain .mjs file so Node.js child_process.fork() can load it directly
 * without any TypeScript transform.
 *
 * Modes:
 *   lock-and-hang: opens a cache (acquiring exclusive lock), sends { acquired: true }, then hangs.
 *                  Parent kills the process to release the lock.
 */

import { FileHashCache } from "fast-fs-hash";

const args = JSON.parse(process.argv[2]);

if (args.mode === "lock-and-hang") {
  const cache = await FileHashCache.open(args.cachePath, args.rootPath, args.files, 1);
  process.send({ acquired: true, disposed: cache.disposed });
  // Hang forever — parent will kill us. setTimeout avoids Node's unsettled-await warning.
  setTimeout(() => {}, 2147483647);
}
