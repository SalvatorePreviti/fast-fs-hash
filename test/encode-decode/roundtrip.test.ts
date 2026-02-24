import { decodeFilePaths, encodeFilePaths } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

describe("encodeFilePaths / decodeFilePaths round-trip", () => {
  const testCases: [string, string[]][] = [
    ["single path", ["/foo/bar.txt"]],
    ["multiple paths", ["/a.txt", "/b.txt", "/c.txt"]],
    ["UTF-8 paths", ["日本語.txt", "café/résumé.pdf", "🚀/data.bin"]],
    ["deeply nested", ["/a/b/c/d/e/f/g/h/i/j/file.txt"]],
    ["many paths", Array.from({ length: 100 }, (_, i) => `/file-${i}.txt`)],
    ["path with spaces", ["/path with spaces/file name.txt"]],
    ["path with special chars", ["/path/@#%&/file(1).txt"]],
    ["empty strings", ["", "", ""]],
    ["mix of empty and non-empty", ["/a.txt", "", "/b.txt", ""]],
  ];

  it.each(testCases)("%s", (_name, paths) => {
    const encoded = encodeFilePaths(paths);
    const decoded = decodeFilePaths(encoded);
    expect(decoded).toEqual(paths);
  });

  it("paths with \\0 become empty strings (not round-tripped)", () => {
    const paths = ["foo\0bar", "normal", "a\0b\0c"];
    const encoded = encodeFilePaths(paths);
    const decoded = decodeFilePaths(encoded);
    expect(decoded).toEqual(["", "normal", ""]);
  });

  it("path with \\0 at start becomes empty string", () => {
    const paths = ["\0start"];
    const encoded = encodeFilePaths(paths);
    const decoded = decodeFilePaths(encoded);
    expect(decoded).toEqual([""]);
  });

  it("path with \\0 at end becomes empty string", () => {
    const paths = ["end\0"];
    const encoded = encodeFilePaths(paths);
    const decoded = decodeFilePaths(encoded);
    expect(decoded).toEqual([""]);
  });

  it("preserves array length even when paths are replaced", () => {
    const paths = ["/real.txt", "bad\0path", "/also-real.txt"];
    const encoded = encodeFilePaths(paths);
    const decoded = decodeFilePaths(encoded);
    expect(decoded.length).toBe(paths.length);
    expect(decoded).toEqual(["/real.txt", "", "/also-real.txt"]);
  });
});
