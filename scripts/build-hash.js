#!/usr/bin/env node

/**
 * Generates build-hash.json with SHA-256 hashes, sizes and line counts of:
 *   - JS/TS build artifacts (dist/)
 *   - Source code in 3 categories: ts, native (C++), cmake (xxHash dependency)
 *   - package.json dependency/security info
 *
 * Uses glob to discover files dynamically — no hardcoded file lists.
 * Runs automatically at the end of `npm run build`.
 * The file is committed to the repo for supply-chain verification.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const PKG_DIR = path.resolve(ROOT_DIR, "packages/fast-fs-hash");
const SRC_DIR = path.resolve(PKG_DIR, "src");
const DIST_DIR = path.resolve(PKG_DIR, "dist");
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
      const content = await fs.promises.readFile(absPath);
      const entry = {
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      };
      if (!BINARY_EXTENSIONS.has(path.extname(relPath))) {
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
      console.log(`    ${relPath}: missing`);
    } else if (!prev) {
      console.log(`    ${relPath}: new${info}`);
    } else if (cur.sha256 !== prev.sha256) {
      console.log(`    ${relPath}: modified${info}`);
    } else {
      console.log(`    ${relPath}: unchanged${info}`);
    }
  }
}

export async function writeBuildHash() {
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

  const nextText = `${JSON.stringify(obj, null, 2)}\n`;

  let existing = "";
  try {
    existing = await fs.promises.readFile(BUILD_HASH_PATH, "utf8");
  } catch {}

  // Compare ignoring the generatedAt timestamp
  let changed = false;
  let prev = null;
  try {
    prev = JSON.parse(existing);
    changed =
      JSON.stringify(prev.distArtifacts) !== JSON.stringify(obj.distArtifacts) ||
      JSON.stringify(prev.source) !== JSON.stringify(obj.source) ||
      JSON.stringify(prev.packageSecurity) !== JSON.stringify(obj.packageSecurity);
  } catch {
    changed = true;
  }

  if (changed) {
    await fs.promises.writeFile(BUILD_HASH_PATH, nextText, "utf8");
    console.log("  build-hash.json updated");
  } else {
    console.log("  build-hash.json is up to date");
  }

  logFileDiffs("dist artifacts", distFiles, prev?.distArtifacts);
}
