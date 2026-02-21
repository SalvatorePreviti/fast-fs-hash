#!/usr/bin/env node

/**
 * Syncs shared files (README.md, LICENSE, NOTICES.md) from the repo root
 * into every publishable package directory:
 *   - packages/fast-fs-hash/
 *   - npm/<platform>/  (9 platform packages)
 *
 * In CI: throws if any file is out of date (never writes).
 */

import fs from "node:fs";
import path from "node:path";
import { elapsed, getPublishDirs, logInfo, logOk, ROOT_DIR, SyncTracker } from "./lib/utils.js";

const t0 = performance.now();
const SHARED_FILES = ["README.md", "LICENSE", "NOTICES.md"];

/** Notice prepended to README.md in platform-specific binary packages. */
function platformReadmeNotice(pkgName) {
  return [
    `> **⚠️ This is a platform-specific binary package.**`,
    `>`,
    `> You should not install \`${pkgName}\` directly.`,
    `> Instead, install the main package which will automatically select the correct binary for your platform:`,
    `>`,
    `> \`\`\`sh`,
    `> npm install fast-fs-hash`,
    `> \`\`\``,
    `>`,
    `> See [fast-fs-hash on npm](https://www.npmjs.com/package/fast-fs-hash) for documentation.`,
    "",
    "---",
    "",
  ].join("\n");
}

const sync = new SyncTracker();
sync.quiet = process.env.CI !== "true";
const destDirs = getPublishDirs();

logInfo(`Syncing ${SHARED_FILES.join(", ")} → ${destDirs.length} packages`);

const readmeContent = fs.readFileSync(path.resolve(ROOT_DIR, "README.md"), "utf8");

for (const file of SHARED_FILES) {
  if (file === "README.md") {
    // Main package gets the plain README
    sync.syncFile(path.resolve(destDirs[0], file), readmeContent);
    // Platform packages get the notice prepended
    for (const dir of destDirs.slice(1)) {
      const pkgName = `@fast-fs-hash/${path.basename(dir)}`;
      sync.syncFile(path.resolve(dir, file), platformReadmeNotice(pkgName) + readmeContent);
    }
  } else {
    const content = fs.readFileSync(path.resolve(ROOT_DIR, file), "utf8");
    for (const dir of destDirs) {
      sync.syncFile(path.resolve(dir, file), content);
    }
  }
}

sync.throwIfOutOfDate("Shared files are out of date. Run `npm run build` locally and commit the result.");

logOk(`Shared files synced (${elapsed(t0)})`);
