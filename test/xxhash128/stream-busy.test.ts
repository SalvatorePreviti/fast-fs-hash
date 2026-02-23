/**
 * Tests for the streaming hash busy guard and `busy` getter.
 *
 * The C++ layer uses a dual-magic tag (MAGIC_IDLE / MAGIC_BUSY) to prevent
 * concurrent use of the XXH3 state while an async worker is in flight.
 * These tests verify:
 *   1. `busy` getter reflects async operation state correctly.
 *   2. Sync methods throw while an async operation is pending.
 *   3. A second async operation throws while the first is pending.
 *   4. State is usable again after the async operation completes (success or error).
 */

import { describe, expect, it } from "vitest";
import { ALL_BACKENDS, hex, makeBuffer, setupFixtures, writeFixture } from "./_helpers_new";

setupFixtures("stream-busy");

describe.each(ALL_BACKENDS)("%s backend", (_name, backend) => {
  const { XxHash128Stream, digestBuffer } = backend;

  // ═══════════════════════════════════════════════════════════════════════
  // I. busy getter — basic state transitions
  // ═══════════════════════════════════════════════════════════════════════

  describe("busy getter", () => {
    it("false on fresh instance", () => {
      const s = new XxHash128Stream();
      expect(s.busy).toBe(false);
    });

    it("false after sync operations", () => {
      const s = new XxHash128Stream();
      s.addBuffer(makeBuffer(100));
      s.addString("hello");
      s.digest();
      expect(s.busy).toBe(false);
    });

    it("true while addFile is in flight, false after await", async () => {
      const data = makeBuffer(1024);
      const p = writeFixture("busy-addfile.bin", data);
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(s.busy).toBe(true);
      await promise;
      expect(s.busy).toBe(false);
    });

    it("true while addFiles is in flight, false after await", async () => {
      const data = makeBuffer(512);
      const p = writeFixture("busy-addfiles.bin", data);
      const s = new XxHash128Stream();
      const promise = s.addFiles([p]);
      expect(s.busy).toBe(true);
      await promise;
      expect(s.busy).toBe(false);
    });

    it("true while addFilesParallel is in flight, false after await", async () => {
      const data = makeBuffer(512);
      const p = writeFixture("busy-addpar.bin", data);
      const s = new XxHash128Stream();
      const promise = s.addFilesParallel([p]);
      expect(s.busy).toBe(true);
      await promise;
      expect(s.busy).toBe(false);
    });

    it("false after addFile rejects (error path clears busy)", async () => {
      const s = new XxHash128Stream();
      const promise = s.addFile("/tmp/__fast-fs-hash-missing-busy-test__.bin");
      expect(s.busy).toBe(true);
      await expect(promise).rejects.toThrow();
      expect(s.busy).toBe(false);
    });

    it("false after addFiles rejects (error path clears busy)", async () => {
      const s = new XxHash128Stream();
      const promise = s.addFiles(["/tmp/__fast-fs-hash-missing-busy-test__.bin"]);
      expect(s.busy).toBe(true);
      await expect(promise).rejects.toThrow();
      expect(s.busy).toBe(false);
    });

    it("false after addFilesParallel rejects (error path clears busy)", async () => {
      const s = new XxHash128Stream();
      const promise = s.addFilesParallel(["/tmp/__fast-fs-hash-missing-busy-test__.bin"]);
      expect(s.busy).toBe(true);
      await expect(promise).rejects.toThrow();
      expect(s.busy).toBe(false);
    });

    it("false after addFile with throwOnError=false on missing file", async () => {
      const s = new XxHash128Stream();
      const promise = s.addFile("/tmp/__fast-fs-hash-missing-busy-test__.bin", false);
      expect(s.busy).toBe(true);
      await promise;
      expect(s.busy).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // II. Sync methods throw while busy
  // ═══════════════════════════════════════════════════════════════════════

  describe("sync methods throw while busy", () => {
    it("addBuffer throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-buf.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.addBuffer(makeBuffer(10))).toThrow(/async operation is pending/);
      await promise;
    });

    it("addString throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-str.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.addString("test")).toThrow(/async operation is pending/);
      await promise;
    });

    it("addBufferRange throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-range.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.addBufferRange(makeBuffer(10), 0, 5)).toThrow(/async operation is pending/);
      await promise;
    });

    it("digest throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-digest.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.digest()).toThrow(/async operation is pending/);
      await promise;
    });

    it("digestTo throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-digestto.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.digestTo(Buffer.alloc(16))).toThrow(/async operation is pending/);
      await promise;
    });

    it("reset throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-reset.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.reset()).toThrow(/async operation is pending/);
      await promise;
    });

    it("clone throws while addFile is pending", async () => {
      const p = writeFixture("busy-sync-clone.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.clone()).toThrow(/async operation is pending/);
      await promise;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // III. Second async op throws while first is pending
  // ═══════════════════════════════════════════════════════════════════════

  describe("concurrent async ops throw", () => {
    it("addFile throws while another addFile is pending", async () => {
      const p = writeFixture("busy-aa-file.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.addFile(p)).toThrow(/async operation is pending/);
      await promise;
    });

    it("addFiles throws while addFile is pending", async () => {
      const p = writeFixture("busy-aa-files.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.addFiles([p])).toThrow(/async operation is pending/);
      await promise;
    });

    it("addFilesParallel throws while addFile is pending", async () => {
      const p = writeFixture("busy-aa-par.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFile(p);
      expect(() => s.addFilesParallel([p])).toThrow(/async operation is pending/);
      await promise;
    });

    it("addFile throws while addFiles is pending", async () => {
      const p = writeFixture("busy-ab-file.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFiles([p]);
      expect(() => s.addFile(p)).toThrow(/async operation is pending/);
      await promise;
    });

    it("addFile throws while addFilesParallel is pending", async () => {
      const p = writeFixture("busy-ac-file.bin", makeBuffer(1024));
      const s = new XxHash128Stream();
      const promise = s.addFilesParallel([p]);
      expect(() => s.addFile(p)).toThrow(/async operation is pending/);
      await promise;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // IV. State usable after async completes
  // ═══════════════════════════════════════════════════════════════════════

  describe("state usable after async completes", () => {
    it("sync ops work after addFile completes", async () => {
      const data = makeBuffer(512);
      const p = writeFixture("busy-after-file.bin", data);
      const s = new XxHash128Stream();
      await s.addFile(p);
      expect(s.busy).toBe(false);
      s.addString("more");
      const result = s.digest();
      expect(result).toHaveLength(16);
    });

    it("second addFile works after first completes", async () => {
      const a = makeBuffer(256, 1);
      const b = makeBuffer(512, 2);
      const pA = writeFixture("busy-seq-a.bin", a);
      const pB = writeFixture("busy-seq-b.bin", b);
      const s = new XxHash128Stream();
      await s.addFile(pA);
      await s.addFile(pB);
      const expected = hex(digestBuffer(Buffer.concat([a, b])));
      expect(hex(s.digest())).toBe(expected);
    });

    it("sync ops work after addFile error + rejection", async () => {
      const s = new XxHash128Stream();
      await expect(s.addFile("/tmp/__fast-fs-hash-missing-busy-post__.bin")).rejects.toThrow();
      expect(s.busy).toBe(false);
      s.addBuffer(makeBuffer(100));
      const result = s.digest();
      expect(result).toHaveLength(16);
    });

    it("addFile works after addFiles error + rejection", async () => {
      const data = makeBuffer(512);
      const p = writeFixture("busy-after-err.bin", data);
      const s = new XxHash128Stream();
      await expect(s.addFiles(["/tmp/__fast-fs-hash-missing-busy-post__.bin"])).rejects.toThrow();
      s.reset();
      await s.addFile(p);
      expect(hex(s.digest())).toBe(hex(digestBuffer(data)));
    });
  });
});
