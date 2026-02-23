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
 *   trim-race: repeatedly trims idle pool threads, waits for self-termination,
 *              then submits fresh work. Used to catch the race where new work
 *              could be stranded while the last idle thread detaches.
 */

import { digestFile, FileHashCache, threadPoolTrim } from "fast-fs-hash";

const args = JSON.parse(process.argv[2]);

if (args.mode === "lock-and-hang") {
  const cache = new FileHashCache({
    cachePath: args.cachePath,
    files: args.files,
    rootPath: args.rootPath,
    version: 1,
  });
  const session = await cache.open();
  process.send({ acquired: true, disposed: session.disposed });

  // Listen for parent's "release" command to gracefully close the cache
  process.on("message", async (msg) => {
    if (msg === "release") {
      session.close();
      process.send({ released: true });
    }
  });

  // Hang forever — parent will either send "release" or kill us.
  setTimeout(() => {}, 2147483647);
}

if (args.mode === "trim-race") {
  const iterations = args.iterations ?? 200;
  const pauseMs = args.pauseMs ?? 5;
  const waveSize = args.waveSize ?? 3;
  const expectedHex = (await digestFile(args.filePath)).toString("hex");

  for (let i = 0; i < iterations; i++) {
    threadPoolTrim();
    await new Promise((resolve) => setTimeout(resolve, pauseMs));

    const digests = await Promise.all(
      Array.from({ length: waveSize }, () => digestFile(args.filePath).then((buf) => buf.toString("hex")))
    );

    for (const digest of digests) {
      if (digest !== expectedHex) {
        throw new Error(`trim-race digest mismatch at iteration ${i}`);
      }
    }
  }

  process.send({ ok: true, iterations });
}
