/**
 * Tests: findProjectRoot / findProjectRootSync.
 *
 * Covers:
 *  - Synthetic monorepo fixture (nested .git, package.json, tsconfig.json)
 *  - File-as-input (walks from parent)
 *  - Missing path (tolerant — walks from longest existing ancestor)
 *  - Submodule simulation (.git as file pointer + outer .git directory)
 *  - node_modules detection (probe + "started inside" + nested transitive)
 *  - stopPath boundary
 *  - Real fast-fs-hash repo walk (end-to-end sanity check)
 *  - Sync and async variants agree on results
 *
 * Note: home-directory boundary is assumed to work (resolved in JS via
 * os.homedir() and passed through). Fixtures live under os.tmpdir() which
 * is outside the user's HOME on every supported platform.
 */

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findProjectRoot, findProjectRootSync } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Place fixtures outside the fast-fs-hash repo so walks don't pick up its
// real .git / package.json / tsconfig.json as ancestors.
const TMP_DIR = path.join(tmpdir(), `fast-fs-hash-find-project-root-${process.pid}`);

//  - Fixture builder

interface FixtureOptions {
  gitDirs?: string[];
  gitFiles?: string[]; // .git as a regular file (submodule pointer)
  packageJsons?: string[];
  tsconfigs?: string[];
  nodeModules?: string[]; // directories to create a node_modules/ subfolder in
  /** Arbitrary directories to ensure exist. */
  dirs?: string[];
}

function buildFixture(name: string, opts: FixtureOptions): string {
  const root = path.join(TMP_DIR, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  for (const d of opts.dirs ?? []) {
    mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const g of opts.gitDirs ?? []) {
    mkdirSync(path.join(root, g, ".git"), { recursive: true });
  }
  for (const g of opts.gitFiles ?? []) {
    mkdirSync(path.join(root, g), { recursive: true });
    writeFileSync(path.join(root, g, ".git"), "gitdir: /nonexistent/worktree\n");
  }
  for (const p of opts.packageJsons ?? []) {
    mkdirSync(path.join(root, p), { recursive: true });
    writeFileSync(path.join(root, p, "package.json"), '{"name":"fixture"}\n');
  }
  for (const t of opts.tsconfigs ?? []) {
    mkdirSync(path.join(root, t), { recursive: true });
    writeFileSync(path.join(root, t, "tsconfig.json"), "{}\n");
  }
  for (const nm of opts.nodeModules ?? []) {
    mkdirSync(path.join(root, nm, "node_modules"), { recursive: true });
  }

  // Canonicalize via realpath so tests match what the C++ walker returns.
  return realpathSync(root);
}

//  - Tests

beforeAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("findProjectRoot [native]", () => {
  //  - Synthetic monorepo
  describe("synthetic monorepo", () => {
    it("finds nearest + root markers in a simple monorepo", () => {
      // Layout:
      //   /           .git  package.json  tsconfig.json
      //     packages/
      //       a/      package.json  tsconfig.json
      //         src/
      const root = buildFixture("monorepo", {
        gitDirs: [""],
        packageJsons: ["", "packages/a"],
        tsconfigs: ["", "packages/a"],
        dirs: ["packages/a/src"],
      });

      const result = findProjectRootSync(path.join(root, "packages/a/src"));
      expect(result.gitRoot).toBe(root);
      expect(result.gitSuperRoot).toBeNull();
      expect(result.nearestPackageJson).toBe(path.join(root, "packages/a/package.json"));
      expect(result.rootPackageJson).toBe(path.join(root, "package.json"));
      expect(result.nearestTsconfigJson).toBe(path.join(root, "packages/a/tsconfig.json"));
      expect(result.rootTsconfigJson).toBe(path.join(root, "tsconfig.json"));
    });

    it("returns null for markers that don't exist in the chain", () => {
      // No tsconfig anywhere.
      const root = buildFixture("no-tsconfig", {
        gitDirs: [""],
        packageJsons: [""],
        dirs: ["src"],
      });

      const result = findProjectRootSync(path.join(root, "src"));
      expect(result.gitRoot).toBe(root);
      expect(result.nearestPackageJson).toBe(path.join(root, "package.json"));
      expect(result.nearestTsconfigJson).toBeNull();
      expect(result.rootTsconfigJson).toBeNull();
    });

    it("nearest and root collapse to the same file when only one exists", () => {
      const root = buildFixture("single-package", {
        gitDirs: [""],
        packageJsons: [""],
        dirs: ["a/b/c"],
      });

      const result = findProjectRootSync(path.join(root, "a/b/c"));
      expect(result.nearestPackageJson).toBe(path.join(root, "package.json"));
      expect(result.rootPackageJson).toBe(path.join(root, "package.json"));
    });
  });

  //  - File-as-input
  describe("file as input", () => {
    it("walks from the parent directory when given a file path", () => {
      const root = buildFixture("file-input", {
        gitDirs: [""],
        packageJsons: [""],
        dirs: ["src"],
      });
      const filePath = path.join(root, "src", "entry.ts");
      writeFileSync(filePath, "export {};\n");

      const result = findProjectRootSync(filePath);
      expect(result.gitRoot).toBe(root);
      expect(result.nearestPackageJson).toBe(path.join(root, "package.json"));
    });
  });

  //  - Missing / partial paths
  describe("missing paths (tolerant)", () => {
    it("walks from the longest existing ancestor when the start path doesn't exist", () => {
      const root = buildFixture("missing", {
        gitDirs: [""],
        packageJsons: [""],
        dirs: ["src"],
      });
      // Deeply non-existent subpath under a real directory.
      const ghost = path.join(root, "src", "does/not/exist.ts");

      const result = findProjectRootSync(ghost);
      expect(result.gitRoot).toBe(root);
      expect(result.nearestPackageJson).toBe(path.join(root, "package.json"));
    });

    it("returns an all-null object (no throw) for an entirely nonsense path", () => {
      const result = findProjectRootSync("/definitely/not/a/real/path/anywhere/xyz123");
      // Should not throw. Fields may all be null or whatever was found walking
      // up /. The only hard requirement is it doesn't crash.
      expect(typeof result).toBe("object");
    });
  });

  //  - Submodule simulation
  describe("submodule simulation", () => {
    it(".git file (submodule pointer) is the innermost gitRoot, outer .git dir is gitSuperRoot", () => {
      // Layout:
      //   super/        .git/ (directory)
      //     sub/        .git  (file — submodule pointer)
      //       src/
      const root = buildFixture("submodule", {
        gitDirs: [""],
        gitFiles: ["sub"],
        dirs: ["sub/src"],
      });

      const result = findProjectRootSync(path.join(root, "sub/src"));
      expect(result.gitRoot).toBe(path.join(root, "sub"));
      expect(result.gitSuperRoot).toBe(root);
    });

    it("rootPackageJson is bounded by the enclosing .git (doesn't cross into superproject)", () => {
      // super/
      //   package.json   ← outer, should NOT appear as rootPackageJson
      //   .git/
      //   sub/
      //     package.json ← inner — nearest AND root for the submodule
      //     .git         ← file pointer
      //     src/
      const root = buildFixture("submodule-bounded", {
        gitDirs: [""],
        gitFiles: ["sub"],
        packageJsons: ["", "sub"],
        dirs: ["sub/src"],
      });

      const result = findProjectRootSync(path.join(root, "sub/src"));
      expect(result.gitRoot).toBe(path.join(root, "sub"));
      expect(result.gitSuperRoot).toBe(root);
      expect(result.nearestPackageJson).toBe(path.join(root, "sub/package.json"));
      expect(result.rootPackageJson).toBe(path.join(root, "sub/package.json"));
    });
  });

  //  - node_modules detection
  describe("node_modules", () => {
    it("finds nearest + root node_modules via probe from an ancestor", () => {
      // repo/
      //   .git
      //   node_modules/              ← root
      //   packages/a/
      //     node_modules/            ← nearest
      //     src/                     ← start
      const root = buildFixture("nm-basic", {
        gitDirs: [""],
        nodeModules: ["", "packages/a"],
        dirs: ["packages/a/src"],
      });
      const result = findProjectRootSync(path.join(root, "packages/a/src"));
      expect(result.nearestNodeModules).toBe(path.join(root, "packages/a/node_modules"));
      expect(result.rootNodeModules).toBe(path.join(root, "node_modules"));
    });

    it("detects the enclosing node_modules when started *inside* one", () => {
      // repo/
      //   .git
      //   node_modules/
      //     lodash/
      //       src/foo.js              ← start path
      const root = buildFixture("nm-inside", {
        gitDirs: [""],
        nodeModules: [""],
        dirs: ["node_modules/lodash/src"],
      });
      const start = path.join(root, "node_modules/lodash/src/foo.js");
      writeFileSync(start, "//\n");

      const result = findProjectRootSync(start);
      // The walker starts at .../node_modules/lodash/src, walks up to
      // .../node_modules/lodash, then to .../node_modules — at which point
      // dir_ends_in_node_modules() fires and records it directly.
      expect(result.nearestNodeModules).toBe(path.join(root, "node_modules"));
      expect(result.rootNodeModules).toBe(path.join(root, "node_modules"));
    });

    it("handles nested node_modules (transitive deps)", () => {
      // repo/
      //   .git
      //   node_modules/              ← root
      //     a/
      //       node_modules/          ← nearest (transitive dep)
      //         b/src/               ← start
      const root = buildFixture("nm-nested", {
        gitDirs: [""],
        nodeModules: ["", "node_modules/a"],
        dirs: ["node_modules/a/node_modules/b/src"],
      });
      const result = findProjectRootSync(path.join(root, "node_modules/a/node_modules/b/src"));
      // Nearest = innermost node_modules (first hit walking up).
      expect(result.nearestNodeModules).toBe(path.join(root, "node_modules/a/node_modules"));
      // Root = outermost node_modules still within gitRoot.
      expect(result.rootNodeModules).toBe(path.join(root, "node_modules"));
    });
  });

  //  - Stop-path boundary
  describe("stopPath boundary", () => {
    it("stops walking before inspecting the stopPath directory", () => {
      // root/               ← stopPath (NOT inspected)
      //   .git              ← must NOT be picked up
      //   package.json      ← must NOT be picked up
      //   b/
      //     package.json    ← IS picked up (below stopPath)
      //     c/              ← start
      const root = buildFixture("stop-path", {
        gitDirs: [""],
        packageJsons: ["", "b"],
        dirs: ["b/c"],
      });
      const result = findProjectRootSync(path.join(root, "b/c"), root);
      // .git at root must NOT be seen.
      expect(result.gitRoot).toBeNull();
      // b's package.json is still valid.
      expect(result.nearestPackageJson).toBe(path.join(root, "b/package.json"));
      expect(result.rootPackageJson).toBe(path.join(root, "b/package.json"));
    });

    it("treats ancestors of stopPath as out-of-bounds too", () => {
      // base/
      //   package.json        ← above stopPath's ancestor chain — must NOT be picked up
      //   deeply/
      //     nested/
      //       stop/           ← stopPath
      //         pkg/
      //           package.json
      //           src/        ← start
      const base = buildFixture("stop-ancestor", {
        packageJsons: ["", "deeply/nested/stop/pkg"],
        dirs: ["deeply/nested/stop/pkg/src"],
      });
      const result = findProjectRootSync(
        path.join(base, "deeply/nested/stop/pkg/src"),
        path.join(base, "deeply/nested/stop")
      );
      expect(result.nearestPackageJson).toBe(path.join(base, "deeply/nested/stop/pkg/package.json"));
      // base's package.json is above stopPath (deeply/nested/stop) — excluded.
      expect(result.rootPackageJson).toBe(path.join(base, "deeply/nested/stop/pkg/package.json"));
    });
  });

  //  - Sync / async parity
  describe("sync and async parity", () => {
    it("findProjectRoot and findProjectRootSync return identical results", async () => {
      const root = buildFixture("parity", {
        gitDirs: [""],
        packageJsons: ["", "packages/p"],
        tsconfigs: [""],
        dirs: ["packages/p/src"],
      });

      const start = path.join(root, "packages/p/src");
      const syncResult = findProjectRootSync(start);
      const asyncResult = await findProjectRoot(start);
      expect(asyncResult).toEqual(syncResult);
    });
  });

  //  - Real repo (end-to-end sanity)
  describe("real repo", () => {
    it("finds the fast-fs-hash repo's own markers", () => {
      // Walk from this test file's directory. The walker must find the
      // enclosing repo's .git.
      const result = findProjectRootSync(import.meta.dirname);
      // If the repo lives under the user's home (typical dev setup), the home
      // boundary may stop the walk early. In that case gitRoot will be null.
      // On CI the repo is typically under /workspace or /home/runner/work,
      // which may or may not be under HOME — and the basename of the mount
      // point is unpredictable (e.g. "/workspace" inside musl containers).
      if (result.gitRoot !== null) {
        expect(result.nearestPackageJson).toBeTruthy();
        expect(result.rootPackageJson).toBeTruthy();
        // The discovered gitRoot must be an ancestor of (or equal to) the
        // start directory — anchors the assertion to the actual walk.
        expect(import.meta.dirname.startsWith(result.gitRoot)).toBe(true);
      }
    });
  });

  //  - Input validation
  describe("input validation", () => {
    it("throws on non-string input", () => {
      expect(() => findProjectRootSync(42 as unknown as string)).toThrow();
    });

    it("throws (or rejects) on empty string", async () => {
      expect(() => findProjectRootSync("")).toThrow();
      await expect(findProjectRoot("")).rejects.toThrow();
    });
  });
});
