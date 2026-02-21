/**
 * Package native bindings into platform-specific npm packages.
 * Run in CI after downloading artifacts and before publish.
 *
 * 1. Discovers platform packages by checking for "os" field in npm/<dir>/package.json
 * 2. Copies each artifact → npm/{target}/fast_fs_hash.node
 * 3. In CI: throws if any platform is missing its .node binary
 *
 * Expected artifact layout (from actions/download-artifact):
 *   artifacts/binding-{target}/fast_fs_hash.node
 */

import { cpSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  elapsed,
  getPlatforms,
  isCI,
  logError,
  logInfo,
  logOk,
  logTitle,
  NPM_DIR,
  ROOT_DIR,
  readJson,
} from "./lib/utils.js";

const t0 = performance.now();
const ARTIFACTS_DIR = path.resolve(ROOT_DIR, "artifacts");

if (!existsSync(ARTIFACTS_DIR)) {
  logError("No artifacts directory found. Run this after downloading CI artifacts.");
  process.exit(1);
}

logTitle("Packaging platform binaries");

const platforms = getPlatforms();
let copied = 0;
const missing = [];

for (const target of platforms) {
  const pkgPath = path.resolve(NPM_DIR, target, "package.json");
  const pkg = readJson(pkgPath);

  // Only process platform-specific packages (those with an "os" field)
  if (!pkg.os) {
    continue;
  }

  const src = path.join(ARTIFACTS_DIR, `binding-${target}`, "fast_fs_hash.node");
  const dest = path.join(NPM_DIR, target, "fast_fs_hash.node");

  if (!existsSync(src)) {
    missing.push(target);
    logError(`${target}: artifact not found`);
    continue;
  }

  cpSync(src, dest);
  const { size } = statSync(dest);
  const kb = (size / 1024).toFixed(1);
  logOk(`${target}/fast_fs_hash.node (${kb} KB)`);
  copied++;
}

logInfo(`${copied} of ${copied + missing.length} platform binaries packaged`);

if (missing.length > 0 && isCI) {
  throw new Error(`${missing.length} platform binaries missing — aborting publish!\n  Missing: ${missing.join(", ")}`);
}

logOk(`Package platforms completed (${elapsed(t0)})`);
