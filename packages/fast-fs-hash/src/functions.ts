/**
 * Public utility functions for fast-fs-hash.
 *
 * Encoding/decoding file paths for the null-separated buffer format,
 * and splitting concatenated hash buffers into hex strings.
 *
 * @module
 */

import { bufferAlloc, bufferAllocUnsafe, bufferByteLength, bufferFrom, isBuffer } from "./helpers";

// ── File path encoding / decoding ────────────────────────────────────────

/**
 * Encode an array of file paths into a null-separated buffer.
 *
 * Each path is UTF-8 encoded, terminated by a single `\0` byte.
 * Paths that contain `\0` characters are replaced with empty strings
 * (just a `\0` separator) since null bytes are illegal in file paths
 * on all platforms (POSIX and Windows).
 *
 * Two-pass for minimal allocation: first computes total length,
 * then writes everything into a single pre-allocated buffer.
 */
export function encodeFilePaths(paths: string[]): Buffer {
  const n = paths.length;
  if (n === 0) {
    return bufferAlloc(0);
  }

  // Pass 1: compute total byte length.
  let totalLen = 0;
  let firstNullAt = -1;
  for (let i = 0; i < n; i++) {
    const p = paths[i];
    if (p.length > 0) {
      if (p.indexOf("\0") !== -1) {
        if (firstNullAt < 0) {
          firstNullAt = i;
        }
      } else {
        totalLen += bufferByteLength(p, "utf-8");
      }
    }
    totalLen++; // \0 separator
  }

  // Pass 2: write into single buffer
  const out = bufferAllocUnsafe(totalLen);
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const p = paths[i];
    if (p.length > 0 && (firstNullAt < 0 || i < firstNullAt || p.indexOf("\0") === -1)) {
      offset += out.write(p, offset, "utf-8");
    }
    out[offset++] = 0;
  }

  return out;
}

/**
 * Decode a null-separated path buffer into an array of strings.
 *
 * Each `\0` byte is a path separator. Empty segments (consecutive `\0`
 * bytes or leading `\0`) are preserved as empty strings — the C++ engine
 * treats them as non-existent files (zero hash).
 *
 * A trailing `\0` after the last path is optional (stripped if present).
 */
export function decodeFilePaths(buf: Uint8Array): string[] {
  const len = buf.length;
  if (len === 0) {
    return [];
  }

  const paths: string[] = [];
  let segStart = 0;

  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) {
      if (i > segStart) {
        paths.push(bufferFrom(buf.buffer, buf.byteOffset + segStart, i - segStart).toString("utf-8"));
      } else {
        paths.push("");
      }
      segStart = i + 1;
    }
  }
  // Trailing segment (no final \0)
  if (segStart < len) {
    paths.push(bufferFrom(buf.buffer, buf.byteOffset + segStart, len - segStart).toString("utf-8"));
  }
  return paths;
}

// ── Hash buffer utilities ────────────────────────────────────────────────

/**
 * Split a buffer of concatenated 16-byte hashes into an array of hex strings.
 *
 * @param hashes A `Uint8Array` or `Buffer` whose length is a multiple of 16.
 * @returns Array of lowercase hex strings, one per 16-byte hash.
 */
export function hashesToHexArray(hashes: Uint8Array): string[] {
  const len = hashes.length;
  const count = len >>> 4; // len / 16
  const result = new Array<string>(count);
  const buf = isBuffer(hashes) ? hashes : bufferFrom(hashes.buffer, hashes.byteOffset, hashes.byteLength);
  for (let i = 0; i < count; i++) {
    result[i] = buf.subarray(i * 16, i * 16 + 16).toString("hex");
  }
  return result;
}
