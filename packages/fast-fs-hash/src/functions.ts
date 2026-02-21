/**
 * Public utility functions for fast-fs-hash.
 *
 * Encoding/decoding file paths for the null-separated buffer format,
 * and splitting concatenated hash buffers into hex strings.
 *
 * @module
 */

import { bufferAlloc, bufferAllocUnsafe, bufferByteLength, bufferFrom } from "./helpers";

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
 * Iterate file paths from a null-separated buffer without allocating an array.
 *
 * Same semantics as {@link decodeFilePaths} — each `\0` byte is a separator,
 * empty segments are yielded as empty strings, a trailing `\0` is stripped —
 * but yields one path at a time so the caller never holds all strings at once.
 */
export function* iterateFilePaths(buf: Uint8Array): Generator<string, void, undefined> {
  const len = buf.length;
  if (len === 0) {
    return;
  }

  let segStart = 0;

  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) {
      if (i > segStart) {
        yield bufferFrom(buf.buffer, buf.byteOffset + segStart, i - segStart).toString("utf-8");
      } else {
        yield "";
      }
      segStart = i + 1;
    }
  }
  // Trailing segment (no final \0)
  if (segStart < len) {
    yield bufferFrom(buf.buffer, buf.byteOffset + segStart, len - segStart).toString("utf-8");
  }
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

/** Nibble (0–15) → ASCII char code for '0'–'9' / 'a'–'f'. Inlined by TurboFan. */
const _nib = (n: number): number => n + (n < 10 ? 48 : 87);

/** Captured once to avoid `String` global + `fromCharCode` property lookups. */
const _fromCharCode = String.fromCharCode;

/**
 * Split a buffer of concatenated 16-byte hashes into an array of hex strings.
 *
 * Reads 16 bytes into locals, then passes 32 nibble→char-code expressions to a
 * single `String.fromCharCode` call — one allocation per string, no rope chains,
 * no scratch buffers, no lookup tables.
 *
 * @param hashes A `Uint8Array` or `Buffer` whose length is a multiple of 16.
 * @returns Array of lowercase hex strings, one per 16-byte hash.
 */
export function hashesToHexArray(hashes: Uint8Array): string[] {
  const len = hashes.length;
  const count = len >>> 4; // len / 16
  const result = new Array<string>(count);
  for (let off = 0, ri = 0; off < len; off += 16) {
    const b0 = hashes[off];
    const b1 = hashes[off + 1];
    const b2 = hashes[off + 2];
    const b3 = hashes[off + 3];
    const b4 = hashes[off + 4];
    const b5 = hashes[off + 5];
    const b6 = hashes[off + 6];
    const b7 = hashes[off + 7];
    const b8 = hashes[off + 8];
    const b9 = hashes[off + 9];
    const b10 = hashes[off + 10];
    const b11 = hashes[off + 11];
    const b12 = hashes[off + 12];
    const b13 = hashes[off + 13];
    const b14 = hashes[off + 14];
    const b15 = hashes[off + 15];
    result[ri++] = _fromCharCode(
      _nib(b0 >>> 4),
      _nib(b0 & 0xf),
      _nib(b1 >>> 4),
      _nib(b1 & 0xf),
      _nib(b2 >>> 4),
      _nib(b2 & 0xf),
      _nib(b3 >>> 4),
      _nib(b3 & 0xf),
      _nib(b4 >>> 4),
      _nib(b4 & 0xf),
      _nib(b5 >>> 4),
      _nib(b5 & 0xf),
      _nib(b6 >>> 4),
      _nib(b6 & 0xf),
      _nib(b7 >>> 4),
      _nib(b7 & 0xf),
      _nib(b8 >>> 4),
      _nib(b8 & 0xf),
      _nib(b9 >>> 4),
      _nib(b9 & 0xf),
      _nib(b10 >>> 4),
      _nib(b10 & 0xf),
      _nib(b11 >>> 4),
      _nib(b11 & 0xf),
      _nib(b12 >>> 4),
      _nib(b12 & 0xf),
      _nib(b13 >>> 4),
      _nib(b13 & 0xf),
      _nib(b14 >>> 4),
      _nib(b14 & 0xf),
      _nib(b15 >>> 4),
      _nib(b15 & 0xf)
    );
  }
  return result;
}

/**
 * Convert a single 16-byte hash to a 32-character lowercase hex string.
 *
 * Same approach as `hashesToHexArray` — reads 16 bytes, passes 32
 * nibble→char-code expressions to one `String.fromCharCode` call.
 *
 * @param hash A `Uint8Array` or `Buffer` of at least `offset + 16` bytes.
 * @param offset Byte offset to start reading from (default `0`).
 * @returns 32-character lowercase hex string.
 */
export function hashToHex(hash: Uint8Array, offset = 0): string {
  const b0 = hash[offset];
  const b1 = hash[offset + 1];
  const b2 = hash[offset + 2];
  const b3 = hash[offset + 3];
  const b4 = hash[offset + 4];
  const b5 = hash[offset + 5];
  const b6 = hash[offset + 6];
  const b7 = hash[offset + 7];
  const b8 = hash[offset + 8];
  const b9 = hash[offset + 9];
  const b10 = hash[offset + 10];
  const b11 = hash[offset + 11];
  const b12 = hash[offset + 12];
  const b13 = hash[offset + 13];
  const b14 = hash[offset + 14];
  const b15 = hash[offset + 15];
  return _fromCharCode(
    _nib(b0 >>> 4),
    _nib(b0 & 0xf),
    _nib(b1 >>> 4),
    _nib(b1 & 0xf),
    _nib(b2 >>> 4),
    _nib(b2 & 0xf),
    _nib(b3 >>> 4),
    _nib(b3 & 0xf),
    _nib(b4 >>> 4),
    _nib(b4 & 0xf),
    _nib(b5 >>> 4),
    _nib(b5 & 0xf),
    _nib(b6 >>> 4),
    _nib(b6 & 0xf),
    _nib(b7 >>> 4),
    _nib(b7 & 0xf),
    _nib(b8 >>> 4),
    _nib(b8 & 0xf),
    _nib(b9 >>> 4),
    _nib(b9 & 0xf),
    _nib(b10 >>> 4),
    _nib(b10 & 0xf),
    _nib(b11 >>> 4),
    _nib(b11 & 0xf),
    _nib(b12 >>> 4),
    _nib(b12 & 0xf),
    _nib(b13 >>> 4),
    _nib(b13 & 0xf),
    _nib(b14 >>> 4),
    _nib(b14 & 0xf),
    _nib(b15 >>> 4),
    _nib(b15 & 0xf)
  );
}
