/**
 * Tests: findNearestProjectFiles / findNearestProjectFilesSync.
 *
 * Covers:
 *  - Nearest package.json / tsconfig.json / node_modules detection
 *  - Independent fields (some null, some populated)
 *  - File-as-input (walks from parent)
 *  - Missing path (tolerant — walks from longest existing ancestor)
 *  - Started-inside node_modules (zero-syscall hit)
 *  - stopPath boundary
 *  - Sync and async variants agree
 *  - Input validation
 */

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findNearestProjectFiles, findNearestProjectFilesSync } from "fast-fs-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_DIR = path.join(tmpdir(), `fast-fs-hash-find-nearest-project-files-${process.pid}`);

interface FixtureOptions {
  packageJsons?: string[];
  tsconfigs?: string[];
  nodeModules?: string[];
  dirs?: string[];
}

function buildFixture(name: string, opts: FixtureOptions): string {
  const root = path.join(TMP_DIR, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  for (const d of opts.dirs ?? []) {
    mkdirSync(path.join(root, d), { recursive: true });
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

  return realpathSync(root);
}

beforeAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("findNearestProjectFiles [native]", () => {
  describe("basic detection", () => {
    it("finds nearest of all three markers", () => {
      const root = buildFixture("all-three", {
        packageJsons: ["", "packages/a"],
        tsconfigs: ["", "packages/a"],
        nodeModules: [""],
        dirs: ["packages/a/src"],
      });

      const result = findNearestProjectFilesSync(path.join(root, "packages/a/src"));
      expect(result.packageJson).toBe(path.join(root, "packages/a/package.json"));
      expect(result.tsconfigJson).toBe(path.join(root, "packages/a/tsconfig.json"));
      // node_modules is at the top — three levels up from src.
      expect(result.nodeModules).toBe(path.join(root, "node_modules"));
    });

    it("returns null for markers that don't exist", () => {
      const root = buildFixture("only-package", {
        packageJsons: [""],
        dirs: ["src"],
      });

      const result = findNearestProjectFilesSync(path.join(root, "src"), TMP_DIR);
      expect(result.packageJson).toBe(path.join(root, "package.json"));
      expect(result.tsconfigJson).toBeNull();
      expect(result.nodeModules).toBeNull();
    });

    it("nearest takes precedence over outer occurrences", () => {
      const root = buildFixture("nearest-wins", {
        packageJsons: ["", "deep"],
        tsconfigs: ["", "deep"],
        dirs: ["deep/very/inside"],
      });

      const result = findNearestProjectFilesSync(path.join(root, "deep/very/inside"));
      expect(result.packageJson).toBe(path.join(root, "deep/package.json"));
      expect(result.tsconfigJson).toBe(path.join(root, "deep/tsconfig.json"));
    });
  });

  describe("file as input", () => {
    it("walks from the file's parent directory", () => {
      const root = buildFixture("file-input", {
        packageJsons: [""],
        dirs: ["src"],
      });
      writeFileSync(path.join(root, "src/index.ts"), "export {};\n");

      const result = findNearestProjectFilesSync(path.join(root, "src/index.ts"), TMP_DIR);
      expect(result.packageJson).toBe(path.join(root, "package.json"));
    });
  });

  describe("missing start path", () => {
    it("walks from the longest existing ancestor", () => {
      const root = buildFixture("missing", {
        packageJsons: [""],
        dirs: ["real"],
      });

      const result = findNearestProjectFilesSync(path.join(root, "real/does/not/exist"), TMP_DIR);
      expect(result.packageJson).toBe(path.join(root, "package.json"));
    });
  });

  describe("node_modules special cases", () => {
    it("detects when started inside a node_modules tree (zero-syscall hit)", () => {
      const root = buildFixture("inside-nm", {
        packageJsons: [""],
        nodeModules: [""],
        dirs: ["node_modules/some-pkg/lib"],
      });

      const result = findNearestProjectFilesSync(path.join(root, "node_modules/some-pkg/lib"));
      // The walker is currently inside node_modules — that directory IS the hit.
      expect(result.nodeModules).toBe(path.join(root, "node_modules"));
    });

    it("only matches a node_modules that is a directory, not a regular file", () => {
      const root = buildFixture("nm-as-file", {
        packageJsons: [""],
        dirs: ["src"],
      });
      // Create a regular file named node_modules — should NOT match.
      writeFileSync(path.join(root, "node_modules"), "not a directory\n");

      const result = findNearestProjectFilesSync(path.join(root, "src"), TMP_DIR);
      expect(result.nodeModules).toBeNull();
    });
  });

  describe("stopPath boundary", () => {
    it("stops walking before inspecting the stopPath directory", () => {
      const root = buildFixture("stop-path", {
        packageJsons: ["", "b"],
        dirs: ["b/inner"],
      });

      // Stop at root — only b/package.json should be found.
      const result = findNearestProjectFilesSync(path.join(root, "b/inner"), root);
      expect(result.packageJson).toBe(path.join(root, "b/package.json"));
    });
  });

  describe("sync and async agreement", () => {
    it("returns identical results for the same input", async () => {
      const root = buildFixture("sync-async", {
        packageJsons: ["", "pkg"],
        tsconfigs: ["pkg"],
        nodeModules: [""],
        dirs: ["pkg/src"],
      });

      const start = path.join(root, "pkg/src");
      const syncResult = findNearestProjectFilesSync(start);
      const asyncResult = await findNearestProjectFiles(start);
      expect(asyncResult).toEqual(syncResult);
    });
  });

  describe("input validation", () => {
    it("throws on non-string input", () => {
      expect(() => findNearestProjectFilesSync(42 as unknown as string)).toThrow();
    });

    it("throws on empty string", () => {
      expect(() => findNearestProjectFilesSync("")).toThrow();
    });

    it("rejects on non-string input (async)", async () => {
      await expect(findNearestProjectFiles(42 as unknown as string)).rejects.toThrow();
    });
  });
});
