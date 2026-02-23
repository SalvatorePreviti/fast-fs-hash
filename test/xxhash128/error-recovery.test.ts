/**
 * Regression tests for error recovery bugs found by code review.
 *
 * Two bugs were fixed in the previous session:
 *
 * 1. **Stream `addFile` read-error path**: the old code did
 *    `state.set(slab.subarray(0, stateSize))` on read error, which
 *    could write contaminated (partially-hashed) slab state back
 *    to `_state`. The fix: don't touch `_state` on error — the
 *    pre-addFile state is preserved because only the ephemeral slab
 *    was modified during reads.
 *
 * 2. **Stream `addFiles` mid-read error recovery**: without a backup, a partial read of
 *    file N would contaminate the accumulated working state in the
 *    slab. The fix: slab layout `[workingState | backupState | readBuf]`
 *    with `slab.copyWithin` backup/restore around each file.
 *
 * These tests exercise both **open errors** (missing file) and
 * **read errors** (directory path → EISDIR on macOS/Linux) to
 * ensure state is preserved or rolled back correctly.
 *
 * Without the fixes, these tests would produce wrong hashes because
 * the error path would either contaminate `_state` (bug 1) or fail
 * to restore the working slab state from backup (bug 2).
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BackendInstance } from "./_helpers_new";
import { ALL_BACKENDS, hex, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("error-recovery");

/**
 * A directory path that can be opened with `fs.open(path, 'r')` but
 * fails with EISDIR when `fs.read` is called on the resulting fd.
 * This triggers the *read-error* code path (not the *open-error* path).
 */
function readErrorDir(): string {
  const dir = path.join(path.resolve(import.meta.dirname, "..", "tmp", "_new-impl-error-recovery"), "read-error-dir");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MISSING = "/tmp/__fast-fs-hash-test-missing-file-does-not-exist__.bin";

describe.each(ALL_BACKENDS)("%s backend", (_name, backend: BackendInstance) => {
  const {
    XxHash128Stream,
    digestBuffer,
    digestFile,
    digestFileTo,
    digestFilesSequential,
    digestFilesSequentialTo,
    digestFilesParallel,
    digestFilesParallelTo,
  } = backend;

  // ═══════════════════════════════════════════════════════════════════════
  // I. Stream addFile — state preservation on error
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFile: state preserved on error", () => {
    it("open error (missing file) does not alter accumulated state", async () => {
      const data = makeBuffer(5000);
      const s = new XxHash128Stream();
      s.addBuffer(data);
      const before = hex(s.digest());
      await s.addFile(MISSING, false);
      const after = hex(s.digest());
      expect(after).toBe(before);
    });

    it("read error (directory path → EISDIR) does not alter accumulated state", async () => {
      const dir = readErrorDir();
      const data = makeBuffer(5000);
      const s = new XxHash128Stream();
      s.addBuffer(data);
      const before = hex(s.digest());
      await s.addFile(dir, false);
      const after = hex(s.digest());
      expect(after).toBe(before);
    });

    it("open error: subsequent addBuffer still works correctly", async () => {
      const a = makeBuffer(1024, 1);
      const b = makeBuffer(2048, 2);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      s.addBuffer(a);
      await s.addFile(MISSING, false);
      s.addBuffer(b);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error: subsequent addBuffer still works correctly", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(1024, 1);
      const b = makeBuffer(2048, 2);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      s.addBuffer(a);
      await s.addFile(dir, false);
      s.addBuffer(b);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error: subsequent addFile with real file works", async () => {
      const dir = readErrorDir();
      const data = makeBuffer(3000, 7);
      const p = writeFixture("err-then-file.bin", data);
      const expected = hex(digestBuffer(data));
      const s = new XxHash128Stream();
      await s.addFile(dir, false);
      await s.addFile(p);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error: subsequent addString still works correctly", async () => {
      const dir = readErrorDir();
      const prefix = makeBuffer(512, 3);
      const suffix = "hello world test string";
      const combined = Buffer.concat([prefix, Buffer.from(suffix, "utf-8")]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFile(dir, false);
      s.addString(suffix);
      expect(hex(s.digest())).toBe(expected);
    });

    it("multiple consecutive errors do not corrupt state", async () => {
      const dir = readErrorDir();
      const data = makeBuffer(2048);
      const expected = hex(digestBuffer(data));
      const s = new XxHash128Stream();
      s.addBuffer(data);
      await s.addFile(MISSING, false);
      await s.addFile(dir, false);
      await s.addFile(MISSING, false);
      await s.addFile(dir, false);
      expect(hex(s.digest())).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // II. Stream addFiles — error recovery in sequential file list
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFiles: error recovery", () => {
    it("open error mid-list: skipped, other files contribute", async () => {
      const a = makeBuffer(500, 1);
      const b = makeBuffer(800, 2);
      const pA = writeFixture("addfiles-err-a.bin", a);
      const pB = writeFixture("addfiles-err-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      await s.addFiles([pA, MISSING, pB], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error mid-list: skipped, other files contribute", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(500, 1);
      const b = makeBuffer(800, 2);
      const pA = writeFixture("addfiles-rderr-a.bin", a);
      const pB = writeFixture("addfiles-rderr-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      await s.addFiles([pA, dir, pB], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("open error preserves accumulated state from prior addBuffer", async () => {
      const prefix = makeBuffer(300, 77);
      const a = makeBuffer(400, 1);
      const b = makeBuffer(600, 2);
      const pA = writeFixture("addfiles-pre-a.bin", a);
      const pB = writeFixture("addfiles-pre-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([prefix, a, b])));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFiles([pA, MISSING, pB], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error preserves accumulated state from prior addBuffer", async () => {
      const dir = readErrorDir();
      const prefix = makeBuffer(300, 77);
      const a = makeBuffer(400, 1);
      const b = makeBuffer(600, 2);
      const pA = writeFixture("addfiles-rdpre-a.bin", a);
      const pB = writeFixture("addfiles-rdpre-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([prefix, a, b])));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFiles([pA, dir, pB], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("multiple errors interspersed: only good files count", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(200, 10);
      const b = makeBuffer(300, 20);
      const c = makeBuffer(400, 30);
      const pA = writeFixture("addfiles-inter-a.bin", a);
      const pB = writeFixture("addfiles-inter-b.bin", b);
      const pC = writeFixture("addfiles-inter-c.bin", c);
      const expected = hex(digestBuffer(Buffer.concat([a, b, c])));
      const s = new XxHash128Stream();
      await s.addFiles([MISSING, pA, dir, MISSING, pB, dir, pC, MISSING], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("all paths error: state unchanged, empty contribution", async () => {
      const dir = readErrorDir();
      const prefix = makeBuffer(1024, 5);
      const expected = hex(digestBuffer(prefix));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFiles([MISSING, dir, MISSING, dir], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("addFiles after addFiles with errors: cumulative state", async () => {
      const a = makeBuffer(300, 1);
      const b = makeBuffer(400, 2);
      const c = makeBuffer(500, 3);
      const pA = writeFixture("addfiles-cum-a.bin", a);
      const pB = writeFixture("addfiles-cum-b.bin", b);
      const pC = writeFixture("addfiles-cum-c.bin", c);
      const expected = hex(digestBuffer(Buffer.concat([a, b, c])));
      const s = new XxHash128Stream();
      await s.addFiles([pA, MISSING], false);
      await s.addFiles([pB, MISSING, pC], false);
      expect(hex(s.digest())).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // III. Stream addFilesParallel — error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFilesParallel: error recovery", () => {
    it("open error → zero hash contribution, running state intact", async () => {
      const prefix = makeBuffer(200, 77);
      const aData = makeBuffer(300, 1);
      const pA = writeFixture("par-err-a.bin", aData);
      const hashA = await digestFile(pA);
      const hashMissing = Buffer.alloc(16); // zero hash for missing
      const combined = Buffer.concat([prefix, hashA, hashMissing]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFilesParallel([pA, MISSING], 0, false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error → zero hash contribution, running state intact", async () => {
      const dir = readErrorDir();
      const prefix = makeBuffer(200, 77);
      const aData = makeBuffer(300, 1);
      const pA = writeFixture("par-rderr-a.bin", aData);
      const hashA = await digestFile(pA);
      const hashDir = Buffer.alloc(16); // zero hash for read-error
      const combined = Buffer.concat([prefix, hashA, hashDir]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      s.addBuffer(prefix);
      await s.addFilesParallel([pA, dir], 0, false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error with throwOnError=true rejects", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await expect(s.addFilesParallel([dir])).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // IV. Stream addFiles as digestFilesSequential replacement — error recovery
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFiles (sequential digest): error recovery", () => {
    it("open error skipped: hash = concat of good files", async () => {
      const a = makeBuffer(500, 1);
      const b = makeBuffer(800, 2);
      const pA = writeFixture("dseq-err-a.bin", a);
      const pB = writeFixture("dseq-err-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      await s.addFiles([pA, MISSING, pB], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error skipped: hash = concat of good files", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(500, 1);
      const b = makeBuffer(800, 2);
      const pA = writeFixture("dseq-rderr-a.bin", a);
      const pB = writeFixture("dseq-rderr-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      await s.addFiles([pA, dir, pB], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("multiple errors: hash = concat of only good files", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(200, 10);
      const b = makeBuffer(300, 20);
      const pA = writeFixture("dseq-multi-a.bin", a);
      const pB = writeFixture("dseq-multi-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      await s.addFiles([MISSING, pA, dir, MISSING, pB, dir], false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("all errors: hash = empty data hash", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await s.addFiles([MISSING, dir, MISSING], false);
      expect(hex(s.digest())).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("read error with throwOnError=true rejects", async () => {
      const dir = readErrorDir();
      const p = writeFixture("dseq-throw.bin", makeBuffer(100));
      const s = new XxHash128Stream();
      await expect(s.addFiles([p, dir])).rejects.toThrow();
    });

    it("digestTo after addFiles with read error skipped", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(700, 5);
      const b = makeBuffer(900, 6);
      const pA = writeFixture("dseqto-a.bin", a);
      const pB = writeFixture("dseqto-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const s = new XxHash128Stream();
      await s.addFiles([pA, dir, pB], false);
      const out = Buffer.alloc(32);
      s.digestTo(out, 8);
      expect(hex(out.subarray(8, 24))).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // V. Stream addFilesParallel as digestFilesParallel replacement — error recovery
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFilesParallel (parallel digest): error recovery", () => {
    it("open error → zero hash in aggregate", async () => {
      const aData = makeBuffer(300, 1);
      const pA = writeFixture("dpar-err-a.bin", aData);
      const hashA = digestBuffer(aData);
      const combined = Buffer.concat([hashA, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      await s.addFilesParallel([pA, MISSING], 0, false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error → zero hash in aggregate", async () => {
      const dir = readErrorDir();
      const aData = makeBuffer(300, 1);
      const pA = writeFixture("dpar-rderr-a.bin", aData);
      const hashA = digestBuffer(aData);
      const combined = Buffer.concat([hashA, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      await s.addFilesParallel([pA, dir], 0, false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error with throwOnError=true rejects", async () => {
      const dir = readErrorDir();
      const p = writeFixture("dpar-throw.bin", makeBuffer(100));
      const s = new XxHash128Stream();
      await expect(s.addFilesParallel([p, dir])).rejects.toThrow();
    });

    it("digestTo after addFilesParallel with read error → zero hash in aggregate", async () => {
      const dir = readErrorDir();
      const aData = makeBuffer(400, 3);
      const pA = writeFixture("dparto-a.bin", aData);
      const hashA = digestBuffer(aData);
      const combined = Buffer.concat([hashA, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      await s.addFilesParallel([pA, dir], 0, false);
      const out = Buffer.alloc(32);
      s.digestTo(out, 4);
      expect(hex(out.subarray(4, 20))).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VI. Stream addFile as digestFile replacement — read error
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFile (single file digest): read error", () => {
    it("read error → empty-input hash, state unchanged (throwOnError disabled)", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await s.addFile(dir, false);
      // Stream addFile with throwOnError=false preserves state on error.
      // Fresh stream with no successful data → hash of empty input.
      expect(hex(s.digest())).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });

    it("read error → rejects (throwOnError enabled)", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await expect(s.addFile(dir)).rejects.toThrow();
    });

    it("digestTo after read error fills zeros at offset", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await s.addFile(dir, false);
      const out = Buffer.alloc(32);
      out.fill(0xff);
      s.digestTo(out, 8);
      // Stream with no successful data produces the empty-input hash,
      // not an all-zero buffer. Verify the digest was written at offset 8.
      const emptyHash = hex(digestBuffer(Buffer.alloc(0)));
      expect(hex(out.subarray(8, 24))).toBe(emptyHash);
      expect(out.subarray(0, 8).every((b) => b === 0xff)).toBe(true);
      expect(out.subarray(24, 32).every((b) => b === 0xff)).toBe(true);
    });

    it("read error does not corrupt next addFile call", async () => {
      const dir = readErrorDir();
      const data = makeBuffer(1024);
      const p = writeFixture("after-rderr.bin", data);
      const s = new XxHash128Stream();
      await s.addFile(dir, false); // fails silently
      s.reset();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(hex(digestBuffer(data)));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VII. Verify via stream — read error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream addFilesParallel verify pattern: read error", () => {
    it("read error produces zero hash for that file (throwOnError disabled)", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await s.addFilesParallel([dir], 0, false);
      // The parallel digest for a single errored file feeds a 16-byte zero
      // hash into the running state, so the result is hash(zeroes(16)).
      const expected = hex(digestBuffer(Buffer.alloc(16)));
      expect(hex(s.digest())).toBe(expected);
    });

    it("mix: good file + read-error with throwOnError disabled", async () => {
      const dir = readErrorDir();
      const data = makeBuffer(512);
      const p = writeFixture("verify-rderr-good.bin", data);
      const goodHash = digestBuffer(data);
      // Parallel hashing: hash(goodHash || zeroes(16))
      const combined = Buffer.concat([goodHash, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const s = new XxHash128Stream();
      await s.addFilesParallel([p, dir], 0, false);
      expect(hex(s.digest())).toBe(expected);
    });

    it("read error with throwOnError=true rejects", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      await expect(s.addFilesParallel([dir])).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VIII. Stream reset / lifecycle after errors
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stream lifecycle after errors", () => {
    it("reset after addFile error clears to empty state", async () => {
      const dir = readErrorDir();
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      await s.addFile(dir, false);
      s.reset();
      expect(hex(s.digest())).toBe("99aa06d3014798d86001c324468d497f"); // H_EMPTY
    });

    it("reset after addFiles error clears to empty state", async () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(1024));
      await s.addFiles([MISSING], false);
      s.reset();
      expect(hex(s.digest())).toBe("99aa06d3014798d86001c324468d497f");
    });

    it("full lifecycle: data → error → more data → reset → fresh data", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(512, 1);
      const b = makeBuffer(768, 2);
      const c = makeBuffer(256, 3);
      const s = new XxHash128Stream();
      s.addBuffer(a);
      await s.addFile(dir, false);
      s.addBuffer(b);
      // Should be hash(a || b) since dir was skipped
      expect(hex(s.digest())).toBe(hex(digestBuffer(Buffer.concat([a, b]))));
      s.reset();
      s.addBuffer(c);
      expect(hex(s.digest())).toBe(hex(digestBuffer(c)));
    });

    it("seeded stream: error preserves seed-based state", async () => {
      const dir = readErrorDir();
      const data = makeBuffer(512);
      // Compute expected by creating a seeded stream without errors
      const ref = new XxHash128Stream(42, 99);
      ref.addBuffer(data);
      const expected = hex(ref.digest());
      const s = new XxHash128Stream(42, 99);
      s.addBuffer(data);
      await s.addFile(dir, false);
      expect(hex(s.digest())).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // IX. digestFile — throwOnError
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFile: throwOnError", () => {
    it("rejects on missing file (default throwOnError=true)", async () => {
      await expect(digestFile(MISSING)).rejects.toThrow();
    });

    it("resolves with zeroed buffer on missing file (throwOnError=false)", async () => {
      const result = await digestFile(MISSING, false);
      expect(result).toHaveLength(16);
      expect(result.every((b) => b === 0)).toBe(true);
    });

    it("rejects on read error (default)", async () => {
      const dir = readErrorDir();
      await expect(digestFile(dir)).rejects.toThrow();
    });

    it("resolves with zeroed buffer on read error (throwOnError=false)", async () => {
      const dir = readErrorDir();
      const result = await digestFile(dir, false);
      expect(result).toHaveLength(16);
      expect(result.every((b) => b === 0)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // X. digestFileTo — throwOnError
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFileTo: throwOnError", () => {
    it("rejects on missing file (default)", async () => {
      const out = Buffer.alloc(16);
      await expect(digestFileTo(MISSING, out)).rejects.toThrow();
    });

    it("writes zeroes on missing file (throwOnError=false)", async () => {
      const out = Buffer.alloc(32);
      out.fill(0xff);
      const result = await digestFileTo(MISSING, out, 8, false);
      expect(result).toBe(out);
      expect(out.subarray(8, 24).every((b) => b === 0)).toBe(true);
      expect(out.subarray(0, 8).every((b) => b === 0xff)).toBe(true);
      expect(out.subarray(24, 32).every((b) => b === 0xff)).toBe(true);
    });

    it("writes zeroes on read error (throwOnError=false)", async () => {
      const dir = readErrorDir();
      const out = Buffer.alloc(16);
      out.fill(0xff);
      await digestFileTo(dir, out, 0, false);
      expect(out.every((b) => b === 0)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // XI. digestFilesSequential — throwOnError
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesSequential: throwOnError", () => {
    it("rejects on missing file (default)", async () => {
      const p = writeFixture("dseq-toe-a.bin", makeBuffer(200));
      await expect(digestFilesSequential([p, MISSING])).rejects.toThrow();
    });

    it("skips missing file and hashes good files (throwOnError=false)", async () => {
      const a = makeBuffer(500, 1);
      const b = makeBuffer(800, 2);
      const pA = writeFixture("dseq-toe-skip-a.bin", a);
      const pB = writeFixture("dseq-toe-skip-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const result = await digestFilesSequential([pA, MISSING, pB], false);
      expect(hex(result)).toBe(expected);
    });

    it("skips read-error file (throwOnError=false)", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(400, 3);
      const pA = writeFixture("dseq-toe-rderr.bin", a);
      const expected = hex(digestBuffer(a));
      const result = await digestFilesSequential([pA, dir], false);
      expect(hex(result)).toBe(expected);
    });

    it("all errors: returns hash of empty data (throwOnError=false)", async () => {
      const dir = readErrorDir();
      const result = await digestFilesSequential([MISSING, dir], false);
      expect(hex(result)).toBe(hex(digestBuffer(Buffer.alloc(0))));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // XII. digestFilesSequentialTo — throwOnError
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesSequentialTo: throwOnError", () => {
    it("rejects on missing file (default)", async () => {
      const out = Buffer.alloc(16);
      await expect(digestFilesSequentialTo([MISSING], out)).rejects.toThrow();
    });

    it("skips missing file and writes digest (throwOnError=false)", async () => {
      const a = makeBuffer(300, 1);
      const b = makeBuffer(600, 2);
      const pA = writeFixture("dseqto-toe-a.bin", a);
      const pB = writeFixture("dseqto-toe-b.bin", b);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      const out = Buffer.alloc(32);
      await digestFilesSequentialTo([pA, MISSING, pB], out, 8, false);
      expect(hex(out.subarray(8, 24))).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // XIII. digestFilesParallel — throwOnError
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesParallel: throwOnError", () => {
    it("rejects on missing file (default)", async () => {
      await expect(digestFilesParallel([MISSING])).rejects.toThrow();
    });

    it("zero hash for missing file (throwOnError=false)", async () => {
      const a = makeBuffer(300, 1);
      const pA = writeFixture("dpar-toe-a.bin", a);
      const hashA = await digestFile(pA);
      const combined = Buffer.concat([hashA, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const result = await digestFilesParallel([pA, MISSING], 0, false);
      expect(hex(result)).toBe(expected);
    });

    it("zero hash for read-error file (throwOnError=false)", async () => {
      const dir = readErrorDir();
      const a = makeBuffer(300, 1);
      const pA = writeFixture("dpar-toe-rderr.bin", a);
      const hashA = await digestFile(pA);
      const combined = Buffer.concat([hashA, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const result = await digestFilesParallel([pA, dir], 0, false);
      expect(hex(result)).toBe(expected);
    });

    it("rejects on read error (default)", async () => {
      const dir = readErrorDir();
      await expect(digestFilesParallel([dir])).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // XIV. digestFilesParallelTo — throwOnError
  // ═══════════════════════════════════════════════════════════════════════

  describe("digestFilesParallelTo: throwOnError", () => {
    it("rejects on missing file (default)", async () => {
      const out = Buffer.alloc(16);
      await expect(digestFilesParallelTo([MISSING], out)).rejects.toThrow();
    });

    it("zero hash for missing file and writes at offset (throwOnError=false)", async () => {
      const a = makeBuffer(400, 5);
      const pA = writeFixture("dparto-toe-a.bin", a);
      const hashA = await digestFile(pA);
      const combined = Buffer.concat([hashA, Buffer.alloc(16)]);
      const expected = hex(digestBuffer(combined));
      const out = Buffer.alloc(32);
      await digestFilesParallelTo([pA, MISSING], out, 4, 0, false);
      expect(hex(out.subarray(4, 20))).toBe(expected);
    });
  });
});
