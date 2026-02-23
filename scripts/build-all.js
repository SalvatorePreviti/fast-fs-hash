#!/usr/bin/env node

/**
 * Builds everything in parallel: native C++ addon + JS/TS bundles.
 * Native is built in release mode by default.
 *
 * Usage:
 *   node scripts/build-all.js           # release native + TS
 *   node scripts/build-all.js --debug   # debug native + TS
 */

import { writeBuildHash } from "./build-hash.js";
import { elapsed, logError, logTitle, runScript } from "./lib/utils.js";

const debug = process.argv.includes("--debug");
const nativeArgs = debug ? ["--debug"] : ["--release"];

const t0 = performance.now();

const results = await Promise.allSettled([runScript("build-native.js", nativeArgs), runScript("build-ts.js")]);

const failures = results.filter((r) => r.status === "rejected");
if (failures.length > 0) {
  for (const f of failures) {
    logError(f.reason?.message ?? f.reason);
  }
  logError(`Build failed after ${elapsed(t0)}`);
  process.exit(1);
}

await writeBuildHash();

await Promise.all([runScript("build-readme.js"), runScript("update-versions.js")]);

logTitle(`All builds completed in ${elapsed(t0)}`);
