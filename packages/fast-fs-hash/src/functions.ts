import { bufferAlloc, bufferAllocUnsafe, bufferFrom } from "./helpers";

/** The size of a 128 bit hash in bytes. */
export const HASH_SIZE = 16;

/**
 * Encode an array of file paths into a null-separated buffer.
 *
 * Each path is UTF-8 encoded, terminated by a single `\0` byte.
 * Paths that contain `\0` characters are replaced with empty strings
 * (just a `\0` separator) since null bytes are illegal in file paths
 * on all platforms (POSIX and Windows).
 *
 * Single-pass: allocates an upper-bound buffer (string.length × 3 + 1
 * per path — safe UTF-8 maximum), writes each path once, then returns
 * the used portion via subarray.  Avoids the double-encode of the old
 * two-pass approach (bufferByteLength + write).
 */
export function encodeFilePaths(paths: Iterable<string>): Buffer {
  const arr = Array.isArray(paths) ? paths : Array.from(paths);
  const n = arr.length;
  if (n === 0) {
    return bufferAlloc(0);
  }

  // Compute upper-bound: each char can expand to at most 3 UTF-8 bytes,
  // plus one \0 separator per path.
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

/**
 * Iterate file paths from a null-terminated buffer without allocating an array.
 *
 * Same semantics as {@link decodeFilePaths} — each `\0` byte terminates a path,
 * empty segments are yielded as empty strings — but yields one path at a time
 * so the caller never holds all strings at once.
 *
 * Trailing bytes after the last `\0` are silently dropped
 * (matching C++ PathIndex behaviour).
 */
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
    if (end > segStart) {
      yield view.toString("utf-8", segStart, end);
    } else {
      yield "";
    }
    segStart = end + 1;
  }
  // Trailing bytes without a final \0 are silently dropped (C++ PathIndex compat).
}

/**
 * Decode a null-terminated path buffer into an array of strings.
 *
 * Each `\0` byte terminates a path. Empty segments (consecutive `\0`
 * bytes or leading `\0`) are preserved as empty strings — the C++ engine
 * treats them as non-existent files (zero hash).
 *
 * Trailing bytes after the last `\0` are silently dropped
 * (matching C++ PathIndex behaviour).
 */
export function decodeFilePaths(buf: Uint8Array): string[] {
  const len = buf.length;
  if (len === 0) {
    return [];
  }

  const view = bufferFrom(buf.buffer, buf.byteOffset, len);

  const paths: string[] = [];
  for (let segStart = 0; segStart < len; ) {
    const end = view.indexOf(0, segStart);
    if (end === -1) {
      break;
    }
    if (end > segStart) {
      paths.push(view.toString("utf-8", segStart, end));
    } else {
      paths.push("");
    }
    segStart = end + 1;
  }
  // Trailing bytes without a final \0 are silently dropped (C++ PathIndex compat).
  return paths;
}

/** Nibble (0-15) -> ASCII char code for '0'-'9' / 'a'-'f'. Inlined by TurboFan. */
const _nib = (n: number): number => n + (n < 10 ? 48 : 87);

/** Captured once to avoid `String` global + `fromCharCode` property lookups. */
const _fromCharCode = String.fromCharCode;

/**
 * Split a buffer of concatenated 16-byte hashes into an array of hex strings.
 *
 * Reads 16 bytes into locals, then passes 32 nibble->char-code expressions to a
 * single `String.fromCharCode` call — one allocation per string, no rope chains,
 * no scratch buffers, no lookup tables.
 *
 * @param hashes A `Uint8Array` or `Buffer` whose length is a multiple of 16.
 * @returns Array of lowercase hex strings, one per 16-byte hash.
 */
export function hashesToHexArray(hashes: Uint8Array): string[] {
  const len = hashes.length;
  if ((len & (HASH_SIZE - 1)) !== 0) {
    throw new RangeError("hashesToHexArray: input length must be a multiple of 16 bytes");
  }
  const count = len >>> 4; // len / 16
  const result = new Array<string>(count);
  for (let off = 0, ri = 0; off < len; off += HASH_SIZE) {
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
 * nibble->char-code expressions to one `String.fromCharCode` call.
 *
 * @param hash A `Uint8Array` or `Buffer` of at least `offset + 16` bytes.
 * @param offset Byte offset to start reading from (default `0`).
 * @returns 32-character lowercase hex string.
 */
export function hashToHex(hash: Uint8Array, offset = 0): string {
  if (!Number.isInteger(offset) || offset < 0 || offset + HASH_SIZE > hash.length) {
    throw new RangeError("hashToHex: offset must reference at least 16 available bytes");
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
