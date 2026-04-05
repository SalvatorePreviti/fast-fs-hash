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
  H_FILE_COUNT,
  H_PATHS_LEN,
  H_UD_ITEM_COUNT,
  H_UD_PAYLOADS_LEN,
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

// ── Cancel helpers ──────────────────────────────────────────────────

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

// ── dataBuf helpers ─────────────────────────────────────────────────

/** Decode relative file paths from a dataBuf. */
export function decodeFilePathsFromBuf(buf: Buffer): string[] {
  const fc = buf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = buf.readUInt32LE(H_PATHS_LEN);
  if (fc <= 0 || pathsLen <= 0) {
    return [];
  }
  const udItemCount = buf.readUInt32LE(H_UD_ITEM_COUNT);
  const pathEndsStart = HEADER_SIZE + fc * ENTRY_STRIDE + udItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
  const result: string[] = new Array(fc);
  let prevEnd = 0;
  for (let i = 0; i < fc; i++) {
    const end = buf.readUInt32LE(pathEndsStart + i * 4);
    const clampedEnd = end > pathsLen ? pathsLen : end;
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
  const udItemCount = buf.readUInt32LE(H_UD_ITEM_COUNT);
  const pathEndsStart = HEADER_SIZE + fc * ENTRY_STRIDE + udItemCount * 4;
  const pathsStart = pathEndsStart + fc * 4;
  const encoded = Buffer.allocUnsafe(pathsLen + fc);
  let prevEnd = 0;
  let w = 0;
  for (let i = 0; i < fc; i++) {
    const end = buf.readUInt32LE(pathEndsStart + i * 4);
    const clampedEnd = end > pathsLen ? pathsLen : end;
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
  let start = 0;
  for (let i = 0; i < fc; i++) {
    let end = start;
    while (end < encoded.length && encoded[end] !== 0) {
      end++;
    }
    result[i] = encoded.toString("utf8", start, end);
    start = end + 1;
  }
  return result;
}

/** Read payload data buffers from a dataBuf. Returns zero-copy slices. */
export function readPayloadData(dataBuf: Buffer): readonly Buffer[] {
  const fc = dataBuf.readUInt32LE(H_FILE_COUNT);
  const pathsLen = dataBuf.readUInt32LE(H_PATHS_LEN);
  const udPayloadsLen = dataBuf.readUInt32LE(H_UD_PAYLOADS_LEN);
  const udItemCount = dataBuf.readUInt32LE(H_UD_ITEM_COUNT);
  if (udItemCount <= 0) {
    return [];
  }
  const udDirStart = HEADER_SIZE + fc * ENTRY_STRIDE;
  const pathEndsStart = udDirStart + udItemCount * 4;
  const udPayloadsStart = pathEndsStart + fc * 4 + pathsLen;
  if (udPayloadsStart + udPayloadsLen > dataBuf.length) {
    return [];
  }
  const result: Buffer[] = new Array(udItemCount);
  let prevEnd = 0;
  for (let i = 0; i < udItemCount; i++) {
    const end = dataBuf.readUInt32LE(udDirStart + i * 4);
    const size = end - prevEnd;
    if (size <= 0) {
      result[i] = emptyBuf();
    } else {
      result[i] = dataBuf.subarray(udPayloadsStart + prevEnd, udPayloadsStart + end);
    }
    prevEnd = end;
  }
  return result;
}
