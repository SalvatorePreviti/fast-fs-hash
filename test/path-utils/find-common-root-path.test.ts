import { findCommonRootPath } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

describe("findCommonRootPath", () => {
  // ── Basic cases ───────────────────────────────────────────────────

  it("returns empty string for empty input", () => {
    expect(findCommonRootPath([])).toBe("");
  });

  it("returns empty string when all entries are empty strings", () => {
    expect(findCommonRootPath(["", "", ""])).toBe("");
  });

  it("ignores empty strings among valid paths", () => {
    expect(findCommonRootPath(["", "/a/b/c.ts", "", "/a/b/d.ts", ""])).toBe("/a/b");
  });

  it("returns parent directory for a single file", () => {
    expect(findCommonRootPath(["/a/b/c.ts"])).toBe("/a/b");
  });

  it("returns parent for a single file at root level", () => {
    expect(findCommonRootPath(["/foo.ts"])).toBe("/");
  });

  // ── Common prefix merging ────────────────────────────────────────

  it("finds common parent of files in the same directory", () => {
    expect(findCommonRootPath(["/a/b/c.ts", "/a/b/d.ts"])).toBe("/a/b");
  });

  it("finds common parent across different subdirectories", () => {
    expect(findCommonRootPath(["/a/b/c.ts", "/a/d/e.ts"])).toBe("/a");
  });

  it("returns POSIX root when files share only the root", () => {
    expect(findCommonRootPath(["/a/x.ts", "/b/y.ts"])).toBe("/");
  });

  it("finds common parent from deeply nested paths", () => {
    expect(
      findCommonRootPath(["/usr/local/lib/node/a.ts", "/usr/local/lib/node/sub/b.ts", "/usr/local/lib/other.ts"])
    ).toBe("/usr/local/lib");
  });

  // ── No common root ───────────────────────────────────────────────

  it("returns empty string for relative paths with no common prefix", () => {
    expect(findCommonRootPath(["foo/a.ts", "bar/b.ts"])).toBe("");
  });

  it("returns empty string for bare filenames", () => {
    expect(findCommonRootPath(["a.ts", "b.ts"])).toBe("");
  });

  it("returns empty string for a single bare filename", () => {
    expect(findCommonRootPath(["a.ts"])).toBe("");
  });

  // ── Relative paths with common prefix ─────────────────────────────

  it("finds common prefix among relative paths", () => {
    expect(findCommonRootPath(["src/a.ts", "src/b.ts"])).toBe("src");
  });

  it("finds common prefix among deep relative paths", () => {
    expect(findCommonRootPath(["src/lib/a.ts", "src/lib/b.ts", "src/utils/c.ts"])).toBe("src");
  });

  // ── Iterables ─────────────────────────────────────────────────────

  it("accepts a Set", () => {
    expect(findCommonRootPath(new Set(["/a/b/c.ts", "/a/b/d.ts"]))).toBe("/a/b");
  });

  it("accepts a generator", () => {
    function* gen() {
      yield "/x/y/a.ts";
      yield "/x/y/b.ts";
    }
    expect(findCommonRootPath(gen())).toBe("/x/y");
  });

  // ── Early termination ─────────────────────────────────────────────

  it("returns empty string immediately when prefix is exhausted", () => {
    // Third entry shares nothing with the first two → early exit.
    expect(findCommonRootPath(["/a/b/c.ts", "/a/b/d.ts", "z.ts"])).toBe("");
  });

  // ── Segment-boundary correctness ──────────────────────────────────

  it("does not match partial segment names", () => {
    // "/abc" and "/abd" have a common CHAR prefix of "/ab" but NOT a
    // common SEGMENT prefix — the root is "/".
    expect(findCommonRootPath(["/abc/x.ts", "/abd/y.ts"])).toBe("/");
  });

  it("handles trailing slashes in paths (treated as directory)", () => {
    // "/a/b/" splits into ["", "a", "b", ""], pop → ["", "a", "b"]
    expect(findCommonRootPath(["/a/b/", "/a/c.ts"])).toBe("/a");
  });

  // ── baseRoot argument ─────────────────────────────────────────────

  it("baseRoot prevents the result from being deeper than the base", () => {
    // Without baseRoot: common root is /project/src
    expect(findCommonRootPath(["/project/src/a.ts", "/project/src/b.ts"])).toBe("/project/src");
    // With baseRoot=/project: result is common ancestor of files AND /project → /project
    expect(findCommonRootPath(["/project/src/a.ts", "/project/src/b.ts"], "/project")).toBe("/project");
  });

  it("baseRoot deeper than computed root has no effect", () => {
    // Common root from files is /project (spans src + lib)
    // baseRoot is /project/deep — deeper than /project
    // Common of /project and /project/deep is /project
    expect(findCommonRootPath(["/project/src/a.ts", "/project/lib/b.ts"], "/project/deep")).toBe("/project");
  });

  it("baseRoot with no overlap still shares POSIX root", () => {
    // Both /a/... and /x/... share the filesystem root "/".
    expect(findCommonRootPath(["/a/b/c.ts", "/a/b/d.ts"], "/x/y")).toBe("/");
  });

  it("baseRoot with relative paths and no overlap returns empty", () => {
    expect(findCommonRootPath(["a/b/c.ts", "a/b/d.ts"], "x/y")).toBe("");
  });

  it("baseRoot same as computed root is identity", () => {
    expect(findCommonRootPath(["/a/b/c.ts", "/a/b/d.ts"], "/a/b")).toBe("/a/b");
  });

  it("baseRoot with trailing slash is handled correctly", () => {
    expect(findCommonRootPath(["/project/src/a.ts", "/project/src/b.ts"], "/project/")).toBe("/project");
  });

  // ── allowedRoot argument ──────────────────────────────────────────

  it("allowedRoot filters out files outside the boundary", () => {
    // Only /project/src/a.ts is under /project/src
    expect(findCommonRootPath(["/project/src/a.ts", "/other/b.ts"], undefined, "/project/src")).toBe("/project/src");
  });

  it("allowedRoot with all files inside returns normal common root", () => {
    expect(findCommonRootPath(["/project/src/a.ts", "/project/src/b.ts"], undefined, "/project")).toBe("/project/src");
  });

  it("allowedRoot with all files outside returns empty string", () => {
    expect(findCommonRootPath(["/other/a.ts", "/another/b.ts"], undefined, "/project")).toBe("");
  });

  it("allowedRoot with trailing slash", () => {
    expect(findCommonRootPath(["/project/src/a.ts", "/other/b.ts"], undefined, "/project/")).toBe("/project/src");
  });

  it("allowedRoot and baseRoot combined", () => {
    // Files: /project/src/a.ts and /project/lib/b.ts and /other/c.ts
    // allowedRoot=/project filters out /other/c.ts
    // Remaining files common root: /project
    // baseRoot=/project: common of /project and /project = /project
    expect(findCommonRootPath(["/project/src/a.ts", "/project/lib/b.ts", "/other/c.ts"], "/project", "/project")).toBe(
      "/project"
    );
  });

  it("allowedRoot and baseRoot: baseRoot shallows the result", () => {
    // allowedRoot=/project keeps all files
    // Common root from files: /project/src
    // baseRoot=/project: common of /project/src and /project = /project
    expect(findCommonRootPath(["/project/src/a.ts", "/project/src/b.ts"], "/project", "/project")).toBe("/project");
  });
});
