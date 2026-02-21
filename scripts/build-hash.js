#!/usr/bin/env node

/**
 * Generates build-hash.json with SHA-256 hashes, sizes and line counts of:
 *   - JS/TS build artifacts (dist/)
 *   - Source code in 3 categories: ts, native (C++), cmake (xxHash dependency)
 *   - package.json dependency/security info
 *
 * Uses glob to discover files dynamically — no hardcoded file lists.
 * Runs automatically at the end of `npm run build:ts`.
 * The file is committed to the repo for supply-chain verification.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import {
  DIST_DIR,
  elapsed,
  formatJson,
  isCI,
  logChanged,
  logError,
  logInfo,
  logOk,
  PKG_DIR,
  ROOT_DIR,
  SRC_DIR,
  SyncTracker,
} from "./lib/utils.js";

const NATIVE_DIR = path.resolve(SRC_DIR, "native");
const XXHASH_SRC_DIR = path.resolve(ROOT_DIR, "deps/xxHash");
const BUILD_HASH_PATH = path.resolve(ROOT_DIR, "build-hash.json");

/** package.json dependency fields to track for supply-chain security. */
const PACKAGE_JSON_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/** package.json fields that are security-sensitive (install hooks, binary download config). */
const PACKAGE_JSON_DANGEROUS_FIELDS = ["scripts.install", "scripts.preinstall", "scripts.postinstall", "binary"];

/** Collect sorted relative paths matching a glob pattern under a base directory. */
async function findFiles(baseDir, pattern) {
  const results = [];
  for await (const entry of glob(pattern, { cwd: baseDir })) {
    results.push(entry);
  }
  return results.sort();
}

/** Extensions treated as binary (no line count). */
const BINARY_EXTENSIONS = new Set([".wasm", ".node"]);

/** Hash files and return { relPath: { sha256, bytes, lines? } } with sorted keys. */
async function hashFiles(baseDir, relPaths) {
  const result = {};
  for (const relPath of relPaths.sort()) {
    const absPath = path.resolve(baseDir, relPath);
    try {
      const raw = await fs.promises.readFile(absPath);
      const isBinary = BINARY_EXTENSIONS.has(path.extname(relPath));
      // Normalize CRLF → LF for text files so hashes are consistent across platforms
      const content = isBinary ? raw : Buffer.from(raw.toString("utf8").replaceAll("\r\n", "\n"));
      const entry = {
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      };
      if (!isBinary) {
        entry.lines = content.toString("utf8").split("\n").length;
      }
      result[relPath] = entry;
    } catch {
      result[relPath] = null;
    }
  }
  return result;
}

function readInstalledVersion(depName) {
  try {
    const pkgPath = path.resolve(ROOT_DIR, "node_modules", depName, "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || null;
  } catch {
    return null;
  }
}

function getNestedField(obj, dotPath) {
  let cur = obj;
  for (const part of dotPath.split(".")) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

function collectPackageJsonSecurity() {
  const pkgPath = path.resolve(PKG_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  const deps = {};
  for (const field of PACKAGE_JSON_DEP_FIELDS) {
    const entries = pkg[field];
    if (!entries || typeof entries !== "object") {
      continue;
    }
    for (const [name, declared] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
      const installed = readInstalledVersion(name);
      deps[name] = { declared, installed, field };
    }
  }

  const dangerousFields = {};
  for (const dotPath of PACKAGE_JSON_DANGEROUS_FIELDS) {
    const value = getNestedField(pkg, dotPath);
    if (value !== undefined) {
      dangerousFields[dotPath] = value;
    }
  }

  return { deps, dangerousFields };
}

/** Log per-file diff summary between previous and current hash maps */
function logFileDiffs(label, current, previous) {
  console.log(`  ${label} (${Object.keys(current).length} files):`);
  for (const relPath of Object.keys(current)) {
    const cur = current[relPath];
    const prev = previous?.[relPath];
    const info = cur ? ` (${cur.bytes} bytes${cur.lines != null ? `, ${cur.lines} lines` : ""})` : "";
    if (!cur) {
      logError(`${relPath}: missing`);
    } else if (!prev) {
      logChanged(`${relPath}: new${info}`);
    } else if (cur.sha256 !== prev.sha256) {
      const prevInfo = ` (was ${prev.bytes} bytes${prev.lines != null ? `, ${prev.lines} lines` : ""})`;
      logChanged(`${relPath}: hash changed${info}${prevInfo}`);
    } else if (cur.bytes !== prev.bytes) {
      logChanged(`${relPath}: size changed${info} (was ${prev.bytes} bytes)`);
    } else {
      logOk(`${relPath}${info}`);
    }
  }
  // Files that were removed
  if (previous) {
    for (const relPath of Object.keys(previous)) {
      if (!(relPath in current)) {
        logError(`${relPath}: removed`);
      }
    }
  }
}

/** Compare two hash-map sections and return a list of human-readable change descriptions. */
function diffHashMaps(label, current, previous) {
  const diffs = [];
  if (!previous) {
    diffs.push(`${label}: no previous data (new or corrupted build-hash.json)`);
    return diffs;
  }
  for (const relPath of Object.keys(current)) {
    const cur = current[relPath];
    const prev = previous[relPath];
    if (!cur) {
      diffs.push(`${label}/${relPath}: missing on disk`);
    } else if (!prev) {
      diffs.push(`${label}/${relPath}: new file (${cur.bytes} bytes)`);
    } else if (cur.sha256 !== prev.sha256) {
      diffs.push(
        `${label}/${relPath}: hash differs — ` +
          `expected ${prev.sha256.slice(0, 16)}… (${prev.bytes}B), ` +
          `got ${cur.sha256.slice(0, 16)}… (${cur.bytes}B)`
      );
    } else if (cur.bytes !== prev.bytes) {
      diffs.push(`${label}/${relPath}: size differs — expected ${prev.bytes}B, got ${cur.bytes}B`);
    } else if (cur.lines !== prev.lines) {
      diffs.push(`${label}/${relPath}: line count differs — expected ${prev.lines}, got ${cur.lines}`);
    }
  }
  for (const relPath of Object.keys(previous)) {
    if (!(relPath in current)) {
      diffs.push(`${label}/${relPath}: file removed`);
    }
  }
  return diffs;
}

export async function writeBuildHash() {
  const t0 = performance.now();

  // Discover files via glob
  const [distPaths, tsPaths, nativePaths, xxhashPaths, cmakePaths] = await Promise.all([
    findFiles(DIST_DIR, "*.{cjs,mjs,d.ts,d.cts,wasm}"),
    findFiles(SRC_DIR, "**/*.{ts,wasm}").then((ps) => ps.filter((p) => !p.startsWith("native/"))),
    findFiles(NATIVE_DIR, "*.{cpp,h}"),
    findFiles(XXHASH_SRC_DIR, "*.{c,h}"),
    findFiles(ROOT_DIR, "CMakeLists.txt"),
  ]);

  // Hash all categories in parallel
  const [distFiles, tsFiles, nativeFiles, xxhashFiles, cmakeFiles] = await Promise.all([
    hashFiles(DIST_DIR, distPaths),
    hashFiles(SRC_DIR, tsPaths),
    hashFiles(NATIVE_DIR, nativePaths),
    hashFiles(XXHASH_SRC_DIR, xxhashPaths),
    hashFiles(ROOT_DIR, cmakePaths),
  ]);

  const { deps, dangerousFields } = collectPackageJsonSecurity();

  const totalSourceFiles =
    Object.keys(tsFiles).length +
    Object.keys(nativeFiles).length +
    Object.keys(xxhashFiles).length +
    Object.keys(cmakeFiles).length;

  const obj = {
    _description: "SHA-256 hashes of build artifacts and source code. Regenerated on every build.",
    generatedAt: new Date().toISOString(),
    distArtifacts: distFiles,
    source: {
      _description: "Source files by category. Discovered via glob, sorted alphabetically.",
      files: totalSourceFiles,
      ts: tsFiles,
      native: nativeFiles,
      xxhash: xxhashFiles,
      cmake: cmakeFiles,
    },
    packageSecurity: {
      _description:
        "Resolved dependency versions and security-sensitive package.json fields, for supply-chain verification.",
      dependencies: deps,
      dangerousFields,
    },
  };

  const nextText = formatJson(BUILD_HASH_PATH, obj);

  let existing = "";
  try {
    existing = await fs.promises.readFile(BUILD_HASH_PATH, "utf8");
  } catch {}

  // Compare ignoring the generatedAt timestamp
  let changed = false;
  let prev = null;
  let parseError = false;
  try {
    prev = JSON.parse(existing);
    changed =
      JSON.stringify(prev.distArtifacts) !== JSON.stringify(obj.distArtifacts) ||
      JSON.stringify(prev.source) !== JSON.stringify(obj.source) ||
      JSON.stringify(prev.packageSecurity) !== JSON.stringify(obj.packageSecurity);
  } catch {
    changed = true;
    parseError = !existing ? "file not found" : "JSON parse error";
  }

  const sync = new SyncTracker();

  if (changed) {
    // Print detailed diagnostics about what changed
    if (parseError) {
      logInfo(`build-hash.json: ${parseError}`);
    } else {
      const allDiffs = [
        ...diffHashMaps("distArtifacts", distFiles, prev?.distArtifacts),
        ...diffHashMaps("source/ts", tsFiles, prev?.source?.ts),
        ...diffHashMaps("source/native", nativeFiles, prev?.source?.native),
        ...diffHashMaps("source/xxhash", xxhashFiles, prev?.source?.xxhash),
        ...diffHashMaps("source/cmake", cmakeFiles, prev?.source?.cmake),
      ];

      // Check packageSecurity separately (not a hash map)
      if (JSON.stringify(obj.packageSecurity) !== JSON.stringify(prev?.packageSecurity)) {
        allDiffs.push("packageSecurity: dependency or security field diff");
      }

      if (allDiffs.length > 0) {
        logInfo(`build-hash.json changes (${allDiffs.length}):`);
        for (const diff of allDiffs) {
          logChanged(diff);
        }
      }
    }

    await sync.syncFileAsync(BUILD_HASH_PATH, nextText);
  } else {
    logOk("build-hash.json");
  }

  logFileDiffs("dist artifacts", distFiles, prev?.distArtifacts);

  sync.throwIfOutOfDate("build-hash.json is out of date. Run `npm run build` locally and commit the result.");

  logOk(`build-hash completed (${elapsed(t0)})`);
}
