import { describe, expect, it } from "vitest";
import { decodeFilePaths, encodeFilePaths } from "../../packages/fast-fs-hash/src/index";

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
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
  });

  it("replaces paths with multiple \\0 chars with empty segments", () => {
    const buf = encodeFilePaths(["a\0b\0c"]);
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
