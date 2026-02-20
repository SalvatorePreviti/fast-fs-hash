/**
 * Package native bindings into platform-specific npm packages.
 * Run after downloading CI artifacts.
 *
 * 1. Reads the version from packages/fast-fs-hash/package.json
 * 2. Copies each artifact → npm/{target}/fast_fs_hash.node
 * 3. Syncs the version into every npm/{target}/package.json
 *
 * Expected artifact layout:
 *   artifacts/binding-{target}/fast_fs_hash.node
 *
 * Output:
 *   npm/{target}/fast_fs_hash.node  (copied from artifacts)
 *   npm/{target}/package.json       (version synced)
 */

import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const ARTIFACTS_DIR = path.resolve(ROOT_DIR, "artifacts");
const NPM_DIR = path.resolve(ROOT_DIR, "npm");
const MAIN_PKG_PATH = path.resolve(ROOT_DIR, "packages/fast-fs-hash/package.json");

// ── Read authoritative version from the main package ─────────────────────

const mainPkg = JSON.parse(readFileSync(MAIN_PKG_PATH, "utf8"));
const version = mainPkg.version;
console.log(`Version from packages/fast-fs-hash/package.json: ${version}\n`);

// ── Sync version into ALL platform package.json (regardless of artifacts) ─

const ALL_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "freebsd-x64",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-x64-gnu",
  "linux-x64-musl",
  "win32-arm64-msvc",
  "win32-x64-msvc",
];

for (const target of ALL_TARGETS) {
  const pkgPath = path.join(NPM_DIR, target, "package.json");
  if (!existsSync(pkgPath)) {
    console.warn(`  WARN no package template at npm/${target}/package.json`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.version !== version) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`  SYNC ${target} → ${version}`);
  } else {
    console.log(`  OK   ${target} already at ${version}`);
  }
}

// ── Copy artifacts ───────────────────────────────────────────────────────

if (!existsSync(ARTIFACTS_DIR)) {
  console.error("\nNo artifacts directory found. Run this after downloading CI artifacts.");
  process.exit(1);
}

console.log("");

const entries = readdirSync(ARTIFACTS_DIR);
let count = 0;

for (const entry of entries) {
  const match = entry.match(/^binding-(.+)$/);
  if (!match) {
    continue;
  }

  const target = match[1];
  const src = path.join(ARTIFACTS_DIR, entry, "fast_fs_hash.node");
  const destDir = path.join(NPM_DIR, target);
  const dest = path.join(destDir, "fast_fs_hash.node");

  if (!existsSync(src)) {
    console.warn(`  SKIP ${target}: no .node file found`);
    continue;
  }

  if (!existsSync(destDir)) {
    console.warn(`  SKIP ${target}: no package template at npm/${target}/`);
    continue;
  }

  cpSync(src, dest);
  console.log(`  COPY ${target}/fast_fs_hash.node`);
  count++;
}

console.log(`\nPackaged ${count} platform bindings (all at version ${version}).`);
