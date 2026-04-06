#!/usr/bin/env node

/**
 * Syncs versions and metadata across all publishable packages.
 *
 * Source of truth: root package.json.
 *
 * Synced fields:
 *   - version, homepage, bugs, engines, repository
 *
 * Updates:
 *   - packages/fast-fs-hash/package.json
 *   - npm/<platform>/package.json
 *
 * Only writes files that actually changed.
 * In CI: throws if any file is out of date (never writes).
 *
 * Note: optionalDependencies are NOT stored in source. They are injected
 * at publish time by scripts/prepublish.js.
 */

import fs from "node:fs";
import path from "node:path";
import { elapsed, getPlatforms, logInfo, logOk, NPM_DIR, PKG_DIR, ROOT_DIR, SyncTracker } from "./lib/utils.js";

const t0 = performance.now();

const rootPkg = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, "package.json"), "utf8"));
const version = rootPkg.version;
const { homepage, bugs, engines, repository } = rootPkg;

logInfo(`Version: ${version}`);

/** Apply synced fields to a package.json object. */
function syncFields(pkg) {
  pkg.version = version;
  if (homepage) {
    pkg.homepage = homepage;
  }
  if (bugs) {
    pkg.bugs = bugs;
  }
  if (engines) {
    pkg.engines = engines;
  }
  if (repository) {
    // Preserve existing directory field (e.g. workspace packages)
    const existingDir = pkg.repository?.directory;
    pkg.repository = { ...repository };
    if (existingDir) {
      pkg.repository.directory = existingDir;
    }
  }
}

const sync = new SyncTracker();
sync.quiet = process.env.CI !== "true"; // Only log summary, not every single file check
const platforms = getPlatforms();

//  - Update packages/fast-fs-hash/package.json
const mainPkgPath = path.resolve(PKG_DIR, "package.json");
const mainPkg = JSON.parse(fs.readFileSync(mainPkgPath, "utf8"));
syncFields(mainPkg);
sync.syncJson(mainPkgPath, mainPkg);

//  - Update npm/<platform>/package.json
for (const platform of platforms) {
  const pkgPath = path.resolve(NPM_DIR, platform, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  syncFields(pkg);
  sync.syncJson(pkgPath, pkg);
}

sync.logSummary();
sync.throwIfOutOfDate("Package versions are out of date. Run `npm run build` locally and commit the result.");

logOk(`Versions synced (${elapsed(t0)})`);
