import { decodeFilePaths, encodeFilePaths, iterateFilePaths } from "fast-fs-hash";
import { describe, expect, it } from "vitest";

describe("iterateFilePaths", () => {
  it("yields nothing for empty buffer", () => {
    expect([...iterateFilePaths(new Uint8Array(0))]).toEqual([]);
  });

  it("yields a single null-terminated path", () => {
    const buf = Buffer.from("/foo/bar.txt\0");
    expect([...iterateFilePaths(buf)]).toEqual(["/foo/bar.txt"]);
  });

  it("yields multiple paths", () => {
    const buf = Buffer.from("/a.txt\0/b.txt\0/c.txt\0");
    expect([...iterateFilePaths(buf)]).toEqual(["/a.txt", "/b.txt", "/c.txt"]);
  });

  it("drops trailing bytes without final \\0", () => {
    const buf = Buffer.from("/a.txt\0trailing");
    expect([...iterateFilePaths(buf)]).toEqual(["/a.txt"]);
  });

  it("preserves empty segments from consecutive \\0 bytes", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00]);
    expect([...iterateFilePaths(buf)]).toEqual(["", "", ""]);
  });

  it("preserves empty segment at start", () => {
    const buf = Buffer.from("\0/a.txt\0");
    expect([...iterateFilePaths(buf)]).toEqual(["", "/a.txt"]);
  });

  it("decodes UTF-8 paths", () => {
    const buf = Buffer.from("日本語.txt\0café.txt\0");
    expect([...iterateFilePaths(buf)]).toEqual(["日本語.txt", "café.txt"]);
  });

  it("matches decodeFilePaths for all round-trip cases", () => {
    const paths = ["/a.txt", "", "/b.txt", "", "", "/c.txt"];
    const encoded = encodeFilePaths(paths);
    expect([...iterateFilePaths(encoded)]).toEqual(decodeFilePaths(encoded));
  });

  it("is lazy — can stop early", () => {
    const buf = Buffer.from("/a.txt\0/b.txt\0/c.txt\0");
    const gen = iterateFilePaths(buf);
    expect(gen.next()).toEqual({ value: "/a.txt", done: false });
    expect(gen.next()).toEqual({ value: "/b.txt", done: false });
    gen.return();
  });

  it("works with non-Buffer Uint8Array", () => {
    const bytes = new TextEncoder().encode("/a.txt\0/b.txt\0");
    expect([...iterateFilePaths(bytes)]).toEqual(["/a.txt", "/b.txt"]);
  });
});
