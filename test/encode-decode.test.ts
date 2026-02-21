/**
 * Tests for encodeFilePaths / decodeFilePaths — the null-separated
 * path encoding used to pass file lists to the C++ engine.
 *
 * Encoding rules:
 *   - Paths are UTF-8 encoded, separated by \0 bytes.
 *   - Paths containing \0 are replaced with empty strings (just a \0 separator),
 *     since null bytes are illegal in file paths on all platforms.
 *   - Empty segments are preserved and map to zero-hash entries.
 *   - A trailing \0 is always present; decoding strips it.
 */

import { describe, expect, it } from "vitest";
import { decodeFilePaths, encodeFilePaths } from "../packages/fast-fs-hash/src/index";

describe("encodeFilePaths", () => {
  it("returns empty buffer for empty array", () => {
    const buf = encodeFilePaths([]);
    expect(buf.length).toBe(0);
  });

  it("encodes a single path with trailing \\0", () => {
    const buf = encodeFilePaths(["/foo/bar.txt"]);
    const expected = Buffer.from("/foo/bar.txt\0");
    expect(buf.equals(expected)).toBe(true);
  });

  it("encodes multiple paths separated by \\0", () => {
    const buf = encodeFilePaths(["/a.txt", "/b.txt", "/c.txt"]);
    const expected = Buffer.from("/a.txt\0/b.txt\0/c.txt\0");
    expect(buf.equals(expected)).toBe(true);
  });

  it("replaces a path containing \\0 with an empty segment", () => {
    const buf = encodeFilePaths(["foo\0bar"]);
    // The path contains \0, so it becomes an empty segment: just \0
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("replaces paths with multiple \\0 chars with empty segments", () => {
    const buf = encodeFilePaths(["a\0b\0c"]);
    // Contains \0 → empty segment → just \0
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("handles mix of normal and \\0-containing paths", () => {
    const buf = encodeFilePaths(["/normal.txt", "with\0null", "/also-normal.txt"]);
    const expected = Buffer.from("/normal.txt\0\0/also-normal.txt\0");
    expect(buf.equals(expected)).toBe(true);
  });

  it("encodes empty strings as empty segments", () => {
    const buf = encodeFilePaths([""]);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("encodes multiple empty strings", () => {
    const buf = encodeFilePaths(["", "", ""]);
    expect(buf.length).toBe(3);
    expect(buf[0]).toBe(0);
    expect(buf[1]).toBe(0);
    expect(buf[2]).toBe(0);
  });

  it("encodes UTF-8 paths correctly", () => {
    const buf = encodeFilePaths(["日本語.txt", "café.txt"]);
    const decoded = decodeFilePaths(buf);
    expect(decoded).toEqual(["日本語.txt", "café.txt"]);
  });

  it("handles emoji paths", () => {
    const buf = encodeFilePaths(["🚀/launch.txt"]);
    const decoded = decodeFilePaths(buf);
    expect(decoded).toEqual(["🚀/launch.txt"]);
  });

  it("encodes a path that is just \\0 as empty segment", () => {
    const buf = encodeFilePaths(["\0"]);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("encodes a path starting with \\0 as empty segment", () => {
    const buf = encodeFilePaths(["\0start"]);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("encodes a path ending with \\0 as empty segment", () => {
    const buf = encodeFilePaths(["end\0"]);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("accepts a Set of paths", () => {
    const buf = encodeFilePaths(new Set(["/a.txt", "/b.txt"]));
    const decoded = decodeFilePaths(buf);
    expect(decoded).toEqual(["/a.txt", "/b.txt"]);
  });

  it("accepts an empty Set", () => {
    const buf = encodeFilePaths(new Set<string>());
    expect(buf.length).toBe(0);
  });

  it("accepts a generator", () => {
    function* paths() {
      yield "/x.txt";
      yield "/y.txt";
    }
    const buf = encodeFilePaths(paths());
    const decoded = decodeFilePaths(buf);
    expect(decoded).toEqual(["/x.txt", "/y.txt"]);
  });

  it("accepts a Set with \\0-containing paths", () => {
    const buf = encodeFilePaths(new Set(["/ok.txt", "bad\0path", "/also-ok.txt"]));
    const expected = Buffer.from("/ok.txt\0\0/also-ok.txt\0");
    expect(buf.equals(expected)).toBe(true);
  });
});

describe("decodeFilePaths", () => {
  it("returns empty array for empty buffer", () => {
    expect(decodeFilePaths(new Uint8Array(0))).toEqual([]);
  });

  it("decodes a single null-terminated path", () => {
    const buf = Buffer.from("/foo/bar.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["/foo/bar.txt"]);
  });

  it("decodes a single path without trailing \\0", () => {
    const buf = Buffer.from("/foo/bar.txt");
    expect(decodeFilePaths(buf)).toEqual(["/foo/bar.txt"]);
  });

  it("decodes multiple paths", () => {
    const buf = Buffer.from("/a.txt\0/b.txt\0/c.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["/a.txt", "/b.txt", "/c.txt"]);
  });

  it("decodes multiple paths without trailing \\0", () => {
    const buf = Buffer.from("/a.txt\0/b.txt\0/c.txt");
    expect(decodeFilePaths(buf)).toEqual(["/a.txt", "/b.txt", "/c.txt"]);
  });

  it("preserves empty segments from consecutive \\0 bytes", () => {
    // Three \0 bytes = three empty segments
    const buf = Buffer.from([0x00, 0x00, 0x00]);
    const result = decodeFilePaths(buf);
    expect(result).toEqual(["", "", ""]);
  });

  it("preserves empty segment at start", () => {
    const buf = Buffer.from("\0/a.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["", "/a.txt"]);
  });

  it("preserves empty segments between paths", () => {
    const buf = Buffer.from("/a.txt\0\0/b.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["/a.txt", "", "/b.txt"]);
  });

  it("decodes UTF-8 paths", () => {
    const buf = Buffer.from("日本語.txt\0café.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["日本語.txt", "café.txt"]);
  });

  it("decodes single \\0 as one empty segment", () => {
    const buf = Buffer.from([0x00]);
    expect(decodeFilePaths(buf)).toEqual([""]);
  });

  it("handles a mix of empty and non-empty segments", () => {
    // "a" \0 \0 "b" \0 \0 \0 "c" \0
    const buf = Buffer.from("a\0\0b\0\0\0c\0");
    expect(decodeFilePaths(buf)).toEqual(["a", "", "b", "", "", "c"]);
  });
});

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
    // \0-containing paths are replaced with empty strings
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
