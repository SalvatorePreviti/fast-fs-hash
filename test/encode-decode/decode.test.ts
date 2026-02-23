import { describe, expect, it } from "vitest";
import { decodeFilePaths } from "../../packages/fast-fs-hash/src/functions";

describe("decodeFilePaths", () => {
  it("returns empty array for empty buffer", () => {
    expect(decodeFilePaths(new Uint8Array(0))).toEqual([]);
  });

  it("decodes a single null-terminated path", () => {
    const buf = Buffer.from("/foo/bar.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["/foo/bar.txt"]);
  });

  it("decodes a single path without trailing \\0 as empty (dropped)", () => {
    const buf = Buffer.from("/foo/bar.txt");
    expect(decodeFilePaths(buf)).toEqual([]);
  });

  it("decodes multiple paths", () => {
    const buf = Buffer.from("/a.txt\0/b.txt\0/c.txt\0");
    expect(decodeFilePaths(buf)).toEqual(["/a.txt", "/b.txt", "/c.txt"]);
  });

  it("decodes multiple paths without trailing \\0 (last path dropped)", () => {
    const buf = Buffer.from("/a.txt\0/b.txt\0/c.txt");
    expect(decodeFilePaths(buf)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("preserves empty segments from consecutive \\0 bytes", () => {
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
    const buf = Buffer.from("a\0\0b\0\0\0c\0");
    expect(decodeFilePaths(buf)).toEqual(["a", "", "b", "", "", "c"]);
  });

  it("works with non-Buffer Uint8Array", () => {
    const bytes = new TextEncoder().encode("/a.txt\0/b.txt\0");
    expect(decodeFilePaths(bytes)).toEqual(["/a.txt", "/b.txt"]);
  });
});
