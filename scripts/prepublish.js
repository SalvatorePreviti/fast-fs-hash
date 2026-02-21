#!/usr/bin/env node

/**
 * Injects optionalDependencies into packages/fast-fs-hash/package.json.
 *
 * Run this in CI just before `npm publish`. The optionalDependencies point
 * to the 9 platform-specific native-binding packages (@fast-fs-hash/<platform>).
 *
 * These are NOT stored in source because:
 *   - They don't exist on npm during local development
 *   - npm workspaces would try (and fail) to install them locally
 *
 * This script ALWAYS writes (it's only called in the publish job).
 */

import fs from "node:fs";
import path from "node:path";
import { elapsed, formatJson, getPlatforms, logInfo, logOk, PKG_DIR, ROOT_DIR, readRootVersion } from "./lib/utils.js";

const t0 = performance.now();
const version = readRootVersion();

logInfo(`Injecting optionalDependencies (version ${version})`);

const mainPkgPath = path.resolve(PKG_DIR, "package.json");
const mainPkg = JSON.parse(fs.readFileSync(mainPkgPath, "utf8"));

const optDeps = {};
for (const platform of getPlatforms()) {
  optDeps[`@fast-fs-hash/${platform}`] = version;
}
mainPkg.optionalDependencies = optDeps;

fs.writeFileSync(mainPkgPath, formatJson(mainPkgPath, mainPkg), "utf8");

logOk(
  `${path.relative(ROOT_DIR, mainPkgPath)} — ${Object.keys(optDeps).length} platform packages injected (${elapsed(t0)})`
);
