/**
 * Benchmark: findProjectRoot — native vs Node.js parent-chain walker.
 *
 * Measures startup-time project-root discovery (the kind of thing bundlers,
 * language servers, and ESLint rules do on every file lookup). All runs walk
 * the same synthetic fixture so absolute numbers are comparable across hosts.
 *
 * Three scenarios:
 *  - shallow: start 3 dirs below a marker-rich ancestor
 *  - deep:    start 12 dirs below a marker-rich ancestor (more syscalls)
 *  - missing: start path doesn't exist — exercises the tolerant fallback path
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findProjectRoot, findProjectRootSync } from "fast-fs-hash";
import { bench, describe } from "vitest";

const FIXTURE_DIR = path.join(tmpdir(), `fast-fs-hash-bench-find-project-root-${process.pid}`);

//  - Fixture setup

function buildFixture(depth: number): { root: string; start: string } {
  const root = path.join(FIXTURE_DIR, `d${depth}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"root"}\n');
  writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // Build a chain of `depth` nested directories underneath root. The deepest
  // one is where the walk starts.
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

//  - Pure-Node implementation for comparison

interface ProjectRootLite {
  gitRoot: string | null;
  gitSuperRoot: string | null;
  nearestPackageJson: string | null;
  rootPackageJson: string | null;
  nearestTsconfigJson: string | null;
  rootTsconfigJson: string | null;
  nearestNodeModules: string | null;
  rootNodeModules: string | null;
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

function nodeFindProjectRootSync(startPath: string, stopPath?: string): ProjectRootLite {
  const out: ProjectRootLite = {
    gitRoot: null,
    gitSuperRoot: null,
    nearestPackageJson: null,
    rootPackageJson: null,
    nearestTsconfigJson: null,
    rootTsconfigJson: null,
    nearestNodeModules: null,
    rootNodeModules: null,
  };
  let dir = path.resolve(startPath);
  let gitBounded = false;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (stopPath && (dir === stopPath || stopPath.startsWith(`${dir}${path.sep}`))) {
      break;
    }
    const gitKind = statKindSync(path.join(dir, ".git"));
    if (gitKind > 0) {
      if (out.gitRoot === null) {
        out.gitRoot = dir;
        gitBounded = true;
      }
      if (gitKind === 2) {
        out.gitSuperRoot = dir;
      }
    }
    const inRepo = !gitBounded || out.gitRoot === dir;
    if (inRepo) {
      const pkg = path.join(dir, "package.json");
      if (statKindSync(pkg) === 1) {
        if (out.nearestPackageJson === null) {
          out.nearestPackageJson = pkg;
        }
        out.rootPackageJson = pkg;
      }
      const ts = path.join(dir, "tsconfig.json");
      if (statKindSync(ts) === 1) {
        if (out.nearestTsconfigJson === null) {
          out.nearestTsconfigJson = ts;
        }
        out.rootTsconfigJson = ts;
      }
      if (path.basename(dir) === "node_modules") {
        if (out.nearestNodeModules === null) {
          out.nearestNodeModules = dir;
        }
        out.rootNodeModules = dir;
      } else {
        const nm = path.join(dir, "node_modules");
        if (statKindSync(nm) === 2) {
          if (out.nearestNodeModules === null) {
            out.nearestNodeModules = nm;
          }
          out.rootNodeModules = nm;
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  if (out.gitSuperRoot !== null && out.gitSuperRoot === out.gitRoot) {
    out.gitSuperRoot = null;
  }
  return out;
}

async function nodeFindProjectRoot(startPath: string, stopPath?: string): Promise<ProjectRootLite> {
  const out: ProjectRootLite = {
    gitRoot: null,
    gitSuperRoot: null,
    nearestPackageJson: null,
    rootPackageJson: null,
    nearestTsconfigJson: null,
    rootTsconfigJson: null,
    nearestNodeModules: null,
    rootNodeModules: null,
  };
  let dir = path.resolve(startPath);
  let gitBounded = false;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (stopPath && (dir === stopPath || stopPath.startsWith(`${dir}${path.sep}`))) {
      break;
    }
    const gitKind = await statKind(path.join(dir, ".git"));
    if (gitKind > 0) {
      if (out.gitRoot === null) {
        out.gitRoot = dir;
        gitBounded = true;
      }
      if (gitKind === 2) {
        out.gitSuperRoot = dir;
      }
    }
    const inRepo = !gitBounded || out.gitRoot === dir;
    if (inRepo) {
      const pkg = path.join(dir, "package.json");
      if ((await statKind(pkg)) === 1) {
        if (out.nearestPackageJson === null) {
          out.nearestPackageJson = pkg;
        }
        out.rootPackageJson = pkg;
      }
      const ts = path.join(dir, "tsconfig.json");
      if ((await statKind(ts)) === 1) {
        if (out.nearestTsconfigJson === null) {
          out.nearestTsconfigJson = ts;
        }
        out.rootTsconfigJson = ts;
      }
      if (path.basename(dir) === "node_modules") {
        if (out.nearestNodeModules === null) {
          out.nearestNodeModules = dir;
        }
        out.rootNodeModules = dir;
      } else {
        const nm = path.join(dir, "node_modules");
        if ((await statKind(nm)) === 2) {
          if (out.nearestNodeModules === null) {
            out.nearestNodeModules = nm;
          }
          out.rootNodeModules = nm;
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  if (out.gitSuperRoot !== null && out.gitSuperRoot === out.gitRoot) {
    out.gitSuperRoot = null;
  }
  return out;
}

//  - Benchmark suites

describe("findProjectRoot", () => {
  const shallow = buildFixture(3);
  const deep = buildFixture(12);
  const missing = {
    start: path.join(shallow.root, "lvl0/does/not/exist.ts"),
  };

  //  - shallow (~3 levels)
  describe("shallow (3 levels deep)", () => {
    bench("native (sync)", () => {
      findProjectRootSync(shallow.start);
    });
    bench("native (async)", async () => {
      await findProjectRoot(shallow.start);
    });
    bench("Node.js (sync, fs.statSync)", () => {
      nodeFindProjectRootSync(shallow.start);
    });
    bench("Node.js (async, fs.stat)", async () => {
      await nodeFindProjectRoot(shallow.start);
    });
  });

  //  - deep (~12 levels)
  describe("deep (12 levels deep)", () => {
    bench("native (sync)", () => {
      findProjectRootSync(deep.start);
    });
    bench("native (async)", async () => {
      await findProjectRoot(deep.start);
    });
    bench("Node.js (sync, fs.statSync)", () => {
      nodeFindProjectRootSync(deep.start);
    });
    bench("Node.js (async, fs.stat)", async () => {
      await nodeFindProjectRoot(deep.start);
    });
  });

  //  - missing start path
  describe("missing start path (tolerant fallback)", () => {
    bench("native (sync)", () => {
      findProjectRootSync(missing.start);
    });
    bench("Node.js (sync, fs.statSync)", () => {
      nodeFindProjectRootSync(missing.start);
    });
  });
});
