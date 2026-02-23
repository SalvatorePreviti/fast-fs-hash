import { stat } from "node:fs/promises";
import { decodeFilePaths } from "../functions";
import type { XXHash128LibraryStatus } from "../xxhash128/xxhash128-base";
import { MAX_WASM_LANES, wasmCreateHashLanes, wasmHashFileTo } from "../xxhash128/xxhash128-wasm";
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
 * The WASM fallback ({@link createWasmFileHashCacheImpl}) uses `stat()` +
 * Uses `stat(path)` with bounded concurrency and hashes changed files via
 * the chunked {@link wasmHashFile}.  The native C++
 * backend is loaded directly from the binding and offloads the entire
 * stat+hash loop to multi-threaded async workers.
 *
 * All methods that accept paths for stat/hash work receive `pathsBuf`
 * (null-separated UTF-8 — from `encodeFilePaths`).  `remapOldEntries` also
 * receives null-separated buffers matching the on-disk format.
 *
 * @internal — Not part of the public API.
 */
export interface FileHashCacheImpl {
  /** Backend library status: `"native"` or `"wasm"`. */
  readonly libraryStatus: XXHash128LibraryStatus;

  /**
   * Per-file stat + compare against old entries, with early exit on
   * first change.
   *
   * @param entriesBuf  Zeroed buffer (n × ENTRY_STRIDE) for new entries.
   * @param oldBuf      Old entries buffer read from the cache file.
   * @param fileStates  Per-file state flags (written by this method).
   * @param pathsBuf    Null-separated UTF-8 paths (from `encodeFilePaths`).
   * @returns `true` if all files match (cache valid), `false` otherwise.
   */
  statAndMatch(entriesBuf: Buffer, oldBuf: Buffer, fileStates: Uint8Array, pathsBuf: Uint8Array): Promise<boolean>;

  /**
   * Complete entries that still need stat and/or hash work.
   *
   * @param entriesBuf  Entries buffer (n × ENTRY_STRIDE), partially filled.
   * @param fileStates  Per-file state flags (`F_DONE` entries are skipped).
   * @param pathsBuf    Null-separated UTF-8 paths (from `encodeFilePaths`).
   */
  completeEntries(entriesBuf: Buffer, fileStates: Uint8Array, pathsBuf: Uint8Array): Promise<void>;

  /**
   * Merge-join old sorted entries with new file list.
   *
   * For each file that appears in both old and new lists (same path),
   * copies the 48-byte old entry (stat + hash) into `newEntries` at
   * the new position and sets `newStates[ni] = F_HAS_OLD`.
   *
   * Both path buffers are null-separated UTF-8 — produced by
   * `encodeFilePaths()`.  O(oldCount + newCount) time, zero allocation.
   *
   * @param oldEntries  Old entries buffer.
   * @param oldPaths    Old null-separated paths.
   * @param oldCount    Old file count.
   * @param newEntries  New entries buffer (n × ENTRY_STRIDE), zeroed.
   * @param newStates   New per-file states array.
   * @param newPaths    New null-separated paths.
   * @param newCount    New file count.
   */
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
 * Create a WASM-backed {@link FileHashCacheImpl}.
 *
 * Uses `stat(path)` + chunked file hashing (via {@link wasmHashFile}) with
 * bounded concurrency. Reads in 128 KiB chunks — never loads an entire file
 * into memory. Stat and hash are sequential per file to match C++ error
 * semantics. No XXHash128 instances are created.
 *
 * @returns A frozen, reusable impl object.
 *
 * @internal — Not part of the public API.
 */
export function createWasmFileHashCacheImpl(): FileHashCacheImpl {
  return {
    libraryStatus: "wasm",

    async statAndMatch(
      entriesBuf: Buffer,
      oldBuf: Buffer,
      fileStates: Uint8Array,
      pathsBuf: Uint8Array
    ): Promise<boolean> {
      const n = fileStates.length;
      const files = decodeFilePaths(pathsBuf);
      if (files.length !== n) {
        return false; // Path count mismatch -> cache invalid (matches C++ n == fc check)
      }
      if (files.length < n) {
        // Fewer decoded paths than entries — treat missing tails as not-checked.
        for (let i = files.length; i < n; i++) {
          entriesBuf.fill(0, i * ENTRY_STRIDE, (i + 1) * ENTRY_STRIDE);
        }
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
          const filePath = files[i];

          // Skip empty paths (rare: consecutive \0 in pathsBuf).
          if (!filePath) {
            entriesBuf.fill(0, eOff, eOff + 32);
            fileStates[i] = F_DONE;
            continue;
          }

          // 1. stat(path) — single libuv call, no FileHandle overhead.
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

    async completeEntries(entriesBuf: Buffer, fileStates: Uint8Array, pathsBuf: Uint8Array): Promise<void> {
      const n = fileStates.length;
      if (n === 0) {
        return;
      }

      const files = decodeFilePaths(pathsBuf);
      if (files.length < n) {
        // Fewer decoded paths than entries — zero out the trailing entries.
        for (let i = files.length; i < n; i++) {
          entriesBuf.fill(0, i * ENTRY_STRIDE, (i + 1) * ENTRY_STRIDE);
        }
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
          const filePath = files[i];
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
      oldEntries: Buffer,
      oldPaths: Buffer,
      oldCount: number,
      newEntries: Buffer,
      newStates: Uint8Array,
      newPaths: Buffer,
      newCount: number
    ): void {
      // Walk both null-separated buffers directly — no string array allocations.
      // Each segment is compared byte-for-byte via Buffer.compare on the raw slices.
      let oByte = 0; // byte cursor into oldPaths
      let nByte = 0; // byte cursor into newPaths
      let oi = 0; // old file index
      let ni = 0; // new file index

      while (oi < oldCount && ni < newCount) {
        // Find NUL terminator for each current segment (indexOf is optimised to memchr in V8).
        const oEnd = oldPaths.indexOf(0, oByte);
        if (oEnd < 0) {
          break;
        }
        const nEnd = newPaths.indexOf(0, nByte);
        if (nEnd < 0) {
          break;
        }

        const cmp = oldPaths.compare(newPaths, nByte, nEnd, oByte, oEnd);

        if (cmp === 0) {
          // Paths match — copy 48-byte old entry to new position.
          oldEntries.copy(newEntries, ni * ENTRY_STRIDE, oi * ENTRY_STRIDE, (oi + 1) * ENTRY_STRIDE);
          newStates[ni] = F_HAS_OLD;
          oByte = oEnd + 1;
          nByte = nEnd + 1;
          oi++;
          ni++;
        } else if (cmp < 0) {
          // Old path < new path — file was removed, advance old.
          oByte = oEnd + 1;
          oi++;
        } else {
          // Old path > new path — file was added, advance new.
          nByte = nEnd + 1;
          ni++;
        }
      }
    },
  };
}
