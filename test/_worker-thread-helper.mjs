/**
 * Worker Thread helper for worker-threads.test.ts.
 *
 * Plain .mjs file so Node.js Worker Threads can load it directly
 * without any TypeScript transform. Imports from the built dist
 * (fast-fs-hash package via workspace resolution).
 *
 * Guarded by isMainThread — does nothing when imported outside a Worker.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";

if (!isMainThread && parentPort && workerData) {
  const path = await import("node:path");
  const { digestFilesParallel, FileHashCache, XxHash128Stream } = await import("fast-fs-hash");

  if (workerData.mode === "basic") {
    const h1 = new XxHash128Stream();
    h1.addBuffer(Buffer.from("hello world"));
    const hashHex = h1.digest().toString("hex");

    const h2 = new XxHash128Stream();
    const filePath = path.join(workerData.fixturesDir, "a.txt");
    await h2.addFile(filePath);
    const fileHashHex = h2.digest().toString("hex");

    parentPort.postMessage({ hashHex, fileHashHex });
  } else if (workerData.mode === "lock-and-hang") {
    const cache = await FileHashCache.open(workerData.cachePath, workerData.rootPath, workerData.files, 1);
    parentPort.postMessage({ acquired: true, disposed: cache.disposed });
    // Hang forever — parent will terminate() us. setTimeout avoids vitest's unsettled-await warning.
    setTimeout(() => {}, 2147483647);
  } else if (workerData.mode === "bulk") {
    const filePath = path.join(workerData.fixturesDir, "a.txt");
    const files = Array.from({ length: workerData.fileCount }, () => filePath);
    const aggregate = await digestFilesParallel(files);
    parentPort.postMessage({ hex: aggregate.toString("hex") });
  }
}
