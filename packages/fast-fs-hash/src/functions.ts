/**
 * Public utility functions for fast-fs-hash.
 *
 * Encoding/decoding file paths for the null-separated buffer format,
 * and splitting concatenated hash buffers into hex strings.
 *
 * @module
 */

import { bufferAlloc, bufferAllocUnsafe, bufferByteLength, bufferFrom } from "./helpers";

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
export function encodeFilePaths(paths: Iterable<string>): Buffer {
  const arr = Array.isArray(paths) ? paths : Array.from(paths);
  const n = arr.length;
  if (n === 0) {
    return bufferAlloc(0);
  }

  // Pass 1: compute total byte length.
  let totalLen = 0;
  let firstNullAt = -1;
  for (let i = 0; i < n; i++) {
    const p = arr[i];
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
    const p = arr[i];
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

// Pre-computed hex lookup table (0x00–0xff → "00"–"ff").
const HEX_TABLE: string[] = new Array<string>(256);
for (let i = 0; i < 256; i++) {
  HEX_TABLE[i] = (i < 16 ? "0" : "") + i.toString(16);
}

/**
 * Split a buffer of concatenated 16-byte hashes into an array of hex strings.
 *
 * Uses a pre-computed lookup table for direct byte→hex conversion,
 * avoiding Buffer.toString("hex") overhead and subarray allocation per hash.
 *
 * @param hashes A `Uint8Array` or `Buffer` whose length is a multiple of 16.
 * @returns Array of lowercase hex strings, one per 16-byte hash.
 */
export function hashesToHexArray(hashes: Uint8Array): string[] {
  const len = hashes.length;
  const count = len >>> 4; // len / 16
  const result = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const off = i << 4;
    result[i] =
      HEX_TABLE[hashes[off]] +
      HEX_TABLE[hashes[off + 1]] +
      HEX_TABLE[hashes[off + 2]] +
      HEX_TABLE[hashes[off + 3]] +
      HEX_TABLE[hashes[off + 4]] +
      HEX_TABLE[hashes[off + 5]] +
      HEX_TABLE[hashes[off + 6]] +
      HEX_TABLE[hashes[off + 7]] +
      HEX_TABLE[hashes[off + 8]] +
      HEX_TABLE[hashes[off + 9]] +
      HEX_TABLE[hashes[off + 10]] +
      HEX_TABLE[hashes[off + 11]] +
      HEX_TABLE[hashes[off + 12]] +
      HEX_TABLE[hashes[off + 13]] +
      HEX_TABLE[hashes[off + 14]] +
      HEX_TABLE[hashes[off + 15]];
  }
  return result;
}
