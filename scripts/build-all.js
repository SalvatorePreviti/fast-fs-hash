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
import { DIST_DIR, elapsed, logError, logOk, logTitle, ROOT_DIR, runScript } from "./lib/utils.js";

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

// Cross-check and smoke test require the native addon, so skip them during cross-compilation
// (e.g. building arm64 .node under QEMU on an x86_64 host).
const canLoadNative = await (async () => {
  try {
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const cjsRequire = createRequire(import.meta.url);
    cjsRequire(resolve(DIST_DIR, "index.cjs"));
    return true;
  } catch {
    return false;
  }
})();

if (canLoadNative) {
  // Cross-check: verify all CJS exports appear in the ESM wrapper
  {
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cjsRequire = createRequire(import.meta.url);
    const cjsMod = cjsRequire(resolve(DIST_DIR, "index.cjs"));
    const cjsKeys = Object.keys(cjsMod).filter((k) => k !== "default" && k !== "__esModule");
    const esmSrc = readFileSync(resolve(DIST_DIR, "index.mjs"), "utf8");
    const missing = cjsKeys.filter((k) => !esmSrc.includes(k));
    if (missing.length > 0) {
      logError(`ESM wrapper is missing exports from CJS bundle: ${missing.join(", ")}`);
      process.exit(1);
    }
    logOk(`ESM/CJS export cross-check passed (${cjsKeys.length} exports)`);
  }

  // Smoke test: exercise the built dist end-to-end
  {
    const s = performance.now();
    const { fork } = await import("node:child_process");
    const { resolve } = await import("node:path");
    const smokeTest = resolve(ROOT_DIR, "test/smoke-test/smoke-test.mjs");
    const modulePath = resolve(DIST_DIR, "index.mjs");
    await new Promise((res, rej) => {
      const child = fork(smokeTest, [], {
        stdio: "inherit",
        env: { ...process.env, FAST_FS_HASH_MODULE: modulePath, SMOKE_TEST_QUIET: "1" },
      });
      child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`Smoke test failed (exit code ${code})`))));
      child.on("error", rej);
    });
    logOk(`Smoke test (${elapsed(s)})`);
  }
} else {
  logOk("Cross-compilation detected — skipping ESM/CJS cross-check and smoke test");
}

await Promise.all([runScript("build-readme.js"), runScript("update-versions.js")]);

logTitle(`All builds completed in ${elapsed(t0)}`);
