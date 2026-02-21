/**
 * Worker Thread helper for worker-threads.test.ts.
 *
 * Plain .mjs file so Node.js Worker Threads can load it directly
 * without any TypeScript transform. Imports from the built dist
 * (fast-fs-hash package via workspace resolution).
 */

import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { XXHash128 } from "fast-fs-hash";

await XXHash128.init();

if (workerData.mode === "basic") {
  // Test 1: In-memory hash
  const h1 = new XXHash128();
  h1.update(Buffer.from("hello world"));
  const hashHex = h1.digest().toString("hex");

  // Test 2: File hash
  const h2 = new XXHash128();
  const filePath = path.join(workerData.fixturesDir, "a.txt");
  await h2.updateFile(filePath);
  const fileHashHex = h2.digest().toString("hex");

  parentPort.postMessage({
    hashHex,
    fileHashHex,
    libraryStatus: h1.libraryStatus,
  });
} else if (workerData.mode === "bulk") {
  const h = new XXHash128();
  const filePath = path.join(workerData.fixturesDir, "a.txt");
  const files = Array.from({ length: workerData.fileCount }, () => filePath);
  await h.updateFilesBulk(files);
  const hex = h.digest().toString("hex");

  parentPort.postMessage({ hex });
}
