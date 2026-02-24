import { stat } from "node:fs/promises";
import { decodeFilePaths, encodeFilePaths } from "../functions";
import { MAX_WASM_LANES, wasmCreateHashLanes, wasmHashFileTo } from "../xxhash128/xxhash128-wasm";
import type { FileHashCacheBase } from "./file-hash-cache-base";
import {
  ENTRY_STRIDE,
  F_DONE,
  F_HAS_OLD,
  F_NEED_HASH,
  F_NOT_CHECKED,
  STAT_BIGINT,
  STAT_CONCURRENCY,
} from "./file-hash-cache-format";

/**
 * Backend-specific stat+hash operations for file-hash-cache.
 *
 * Every method receives the owning {@link FileHashCacheBase} instance as the
 * first argument.  Implementations extract what they need from it:
 *
 * - **WASM fallback** ({@link createWasmFileHashCacheImpl}): reads
 *   `cache.currentFiles` (decoded `string[]`) and `cache.rootPath`.
 *   Never touches path buffers — avoids the encode→decode round-trip.
 *
 * - **Native C++ wrapper** ({@link createNativeFileHashCacheImpl}): calls
 *   `cache.getPathsBuf()` (lazy encode) to obtain the NUL-separated buffer
 *   the C++ worker threads expect.  String arrays are never decoded.
 *
 * @internal — Not part of the public API.
 */
export interface FileHashCacheImpl {
  /** Whether this impl is backed by the native addon or WASM. */
  readonly native: boolean;

  /**
   * Per-file stat + compare against old entries, with early exit on
   * first change.
   *
   * @param cache       The owning cache instance.
   * @param entriesBuf  Zeroed buffer (n × ENTRY_STRIDE) for new entries.
   * @param oldBuf      Old entries buffer read from the cache file.
   * @param fileStates  Per-file state flags (written by this method).
   * @returns `true` if all files match (cache valid), `false` otherwise.
   */
  statAndMatch(cache: FileHashCacheBase, entriesBuf: Buffer, oldBuf: Buffer, fileStates: Uint8Array): Promise<boolean>;

  /**
   * Complete entries that still need stat and/or hash work.
   *
   * @param cache       The owning cache instance.
   * @param entriesBuf  Entries buffer (n × ENTRY_STRIDE), partially filled.
   * @param fileStates  Per-file state flags (`F_DONE` entries are skipped).
   */
  completeEntries(cache: FileHashCacheBase, entriesBuf: Buffer, fileStates: Uint8Array): Promise<void>;

  /**
   * Merge-join old sorted entries with new file list.
   *
   * For each file that appears in both old and new lists (same path),
   * copies the 48-byte old entry (stat + hash) into `newEntries` at
   * the new position and sets `newStates[ni] = F_HAS_OLD`.
   *
   * O(oldCount + newCount) time.
   *
   * Callers provide whichever representation they already have:
   * - `Buffer` (from the cache file) — native passes directly, WASM decodes.
   * - `readonly string[]` (in-memory array) — WASM uses directly, native encodes.
   *
   * @param cache        The owning cache instance.
   * @param oldEntries   Old entries buffer.
   * @param oldPaths     Old file paths: NUL-separated UTF-8 buffer or decoded string array.
   * @param oldCount     Old file count.
   * @param newEntries   New entries buffer (n × ENTRY_STRIDE), zeroed.
   * @param newStates    New per-file states array.
   */
  remapOldEntries(
    cache: FileHashCacheBase,
    oldEntries: Buffer,
    oldPaths: Buffer | readonly string[],
    oldCount: number,
    newEntries: Buffer,
    newStates: Uint8Array
  ): void;
}

/**
 * Create a WASM-backed {@link FileHashCacheImpl}.
 *
 * Uses `stat(path)` + chunked file hashing (via {@link wasmHashFile}) with
 * bounded concurrency. Reads in 128 KiB chunks — never loads an entire file
 * into memory. Stat and hash are sequential per file to match C++ error
 * semantics. No XXHash128 instances are created.
 *
 * Path resolution uses `cache.currentFiles` (decoded `string[]`) joined with
 * `cache.rootPathSlash` — no buffer encoding or NUL scanning involved.
 *
 * @returns A frozen, reusable impl object.
 *
 * @internal — Not part of the public API.
 */
export function createWasmFileHashCacheImpl(): FileHashCacheImpl {
  return {
    native: false,

    async statAndMatch(
      cache: FileHashCacheBase,
      entriesBuf: Buffer,
      oldBuf: Buffer,
      fileStates: Uint8Array
    ): Promise<boolean> {
      const n = fileStates.length;
      const files = cache.currentFiles;
      const rootPathSlash = cache.rootPathSlash;

      if (files.length < n) {
        return false; // Fewer paths decoded than expected — corrupt cache.
      }

      // Safe: pool buffers are 8-byte aligned; ENTRY_STRIDE (48) is divisible by 8.
      // Use BigUint64 not BigInt64 — stat fields are unsigned (ino/size can be ≥ 2^63).
      // Pass byteLength>>>3 explicitly — without it the view spans the full backing
      // ArrayBuffer which may include trailing paths bytes not divisible by 8.
      const bue = new BigUint64Array(entriesBuf.buffer, entriesBuf.byteOffset, entriesBuf.byteLength >>> 3);
      const buo = new BigUint64Array(oldBuf.buffer, oldBuf.byteOffset, oldBuf.byteLength >>> 3);
      let changed = false;
      let earlyExit = false;
      let cursor = 0;

      const worker = async (): Promise<void> => {
        for (;;) {
          if (earlyExit) {
            break;
          }
          const i = cursor++;
          if (i >= n) {
            break;
          }

          const eOff = i * ENTRY_STRIDE;
          const rel = files[i];

          // Skip empty paths (defensive — normalizeFilePaths should not produce these).
          if (!rel) {
            entriesBuf.fill(0, eOff, eOff + 32);
            fileStates[i] = F_DONE;
            continue;
          }

          const filePath = rootPathSlash + rel;

          // 1. stat(path) — single libuv call
          let statOk = false;
          try {
            const s = await stat(filePath, STAT_BIGINT);
            const u = eOff >>> 3; // u64 base index for this entry (eOff / 8)
            bue[u] = s.ino;
            bue[u + 1] = s.mtimeNs;
            bue[u + 2] = s.ctimeNs;
            bue[u + 3] = s.size;
            statOk = true;
          } catch {
            // stat failed -> zero 32-byte stat section explicitly.
            entriesBuf.fill(0, eOff, eOff + 32);
          }

          // 2. Compare 32-byte stat section via single native memcmp.
          if (entriesBuf.compare(oldBuf, eOff, eOff + 32, eOff, eOff + 32) === 0) {
            // Stat matches — copy hash from old cache.
            oldBuf.copy(entriesBuf, eOff + 32, eOff + 32, eOff + 48);
            fileStates[i] = F_DONE;
            continue;
          }

          // 3. Size matches but metadata changed — rehash and compare content hash.
          if (statOk) {
            const u = eOff >>> 3;
            const newSize = bue[u + 3];
            if (newSize === buo[u + 3] && newSize > 0n) {
              try {
                await wasmHashFileTo(filePath, entriesBuf, eOff + 32);
              } catch {
                // Read failed -> zero hash bytes explicitly.
                entriesBuf.fill(0, eOff + 32, eOff + 48);
              }
              // Compare 16-byte content hash.
              if (entriesBuf.compare(oldBuf, eOff + 32, eOff + 48, eOff + 32, eOff + 48) === 0) {
                fileStates[i] = F_DONE;
                continue;
              }
            }
          }

          // 4. Stat differs, stat failed, or size changed — file changed.
          fileStates[i] = F_NEED_HASH;
          changed = true;
          earlyExit = true;
        }
      };

      const lanes = Math.min(STAT_CONCURRENCY, n);
      const tasks = new Array<Promise<void>>(lanes);
      for (let i = 0; i < lanes; i++) {
        tasks[i] = worker();
      }
      await Promise.all(tasks);

      return !changed;
    },

    async completeEntries(cache: FileHashCacheBase, entriesBuf: Buffer, fileStates: Uint8Array): Promise<void> {
      const n = fileStates.length;
      if (n === 0) {
        return;
      }

      const files = cache.currentFiles;
      const rootPathSlash = cache.rootPathSlash;

      if (files.length < n) {
        return; // Fewer paths decoded than expected — corrupt cache.
      }

      // BigUint64Array view for zero-overhead stat field reads/writes.
      // Pass byteLength>>>3 explicitly to avoid spanning the full backing ArrayBuffer.
      const bue = new BigUint64Array(entriesBuf.buffer, entriesBuf.byteOffset, entriesBuf.byteLength >>> 3);

      // Merged stat+hash worker pool with slab-allocated buffers.
      // Each lane stats a file and, if it needs hashing, immediately
      // hashes it in-place using its per-lane WASM state.  This eliminates
      // a second worker-pool setup and pipelines stat I/O with hash I/O.
      //
      // Lane count is bounded by MAX_WASM_LANES (8) — the WASM hashing
      // bottleneck, not stat concurrency.  8 concurrent async stats still
      // saturates the I/O subsystem on modern SSDs.
      const lanes = Math.min(MAX_WASM_LANES, n);
      const hashLane = wasmCreateHashLanes(lanes);
      let cursor = 0;

      const worker = async (laneIdx: number): Promise<void> => {
        for (;;) {
          const i = cursor++;
          if (i >= n) {
            break;
          }

          const state = fileStates[i];
          if (state === F_DONE) {
            continue;
          }

          const eOff = i * ENTRY_STRIDE;
          const rel = files[i];
          const filePath = rel ? rootPathSlash + rel : "";
          let needHash = state === F_NEED_HASH;

          if (state === F_NOT_CHECKED) {
            // Cold path: no prior data — stat the file.
            try {
              const s = await stat(filePath, STAT_BIGINT);
              const u = eOff >>> 3;
              bue[u] = s.ino;
              bue[u + 1] = s.mtimeNs;
              bue[u + 2] = s.ctimeNs;
              bue[u + 3] = s.size;
              needHash = true;
            } catch {
              // Stat failed — zero entire entry, skip hash.
              entriesBuf.fill(0, eOff, eOff + 48);
              continue;
            }
          } else if (state === F_HAS_OLD) {
            // Old entry pre-populated — re-stat and compare.
            try {
              const s = await stat(filePath, STAT_BIGINT);
              const u = eOff >>> 3;
              if (s.ino === bue[u] && s.mtimeNs === bue[u + 1] && s.ctimeNs === bue[u + 2] && s.size === bue[u + 3]) {
                fileStates[i] = F_DONE;
                continue;
              }
              bue[u] = s.ino;
              bue[u + 1] = s.mtimeNs;
              bue[u + 2] = s.ctimeNs;
              bue[u + 3] = s.size;
              needHash = true;
            } catch {
              // Stat failed — zero entire entry, skip hash.
              entriesBuf.fill(0, eOff, eOff + 48);
              continue;
            }
          }

          // Hash inline using this lane's slab-allocated buffers.
          if (needHash) {
            await hashLane(laneIdx, filePath, entriesBuf, eOff + 32);
          }
        }
      };

      const tasks = new Array<Promise<void>>(lanes);
      for (let i = 0; i < lanes; i++) {
        tasks[i] = worker(i);
      }
      await Promise.all(tasks);
    },

    remapOldEntries(
      cache: FileHashCacheBase,
      oldEntries: Buffer,
      oldPaths: Buffer | readonly string[],
      oldCount: number,
      newEntries: Buffer,
      newStates: Uint8Array
    ): void {
      // Narrow: string[] from setFiles (use directly), Buffer from validate (decode).
      const oldFiles = Buffer.isBuffer(oldPaths) ? decodeFilePaths(oldPaths) : oldPaths;
      const newFiles = cache.currentFiles;
      const oLen = Math.min(oldCount, oldFiles.length);
      const nLen = newFiles.length;
      let oi = 0;
      let ni = 0;

      while (oi < oLen && ni < nLen) {
        const oldFile = oldFiles[oi];
        const newFile = newFiles[ni];

        if (oldFile === newFile) {
          // Paths match — copy 48-byte old entry to new position.
          oldEntries.copy(newEntries, ni * ENTRY_STRIDE, oi * ENTRY_STRIDE, (oi + 1) * ENTRY_STRIDE);
          newStates[ni] = F_HAS_OLD;
          oi++;
          ni++;
        } else if (oldFile < newFile) {
          // Old path < new path — file was removed, advance old.
          oi++;
        } else {
          // Old path > new path — file was added, advance new.
          ni++;
        }
      }
    },
  };
}

/**
 * Shape of the raw native binding cache functions.
 *
 * Matches the N-API `CallbackInfo` arg order in
 * `CacheAsyncWorkers.h` / `CacheRemapOldEntries`.
 *
 * @internal
 */
export interface NativeCacheBinding {
  statAndMatch(
    entriesBuf: Buffer,
    oldBuf: Buffer,
    fileStates: Uint8Array,
    pathsBuf: Uint8Array,
    rootPath: string
  ): Promise<boolean>;
  completeEntries(entriesBuf: Buffer, fileStates: Uint8Array, pathsBuf: Uint8Array, rootPath: string): Promise<void>;
  remapOldEntries(
    oldEntries: Buffer,
    oldPaths: Buffer,
    oldCount: number,
    newEntries: Buffer,
    newStates: Uint8Array,
    newPaths: Buffer,
    newCount: number
  ): void;
}

/**
 * Create a native C++ backed {@link FileHashCacheImpl}.
 *
 * Wraps the raw N-API functions from the native binding, extracting
 * path buffers from `cache.getPathsBuf()` on demand.  String arrays
 * are never decoded — the C++ worker threads parse the NUL-separated
 * buffer directly and prepend `rootPath`.
 *
 * @param binding  The native binding export.
 * @returns A frozen, reusable impl object.
 *
 * @internal — Not part of the public API.
 */
export function createNativeFileHashCacheImpl({
  statAndMatch: nativeStatAndMatch,
  completeEntries: nativeCompleteEntries,
  remapOldEntries: nativeRemapOldEntries,
}: NativeCacheBinding): FileHashCacheImpl {
  return {
    native: true,

    statAndMatch(
      cache: FileHashCacheBase,
      entriesBuf: Buffer,
      oldBuf: Buffer,
      fileStates: Uint8Array
    ): Promise<boolean> {
      return nativeStatAndMatch(entriesBuf, oldBuf, fileStates, cache.getPathsBuf(), cache.rootPath);
    },

    completeEntries(cache: FileHashCacheBase, entriesBuf: Buffer, fileStates: Uint8Array): Promise<void> {
      return nativeCompleteEntries(entriesBuf, fileStates, cache.getPathsBuf(), cache.rootPath);
    },

    remapOldEntries(
      cache: FileHashCacheBase,
      oldEntries: Buffer,
      oldPaths: Buffer | readonly string[],
      oldCount: number,
      newEntries: Buffer,
      newStates: Uint8Array
    ): void {
      // Narrow: Buffer from validate (use directly), string[] from setFiles (encode for C++).
      nativeRemapOldEntries(
        oldEntries,
        Buffer.isBuffer(oldPaths) ? oldPaths : encodeFilePaths(oldPaths),
        oldCount,
        newEntries,
        newStates,
        cache.getPathsBuf(),
        cache.currentFiles.length
      );
    },
  };
}
