/**
 * Shared internals for FileHashCache and FileHashCacheSession.
 *
 * Contains module-level state, native binding destructured constants,
 * cancel helpers, and dataBuf decode/encode utilities.
 *
 * @module
 * @internal
 */

import {
  ENTRY_STRIDE,
  H_COMPRESSED_PAYLOAD_ITEM_COUNT,
  H_COMPRESSED_PAYLOADS_LEN,
  H_FILE_COUNT,
  H_PATHS_LEN,
  H_UNCOMPRESSED_PAYLOAD_ITEM_COUNT,
  H_UNCOMPRESSED_PAYLOADS_LEN,
  HEADER_SIZE,
  S_CANCEL_FLAG,
} from "./file-hash-cache-format";
import { bufferAlloc } from "./functions";
import { binding } from "./init-native";

export const {
  cacheOpen,
  cacheWrite,
  cacheWriteNew,
  cacheIsLocked,
  cacheWaitUnlocked,
  cacheClose,
  cacheStatHash,
  cacheFireCancel,
} = binding;

let _emptyBufCached: Buffer | undefined;
export function emptyBuf(): Buffer {
  return (_emptyBufCached ??= bufferAlloc(0));
}
let _onceTrue: AddEventListenerOptions;

export const STATUS_MAP = ["upToDate", "changed", "stale", "missing", "statsDirty", "lockFailed"] as const;

// - Cancel helpers

/** Write cancel flag + attach abort listener. Returns the listener for cleanup (or null). */
export function setupCancel(stateBuf: Buffer, signal: AbortSignal | null | undefined): (() => void) | null {
  stateBuf.writeUInt32LE(0, S_CANCEL_FLAG);
  if (!signal) {
    return null;
  }
  if (signal.aborted) {
    stateBuf.writeUInt32LE(1, S_CANCEL_FLAG);
    return null;
  }
  const cb = () => {
    stateBuf.writeUInt32LE(1, S_CANCEL_FLAG);
    cacheFireCancel(stateBuf);
  };
  signal.addEventListener("abort", cb, (_onceTrue ??= { once: true }));
  return cb;
}

/** Remove abort listener after an async op completes. */
export function teardownCancel(signal: AbortSignal | null | undefined, cb: (() => void) | null): void {
  if (cb && signal) {
    signal.removeEventListener("abort", cb);
  }
}

/** Offset of the body start in a dataBuf (past header + uncompressed section). */
function bodyStart(buf: Buffer): number {
  const uic = buf.readUInt32LE(H_UNCOMPRESSED_PAYLOAD_ITEM_COUNT);
  const upl = buf.readUInt32LE(H_UNCOMPRESSED_PAYLOADS_LEN);
  return HEADER_SIZE + uic * 4 + upl;
}

/** Decode relative file paths from a dataBuf. */
export function decodeFilePathsFromBuf(buf: Buffer): string[] {
  const fc = buf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
  if (fc <= 0 || pathsLen <= 0) {
    return [];
  }
  const compItemCount = buf.readUInt32LE(H_COMPRESSED_PAYLOAD_ITEM_COUNT);
  const pathEndsStart = bodyStart(buf) + fc * ENTRY_STRIDE + compItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
  const result: string[] = new Array(fc);
  let prevEnd = 0;
  for (let i = 0; i < fc; i++) {
    const raw = buf.readUInt32LE(pathEndsStart + i * 4);
    // Clamp non-monotonic or out-of-range ends (defense-in-depth vs corrupt cache).
    const clampedEnd = raw > pathsLen ? pathsLen : raw < prevEnd ? prevEnd : raw;
    result[i] = buf.toString("utf8", pathsStart + prevEnd, pathsStart + clampedEnd);
    prevEnd = clampedEnd;
  }
  return result;
}

/** Convert an array of relative paths to absolute by prepending rootPath. */
export function toAbsolutePaths(rootPath: string, relativePaths: readonly string[]): string[] {
  const n = relativePaths.length;
  const result = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    result[i] = rootPath + relativePaths[i];
  }
  return result;
}

/**
 * Extract NUL-separated encoded paths directly from a dataBuf (raw byte copy).
 * Produces the same format as encodeNormalizedPaths(): "path0\0path1\0...pathN\0".
 */
export function extractEncodedPaths(buf: Buffer, fc: number): Buffer {
  const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
  if (fc <= 0 || pathsLen <= 0) {
    return emptyBuf();
  }
  const compItemCount = buf.readUInt32LE(H_COMPRESSED_PAYLOAD_ITEM_COUNT);
  const pathEndsStart = bodyStart(buf) + fc * ENTRY_STRIDE + compItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
  const encoded = Buffer.allocUnsafe(pathsLen + fc);
  let prevEnd = 0;
  let w = 0;
  for (let i = 0; i < fc; i++) {
    const raw = buf.readUInt32LE(pathEndsStart + i * 4);
    // Clamp non-monotonic or out-of-range ends (defense-in-depth vs corrupt cache).
    const clampedEnd = raw > pathsLen ? pathsLen : raw < prevEnd ? prevEnd : raw;
    const segLen = clampedEnd - prevEnd;
    if (segLen > 0) {
      buf.copy(encoded, w, pathsStart + prevEnd, pathsStart + clampedEnd);
      w += segLen;
    }
    encoded[w++] = 0;
    prevEnd = clampedEnd;
  }
  return w === encoded.length ? encoded : encoded.subarray(0, w);
}

/** Decode file path strings from NUL-separated encoded paths buffer. */
export function decodeEncodedPaths(encoded: Buffer, fc: number): string[] {
  if (fc <= 0 || encoded.length === 0) {
    return [];
  }
  const result: string[] = new Array(fc);
  const len = encoded.length;
  let start = 0;
  for (let i = 0; i < fc; i++) {
    // Buffer.indexOf is a native C++ memchr scan — much faster than a JS loop.
    let end = encoded.indexOf(0, start);
    if (end < 0) {
      end = len;
    }
    result[i] = encoded.toString("utf8", start, end);
    start = end + 1;
  }
  return result;
}

/** Read compressed payload buffers from a dataBuf. Returns zero-copy slices. */
export function readCompressedPayloads(dataBuf: Buffer): readonly Buffer[] {
  const fc = dataBuf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = dataBuf.readUInt32LE(H_PATHS_LEN);
  const compPayloadsLen = dataBuf.readUInt32LE(H_COMPRESSED_PAYLOADS_LEN);
  const compItemCount = dataBuf.readUInt32LE(H_COMPRESSED_PAYLOAD_ITEM_COUNT);
  if (compItemCount <= 0) {
    return [];
  }
  const compDirStart = bodyStart(dataBuf) + fc * ENTRY_STRIDE;
  const pathEndsStart = compDirStart + compItemCount * 4;
  const compPayloadsStart = pathEndsStart + fc * 4 + pathsLen;
  if (compPayloadsStart + compPayloadsLen > dataBuf.length) {
    return [];
  }
  const result: Buffer[] = new Array(compItemCount);
  let prevEnd = 0;
  for (let i = 0; i < compItemCount; i++) {
    const raw = dataBuf.readUInt32LE(compDirStart + i * 4);
    // Clamp non-monotonic or out-of-range ends (defense-in-depth vs corrupt cache).
    const end = raw > compPayloadsLen ? compPayloadsLen : raw < prevEnd ? prevEnd : raw;
    if (end === prevEnd) {
      result[i] = emptyBuf();
    } else {
      result[i] = dataBuf.subarray(compPayloadsStart + prevEnd, compPayloadsStart + end);
    }
    prevEnd = end;
  }
  return result;
}

/** Read uncompressed payload buffers from a dataBuf. Returns zero-copy slices. */
export function readUncompressedPayloads(dataBuf: Buffer): readonly Buffer[] {
  const uncItemCount = dataBuf.readUInt32LE(H_UNCOMPRESSED_PAYLOAD_ITEM_COUNT);
  if (uncItemCount <= 0) {
    return [];
  }
  const uncPayloadsLen = dataBuf.readUInt32LE(H_UNCOMPRESSED_PAYLOADS_LEN);
  const uncDirStart = HEADER_SIZE;
  const uncPayloadsStart = uncDirStart + uncItemCount * 4;
  if (uncPayloadsStart + uncPayloadsLen > dataBuf.length) {
    return [];
  }
  const result: Buffer[] = new Array(uncItemCount);
  let prevEnd = 0;
  for (let i = 0; i < uncItemCount; i++) {
    const raw = dataBuf.readUInt32LE(uncDirStart + i * 4);
    // Clamp non-monotonic or out-of-range ends (defense-in-depth vs corrupt cache).
    const end = raw > uncPayloadsLen ? uncPayloadsLen : raw < prevEnd ? prevEnd : raw;
    if (end === prevEnd) {
      result[i] = emptyBuf();
    } else {
      result[i] = dataBuf.subarray(uncPayloadsStart + prevEnd, uncPayloadsStart + end);
    }
    prevEnd = end;
  }
  return result;
}
