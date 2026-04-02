/**
 * Internal helpers and hash utility functions.
 *
 * @module
 * @internal
 */

export const { from: bufferFrom, allocUnsafe: bufferAllocUnsafe, isBuffer } = Buffer;

/** Clamp concurrency to [1..8], defaulting 0 to 8, and cap at fileCount. */
export function effectiveConcurrency(fileCount: number, concurrency: number): number {
  const c = concurrency > 0 && concurrency <= 8 ? concurrency : 8;
  return Math.min(c, fileCount);
}

/**
 * Encode an array of file paths into a null-separated buffer.
 *
 * Each path is UTF-8 encoded, terminated by a single `\0` byte.
 * Paths that contain `\0` characters are replaced with empty strings
 * (just a `\0` separator) since null bytes are illegal in file paths
 * on all platforms (POSIX and Windows).
 */
export function encodeFilePaths(paths: Iterable<string>): Buffer {
  const arr = Array.isArray(paths) ? paths : Array.from(paths);
  const n = arr.length;
  if (n === 0) {
    return Buffer.alloc(0);
  }

  let totalChars = 0;
  for (let i = 0; i < n; i++) {
    totalChars += arr[i].length;
  }
  const out = bufferAllocUnsafe(totalChars * 3 + n);
  let offset = 0;

  for (let i = 0; i < n; i++) {
    const p = arr[i];
    if (p.length > 0 && p.indexOf("\0") === -1) {
      offset += out.write(p, offset, "utf-8");
    }
    out[offset++] = 0;
  }

  return out.subarray(0, offset);
}

/** Iterate file paths from a null-terminated buffer without allocating an array. */
export function* iterateFilePaths(buf: Uint8Array): Generator<string, void, undefined> {
  const len = buf.length;
  if (len === 0) {
    return;
  }
  const view = bufferFrom(buf.buffer, buf.byteOffset, len);
  for (let segStart = 0; segStart < len; ) {
    const end = view.indexOf(0, segStart);
    if (end === -1) {
      break;
    }
    yield end > segStart ? view.toString("utf-8", segStart, end) : "";
    segStart = end + 1;
  }
}

/** Decode a null-terminated path buffer into an array of strings. */
export function decodeFilePaths(buf: Uint8Array): string[] {
  const len = buf.length;
  if (len === 0) {
    return [];
  }
  const view = isBuffer(buf) ? buf : bufferFrom(buf.buffer, buf.byteOffset, len);
  const paths: string[] = [];
  for (let segStart = 0; segStart < len; ) {
    const end = view.indexOf(0, segStart);
    if (end === -1) {
      break;
    }
    paths.push(end > segStart ? view.toString("utf-8", segStart, end) : "");
    segStart = end + 1;
  }
  return paths;
}

/** Nibble (0-15) -> ASCII char code for '0'-'9' / 'a'-'f'. Inlined by TurboFan. */
const _nib = (n: number): number => n + (n < 10 ? 48 : 87);

/** Captured once to avoid `String` global + `fromCharCode` property lookups. */
const _fromCharCode = String.fromCharCode;

/**
 * Split a buffer of concatenated 16-byte hashes into an array of hex strings.
 * Returns an empty array if input is null/undefined or length is not a multiple of 16.
 * @param hashes Buffer of concatenated 16-byte hashes.
 */
export function hashesToHexArray(hashes: Uint8Array): string[] {
  if (!hashes) {
    return [];
  }
  const len = hashes.length;
  if ((len & 15) !== 0) {
    return [];
  }
  const count = len >>> 4;
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
 * Returns an empty string if input is null/undefined or too short.
 * @param hash 16-byte hash digest.
 * @param offset Byte offset into `hash`. Default 0.
 */
export function hashToHex(hash: Uint8Array, offset = 0): string {
  if (!hash || offset < 0 || offset + 16 > hash.length) {
    return "";
  }
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
