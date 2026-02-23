/**
 * Package native bindings into platform-specific npm packages.
 * Run in CI after downloading artifacts and before publish.
 *
 * 1. Discovers platform packages by checking for "os" field in npm/<dir>/package.json
 * 2. Copies each artifact -> npm/{target}/fast_fs_hash.node
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

/**
 * Strip the "fast-fs-hash-node-" prefix from a folder name to recover
 * the CI build target (e.g. "fast-fs-hash-node-linux-x64-musl" → "linux-x64-musl").
 */
function toArtifactTarget(folderName) {
  return folderName.replace(/^fast-fs-hash-node-/, "");
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

  const artifactTarget = toArtifactTarget(target);
  const artifactDir = path.join(ARTIFACTS_DIR, `binding-${artifactTarget}`);
  const baselineSrc = path.join(artifactDir, "fast_fs_hash.node");

  if (!existsSync(baselineSrc)) {
    missing.push(target);
    logError(`${target}: artifact not found`);
    continue;
  }

  // Copy baseline binary
  const baselineDest = path.join(NPM_DIR, target, "fast_fs_hash.node");
  cpSync(baselineSrc, baselineDest);
  const { size } = statSync(baselineDest);
  const kb = (size / 1024).toFixed(1);
  logOk(`${target}/fast_fs_hash.node (${kb} KB)`);

  // Copy x64 ISA variants — required if listed in package.json "files"
  const declaredFiles = pkg.files || [];
  for (const suffix of ["_avx2", "_avx512"]) {
    const filename = `fast_fs_hash${suffix}.node`;
    const variantSrc = path.join(artifactDir, filename);
    const variantDest = path.join(NPM_DIR, target, filename);
    const declared = declaredFiles.includes(filename);

    if (existsSync(variantSrc)) {
      cpSync(variantSrc, variantDest);
      const vs = statSync(variantDest);
      const vkb = (vs.size / 1024).toFixed(1);
      logOk(`${target}/${filename} (${vkb} KB)`);
    } else if (declared) {
      missing.push(`${target}/${filename}`);
      logError(`${target}: ${filename} declared in package.json but artifact not found`);
    }
  }

  copied++;
}

logInfo(`${copied} of ${copied + missing.length} platform binaries packaged`);

if (missing.length > 0 && isCI) {
  throw new Error(`${missing.length} platform binaries missing — aborting publish!\n  Missing: ${missing.join(", ")}`);
}

logOk(`Package platforms completed (${elapsed(t0)})`);
