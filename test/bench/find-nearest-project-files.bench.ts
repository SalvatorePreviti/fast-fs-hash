/**
 * Benchmark: findNearestProjectFiles — native vs Node.js parent-chain walker.
 *
 * Trimmed-down sibling of find-project-root.bench.ts: only the nearest
 * package.json / tsconfig.json / node_modules markers, with early-exit when
 * all three are found. Faster than findProjectRoot for callers that don't
 * need gitRoot / gitSuperRoot / root* fields.
 *
 * Three scenarios mirror find-project-root.bench.ts so absolute numbers are
 * directly comparable:
 *  - shallow: start 3 dirs below a marker-rich ancestor
 *  - deep:    start 12 dirs below a marker-rich ancestor
 *  - missing: start path doesn't exist (tolerant fallback)
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findNearestProjectFiles, findNearestProjectFilesSync } from "fast-fs-hash";
import { bench, describe } from "vitest";

const FIXTURE_DIR = path.join(tmpdir(), `fast-fs-hash-bench-find-nearest-project-files-${process.pid}`);

//  - Fixture setup

function buildFixture(depth: number): { root: string; start: string } {
  const root = path.join(FIXTURE_DIR, `d${depth}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"root"}\n');
  writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  mkdirSync(path.join(root, "node_modules"), { recursive: true });

  let dir = root;
  for (let i = 0; i < depth; i++) {
    dir = path.join(dir, `lvl${i}`);
    mkdirSync(dir, { recursive: true });
  }
  // A package.json one level above the start, to give the walker an early hit.
  if (depth >= 2) {
    writeFileSync(path.join(root, "lvl0", "package.json"), '{"name":"inner"}\n');
  }

  return { root, start: dir };
}

//  - Pure-Node implementation for comparison (mirrors the C++ walker).

interface NearestLite {
  packageJson: string | null;
  tsconfigJson: string | null;
  nodeModules: string | null;
}

const MAX_DEPTH = 128;

function statKindSync(p: string): 0 | 1 | 2 {
  try {
    const s = statSync(p);
    if (s.isDirectory()) {
      return 2;
    }
    if (s.isFile()) {
      return 1;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function statKind(p: string): Promise<0 | 1 | 2> {
  try {
    const s = await stat(p);
    if (s.isDirectory()) {
      return 2;
    }
    if (s.isFile()) {
      return 1;
    }
    return 0;
  } catch {
    return 0;
  }
}

function nodeFindNearestSync(startPath: string, stopPath?: string): NearestLite {
  const out: NearestLite = { packageJson: null, tsconfigJson: null, nodeModules: null };
  let dir = path.resolve(startPath);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (stopPath && (dir === stopPath || stopPath.startsWith(`${dir}${path.sep}`))) {
      break;
    }
    if (out.packageJson === null) {
      const pkg = path.join(dir, "package.json");
      if (statKindSync(pkg) === 1) {
        out.packageJson = pkg;
      }
    }
    if (out.tsconfigJson === null) {
      const ts = path.join(dir, "tsconfig.json");
      if (statKindSync(ts) === 1) {
        out.tsconfigJson = ts;
      }
    }
    if (out.nodeModules === null) {
      if (path.basename(dir) === "node_modules") {
        out.nodeModules = dir;
      } else {
        const nm = path.join(dir, "node_modules");
        if (statKindSync(nm) === 2) {
          out.nodeModules = nm;
        }
      }
    }
    if (out.packageJson !== null && out.tsconfigJson !== null && out.nodeModules !== null) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return out;
}

async function nodeFindNearest(startPath: string, stopPath?: string): Promise<NearestLite> {
  const out: NearestLite = { packageJson: null, tsconfigJson: null, nodeModules: null };
  let dir = path.resolve(startPath);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (stopPath && (dir === stopPath || stopPath.startsWith(`${dir}${path.sep}`))) {
      break;
    }
    if (out.packageJson === null) {
      const pkg = path.join(dir, "package.json");
      if ((await statKind(pkg)) === 1) {
        out.packageJson = pkg;
      }
    }
    if (out.tsconfigJson === null) {
      const ts = path.join(dir, "tsconfig.json");
      if ((await statKind(ts)) === 1) {
        out.tsconfigJson = ts;
      }
    }
    if (out.nodeModules === null) {
      if (path.basename(dir) === "node_modules") {
        out.nodeModules = dir;
      } else {
        const nm = path.join(dir, "node_modules");
        if ((await statKind(nm)) === 2) {
          out.nodeModules = nm;
        }
      }
    }
    if (out.packageJson !== null && out.tsconfigJson !== null && out.nodeModules !== null) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return out;
}

//  - Benchmark suites

describe("findNearestProjectFiles", () => {
  const shallow = buildFixture(3);
  const deep = buildFixture(12);
  const missing = {
    start: path.join(shallow.root, "lvl0/does/not/exist.ts"),
  };

  describe("shallow (3 levels deep)", () => {
    bench("native (sync)", () => {
      findNearestProjectFilesSync(shallow.start);
    });
    bench("native (async)", async () => {
      await findNearestProjectFiles(shallow.start);
    });
    bench("Node.js (sync, fs.statSync)", () => {
      nodeFindNearestSync(shallow.start);
    });
    bench("Node.js (async, fs.stat)", async () => {
      await nodeFindNearest(shallow.start);
    });
  });

  describe("deep (12 levels deep)", () => {
    bench("native (sync)", () => {
      findNearestProjectFilesSync(deep.start);
    });
    bench("native (async)", async () => {
      await findNearestProjectFiles(deep.start);
    });
    bench("Node.js (sync, fs.statSync)", () => {
      nodeFindNearestSync(deep.start);
    });
    bench("Node.js (async, fs.stat)", async () => {
      await nodeFindNearest(deep.start);
    });
  });

  describe("missing start path (tolerant fallback)", () => {
    bench("native (sync)", () => {
      findNearestProjectFilesSync(missing.start);
    });
    bench("Node.js (sync, fs.statSync)", () => {
      nodeFindNearestSync(missing.start);
    });
  });
});
