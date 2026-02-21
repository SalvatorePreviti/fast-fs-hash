/**
 * Shared utilities for build scripts.
 *
 * Provides:
 *   - Colored logging with icons (via ansis)
 *   - File sync helpers (compare, write-if-changed, CI verification)
 *   - Common paths and constants
 *   - JSON read/write helpers
 *   - Script runner (fork-based)
 *   - Version reader (root package.json)
 */

import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ansis from "ansis";

// ── Paths ────────────────────────────────────────────────────────────────

export const ROOT_DIR = path.resolve(import.meta.dirname, "../..");
export const SCRIPTS_DIR = path.resolve(ROOT_DIR, "scripts");
export const PKG_DIR = path.resolve(ROOT_DIR, "packages/fast-fs-hash");
export const NPM_DIR = path.resolve(ROOT_DIR, "npm");
export const SRC_DIR = path.resolve(PKG_DIR, "src");
export const DIST_DIR = path.resolve(PKG_DIR, "dist");

export const isCI = !!process.env.CI;

// ── Logging ──────────────────────────────────────────────────────────────

/** Log an unchanged/up-to-date item. */
export function logOk(msg) {
  console.info(ansis.green(`  ✔ ${msg}`));
}

/** Log a changed/updated item. */
export function logChanged(msg) {
  console.warn(ansis.yellow(`  ⚠ ${msg}`));
}

/** Log an error/out-of-date item. */
export function logError(msg) {
  console.error(ansis.red(`  ✖ ${msg}`));
}

/** Log a neutral info line. */
export function logInfo(msg) {
  console.info(ansis.cyan(`  ℹ ${msg}`));
}

/** Log a bold section title. */
export function logTitle(msg) {
  console.log(ansis.bold(`\n${msg}`));
}

// ── JSON helpers ─────────────────────────────────────────────────────────

/** Read and parse a JSON file. */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** Write an object as pretty JSON (2-space indent + trailing newline). */
export function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, formatJson(filePath, obj), "utf8");
}

const _biomeBin = path.resolve(ROOT_DIR, "node_modules/.bin/biome");

/**
 * Serialize an object to JSON and format it through biome.
 * Uses biome's stdin mode with --stdin-file-path so it picks up the project's
 * biome.json config (indentStyle, lineWidth, lineEnding, etc.).
 * @param {string} filePath Absolute path (used for biome config lookup, file is NOT read/written).
 * @param {unknown} obj The value to serialize.
 * @returns {string} Formatted JSON string (with trailing newline).
 */
export function formatJson(filePath, obj) {
  const raw = `${JSON.stringify(obj, null, 2)}\n`;
  try {
    return execFileSync(_biomeBin, ["format", "--stdin-file-path", filePath], {
      input: raw,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT_DIR,
      shell: process.platform === "win32",
    });
  } catch {
    // Fallback: if biome isn't available, return raw JSON
    return raw;
  }
}

// ── Version helper ───────────────────────────────────────────────────────

/** Read the version from root package.json (single source of truth). */
export function readRootVersion() {
  const { version } = readJson(path.resolve(ROOT_DIR, "package.json"));
  if (!version) {
    throw new Error("Root package.json is missing a version field");
  }
  return version;
}

// ── Script runner ────────────────────────────────────────────────────────

/** Run a build script in a child process via fork(), returning a promise. */
export function runScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = fork(path.resolve(SCRIPTS_DIR, script), args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

// ── Timing helper ────────────────────────────────────────────────────────

/** Format elapsed time since t0 (from performance.now()) as "X.XXs". */
export function elapsed(t0) {
  return `${((performance.now() - t0) / 1000).toFixed(2)}s`;
}

// ── File sync helpers ────────────────────────────────────────────────────

/**
 * Tracks file sync state across multiple operations, then throws if any
 * files were out of date in CI.
 */
export class SyncTracker {
  #outOfDate = [];
  #upToDate = 0;
  #updated = 0;
  quiet = false;

  /** Record an out-of-date file (CI mode). */
  recordOutOfDate(relPath) {
    this.#outOfDate.push(relPath);
    logError(`${relPath} is out of date`);
  }

  /** Throw if any files were out of date. Call at the end of the script. */
  throwIfOutOfDate(message) {
    if (this.#outOfDate.length > 0) {
      throw new Error(message || "Files are out of date. Run `npm run build` locally and commit the result.");
    }
  }

  /** Log a summary line (useful in quiet mode). */
  logSummary() {
    if (this.#updated > 0) {
      logChanged(`${this.#updated} file(s) updated, ${this.#upToDate} up to date`);
    } else {
      logOk(`${this.#upToDate} file(s) up to date`);
    }
  }

  /**
   * Compare a text file. If different:
   *   - CI: records mismatch (never writes)
   *   - Local: writes the file
   * Returns true if file was up to date.
   */
  syncFile(destPath, content) {
    const rel = path.relative(ROOT_DIR, destPath);
    let existing = "";
    try {
      existing = fs.readFileSync(destPath, "utf8");
    } catch {}

    if (content === existing) {
      this.#upToDate++;
      if (!this.quiet) {
        logOk(rel);
      }
      return true;
    }

    if (isCI) {
      this.recordOutOfDate(rel);
    } else {
      this.#updated++;
      fs.writeFileSync(destPath, content, "utf8");
      logChanged(`${rel} updated`);
    }
    return false;
  }

  /**
   * Compare a JSON file formatted through biome.
   * Same CI/local behavior as syncFile.
   */
  syncJson(destPath, obj) {
    return this.syncFile(destPath, formatJson(destPath, obj));
  }

  /**
   * Async version of syncFile.
   */
  async syncFileAsync(destPath, content) {
    const rel = path.relative(ROOT_DIR, destPath);
    let existing = "";
    try {
      existing = await fs.promises.readFile(destPath, "utf8");
    } catch {}

    if (content === existing) {
      this.#upToDate++;
      if (!this.quiet) {
        logOk(rel);
      }
      return true;
    }

    if (isCI) {
      this.recordOutOfDate(rel);
    } else {
      this.#updated++;
      await fs.promises.writeFile(destPath, content, "utf8");
      logChanged(`${rel} updated`);
    }
    return false;
  }
}

// ── Platform helpers ─────────────────────────────────────────────────────

/** Get sorted list of platform directory names under npm/. */
export function getPlatforms() {
  return fs
    .readdirSync(NPM_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Get all publishable package directories (main + all npm/<platform>). */
export function getPublishDirs() {
  const dirs = [PKG_DIR];
  for (const platform of getPlatforms()) {
    dirs.push(path.resolve(NPM_DIR, platform));
  }
  return dirs;
}
