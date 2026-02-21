#!/usr/bin/env node

/**
 * Syncs versions across all publishable packages.
 *
 * Source of truth: root package.json "version" field.
 *
 * Updates:
 *   - packages/fast-fs-hash/package.json  (version)
 *   - npm/<platform>/package.json         (version)
 *
 * Only writes files that actually changed.
 * In CI: throws if any file is out of date (never writes).
 *
 * Note: optionalDependencies are NOT stored in source. They are injected
 * at publish time by scripts/prepublish.js.
 */

import fs from "node:fs";
import path from "node:path";
import { elapsed, getPlatforms, logInfo, logOk, NPM_DIR, PKG_DIR, readRootVersion, SyncTracker } from "./lib/utils.js";

const t0 = performance.now();
const version = readRootVersion();

logInfo(`Version: ${version}`);

const sync = new SyncTracker();
sync.quiet = process.env.CI !== "true"; // Only log summary, not every single file check
const platforms = getPlatforms();

// ── Update packages/fast-fs-hash/package.json ────────────────────────────
const mainPkgPath = path.resolve(PKG_DIR, "package.json");
const mainPkg = JSON.parse(fs.readFileSync(mainPkgPath, "utf8"));
mainPkg.version = version;
sync.syncJson(mainPkgPath, mainPkg);

// ── Update npm/<platform>/package.json ───────────────────────────────────
for (const platform of platforms) {
  const pkgPath = path.resolve(NPM_DIR, platform, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  sync.syncJson(pkgPath, pkg);
}

sync.logSummary();
sync.throwIfOutOfDate("Package versions are out of date. Run `npm run build` locally and commit the result.");

logOk(`Versions synced (${elapsed(t0)})`);
