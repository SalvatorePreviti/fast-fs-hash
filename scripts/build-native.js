#!/usr/bin/env node

/**
 * Builds the native C++ addon via cmake-js.
 * Defaults to release mode.
 *
 * Usage:
 *   node scripts/build-native.js           # release build
 *   node scripts/build-native.js --debug   # debug build
 *
 * The output goes to packages/fast-fs-hash/build/ so that the native
 * loader (native.ts) can find it at ../build/Release/fast_fs_hash.node
 * from both src/ and dist/.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { logInfo, logOk, PKG_DIR, ROOT_DIR } from "./lib/utils.js";

const OUT_DIR = path.resolve(PKG_DIR, "build");

const isDebug = process.argv.includes("--debug");

const args = ["compile", "--out", OUT_DIR];

if (!isDebug) {
  args.push("--release");
}

// Pass through any --arch flag (for cross-compilation)
const archIdx = process.argv.indexOf("--arch");
if (archIdx !== -1 && process.argv[archIdx + 1]) {
  args.push("--arch", process.argv[archIdx + 1]);
}

const cmakeJs = path.resolve(ROOT_DIR, "node_modules/.bin/cmake-js");

logInfo(`Building native addon (${isDebug ? "debug" : "release"})...`);

execFileSync(cmakeJs, args, {
  cwd: ROOT_DIR,
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

// Print binary sizes (baseline + x64 variants)
const releaseDir = path.resolve(OUT_DIR, "Release");
try {
  for (const f of readdirSync(releaseDir)) {
    if (f.startsWith("fast_fs_hash") && f.endsWith(".node")) {
      const { size } = statSync(path.resolve(releaseDir, f));
      const kb = (size / 1024).toFixed(1);
      logOk(`${f}: ${kb} KB (${size} bytes)`);
    }
  }
} catch {
  // cross-compile or missing — skip
}
