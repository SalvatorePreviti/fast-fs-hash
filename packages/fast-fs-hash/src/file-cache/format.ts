/**
 * Binary format v6 — constants, header parsing, entry/path/item
 * serialization and deserialization, stat helpers.
 *
 * ### Binary layout
 *
 * ```
 * Header (64 bytes, cache-line aligned):
 *   [0..3]   Magic (u32 LE): 0x06485346 — bytes 'F','S','H', 0x06
 *   [4..6]   User version (u24 LE): 0–16 777 215
 *   [7]      Flags (u8): reserved, must be 0
 *   [8..11]  Entry count (u32 LE)
 *   [12..27] Aggregate digest (16 bytes xxHash3-128)
 *   [28..43] Fingerprint (16 bytes xxHash3-128)
 *   [44..47] Paths section byte length (u32 LE)
 *   [48..51] Raw data section byte length (u32 LE)
 *   [52..55] Gzip data section byte length (u32 LE, compressed on disk)
 *   [56..59] Gzip uncompressed byte length (u32 LE)
 *   [60..61] Raw item count (u16 LE)
 *   [62..63] Gzip item count (u16 LE)
 *
 * Section offsets (all computable from header fields — O(1)):
 *   Entries:   64
 *   Paths:     64 + entryCount × 40
 *   Raw data:  64 + entryCount × 40 + pathsLen
 *   Gzip data: 64 + entryCount × 40 + pathsLen + rawDataLen
 *
 * Entries section (fixed stride, entryCount × 40 bytes):
 *   Per entry (40 bytes):
 *     [0..7]   stat.ino (f64 LE)
 *     [8..15]  stat.mtimeMs (f64 LE)
 *     [16..23] stat.size (f64 LE)
 *     [24..39] Content hash (16 bytes xxHash3-128)
 *
 * Paths section (null-separated UTF-8, byte length in header [44..47]):
 *   Each path is terminated by \0.  Count must equal entryCount.
 *
 * Raw data section (uncompressed, byte length in header [48..51]):
 *   Per item:
 *     [0]     Type tag (u8): 0=buffer, 1=string, 2=json, 3=null, 4=undefined
 *     [1..4]  Byte length (u32 LE)
 *     [5..]   Payload bytes
 *
 * Gzip data section (compressed blob, byte length in header [52..55]):
 *   Gzip-compressed blob.  After inflation the payload uses the same
 *   per-item layout as the raw section.
 * ```
 *
 * @module
 * @internal
 */

import type { FileHandle } from "node:fs/promises";
import { stat as fsStat } from "node:fs/promises";
import { bufferAlloc, bufferAllocUnsafe, bufferFrom } from "../helpers";
import type { FileHashCacheDataValue } from "./types";

// ── Constants ────────────────────────────────────────────────────────────

/** Binary format magic: bytes 'F','S','H', 0x06 → 0x06485346 (u32 LE). */
export const MAGIC = 0x06485346;

/** Fixed header size in bytes (one cache line). */
export const HEADER_SIZE = 64;

/** Fixed byte size of each file entry (3×f64 + 16-byte hash). */
export const ENTRY_STRIDE = 40;

/** Default stat() concurrency limit. */
export const STAT_CONCURRENCY = 64;

/** Data type tags. */
export const T_BUFFER = 0;
export const T_STRING = 1;
export const T_JSON = 2;
export const T_NULL = 3;
export const T_UNDEFINED = 4;

/** Reusable empty Uint8Array. */
export const EMPTY = new Uint8Array(0);

// ── Internal types ───────────────────────────────────────────────────────

export interface CacheEntry {
  ino: number;
  mtimeMs: number;
  size: number;
  hash: Uint8Array;
}

export interface ParsedHeader {
  version: number;
  entryCount: number;
  digest: Buffer;
  fingerprint: Buffer;
  pathsLen: number;
  rawDataLen: number;
  gzipDataLen: number;
  gzipUncompLen: number;
  rawItemCount: number;
  gzipItemCount: number;
}

export interface StatResult {
  ino: number;
  mtimeMs: number;
  size: number;
}

// ── Header parsing ───────────────────────────────────────────────────────

/** Parse the 64-byte header.  Returns `null` on bad magic or insufficient length. */
export function parseHeader(buf: Uint8Array): ParsedHeader | null {
  if (buf.length < HEADER_SIZE) {
    return null;
  }
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0, true) !== MAGIC) {
    return null;
  }
  return {
    version: buf[4] | (buf[5] << 8) | (buf[6] << 16),
    entryCount: v.getUint32(8, true),
    digest: Buffer.from(buf.buffer, buf.byteOffset + 12, 16),
    fingerprint: Buffer.from(buf.buffer, buf.byteOffset + 28, 16),
    pathsLen: v.getUint32(44, true),
    rawDataLen: v.getUint32(48, true),
    gzipDataLen: v.getUint32(52, true),
    gzipUncompLen: v.getUint32(56, true),
    rawItemCount: v.getUint16(60, true),
    gzipItemCount: v.getUint16(62, true),
  };
}

/** Read and parse header from an open file handle. */
export async function readFhHeader(fh: FileHandle): Promise<ParsedHeader | null> {
  const buf = bufferAllocUnsafe(HEADER_SIZE);
  const { bytesRead } = await fh.read(buf, 0, HEADER_SIZE, 0);
  if (bytesRead < HEADER_SIZE) {
    return null;
  }
  return parseHeader(buf);
}

// ── Section offsets ──────────────────────────────────────────────────────

/** Byte offset of the entries section (always 64). */
export function entriesOffset(): number {
  return HEADER_SIZE;
}

/** Byte offset of the paths section. */
export function pathsOffset(entryCount: number): number {
  return HEADER_SIZE + entryCount * ENTRY_STRIDE;
}

/** Byte offset of the raw data section. */
export function rawDataOffset(entryCount: number, pathsLen: number): number {
  return HEADER_SIZE + entryCount * ENTRY_STRIDE + pathsLen;
}

/** Byte offset of the gzip data section. */
export function gzipDataOffset(entryCount: number, pathsLen: number, rawDataLen: number): number {
  return HEADER_SIZE + entryCount * ENTRY_STRIDE + pathsLen + rawDataLen;
}

// ── Entry parsing ────────────────────────────────────────────────────────

/** Parse fixed-stride entries into a map keyed by path index. */
export function parseEntriesArray(buf: Uint8Array, offset: number, count: number): CacheEntry[] {
  const entries: CacheEntry[] = new Array(count);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = offset;

  for (let i = 0; i < count; i++) {
    entries[i] = {
      ino: v.getFloat64(off, true),
      mtimeMs: v.getFloat64(off + 8, true),
      size: v.getFloat64(off + 16, true),
      hash: Buffer.from(buf.subarray(off + 24, off + 40)),
    };
    off += ENTRY_STRIDE;
  }

  return entries;
}

// ── Paths parsing ────────────────────────────────────────────────────────

/** Parse null-separated paths section into an array. */
export function parsePaths(buf: Uint8Array, offset: number, length: number): string[] {
  if (length === 0) {
    return [];
  }
  const paths: string[] = [];
  const end = offset + length;
  let segStart = offset;

  for (let i = offset; i < end; i++) {
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
  if (segStart < end) {
    paths.push(bufferFrom(buf.buffer, buf.byteOffset + segStart, end - segStart).toString("utf-8"));
  }

  return paths;
}

/** Serialize an array of paths into a null-separated buffer. */
export function serializePaths(paths: string[]): Buffer {
  const n = paths.length;
  if (n === 0) {
    return bufferAlloc(0);
  }

  const bufs: Buffer[] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    bufs[i] = bufferFrom(paths[i], "utf-8");
    total += bufs[i].length + 1; // +1 for \0
  }

  const out = bufferAllocUnsafe(total);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const b = bufs[i];
    if (b.length > 0) {
      out.set(b, off);
      off += b.length;
    }
    out[off++] = 0;
  }
  return out;
}

// ── Entry / path map building ────────────────────────────────────────────

/** Build a path→entry map from parallel arrays. */
export function buildEntryMap(paths: string[], entries: CacheEntry[]): Map<string, CacheEntry> {
  const map = new Map<string, CacheEntry>();
  for (let i = 0; i < paths.length; i++) {
    map.set(paths[i], entries[i]);
  }
  return map;
}

// ── Full cache serialization ─────────────────────────────────────────────

/**
 * Serialize a complete cache buffer:
 * header + entries + paths + rawBlob + gzipBlob.
 */
export function serializeCache(
  paths: string[],
  entries: CacheEntry[],
  version: number,
  fingerprint: Buffer,
  digest: Buffer,
  rawBlob: Uint8Array,
  gzipBlob: Uint8Array,
  gzipUncompLen: number,
  rawItemCount: number,
  gzipItemCount: number
): Buffer {
  const n = paths.length;
  const pathsBuf = serializePaths(paths);
  const entriesLen = n * ENTRY_STRIDE;
  const total = HEADER_SIZE + entriesLen + pathsBuf.length + rawBlob.length + gzipBlob.length;
  const buf = bufferAlloc(total); // zero-filled
  const v = new DataView(buf.buffer, buf.byteOffset, total);

  // Header.
  v.setUint32(0, MAGIC, true);
  buf[4] = version & 0xff;
  buf[5] = (version >>> 8) & 0xff;
  buf[6] = (version >>> 16) & 0xff;
  v.setUint32(8, n, true);
  buf.set(digest, 12);
  buf.set(fingerprint, 28);
  v.setUint32(44, pathsBuf.length, true);
  v.setUint32(48, rawBlob.length, true);
  v.setUint32(52, gzipBlob.length, true);
  v.setUint32(56, gzipUncompLen, true);
  v.setUint16(60, rawItemCount, true);
  v.setUint16(62, gzipItemCount, true);

  // Entries (fixed stride).
  let off = HEADER_SIZE;
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    v.setFloat64(off, e.ino, true);
    v.setFloat64(off + 8, e.mtimeMs, true);
    v.setFloat64(off + 16, e.size, true);
    buf.set(e.hash, off + 24);
    off += ENTRY_STRIDE;
  }

  // Paths.
  if (pathsBuf.length > 0) {
    buf.set(pathsBuf, off);
    off += pathsBuf.length;
  }

  // Data sections.
  if (rawBlob.length > 0) {
    buf.set(rawBlob, off);
    off += rawBlob.length;
  }
  if (gzipBlob.length > 0) {
    buf.set(gzipBlob, off);
  }

  return buf;
}

// ── Data item serialization / parsing ────────────────────────────────────

/** Serialize typed data items into a contiguous buffer. */
export function serializeItems(items: readonly FileHashCacheDataValue[]): Buffer {
  const tags = new Uint8Array(items.length);
  const blobs: Uint8Array[] = new Array(items.length);
  let total = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let tag: number;
    let bytes: Uint8Array;

    if (item === null) {
      tag = T_NULL;
      bytes = EMPTY;
    } else if (item === undefined) {
      tag = T_UNDEFINED;
      bytes = EMPTY;
    } else if (item instanceof Uint8Array) {
      tag = T_BUFFER;
      bytes = item;
    } else if (typeof item === "string") {
      tag = T_STRING;
      bytes = bufferFrom(item, "utf-8");
    } else {
      tag = T_JSON;
      const json = JSON.stringify(item);
      if (json === undefined) {
        throw new TypeError(`FileHashCache: item at index ${i} is not JSON-serializable`);
      }
      bytes = bufferFrom(json, "utf-8");
    }

    tags[i] = tag;
    blobs[i] = bytes;
    total += 5 + bytes.length;
  }

  const buf = bufferAllocUnsafe(total);
  const v = new DataView(buf.buffer, buf.byteOffset, total);
  let off = 0;

  for (let i = 0; i < items.length; i++) {
    buf[off] = tags[i];
    const b = blobs[i];
    v.setUint32(off + 1, b.length, true);
    if (b.length > 0) {
      buf.set(b, off + 5);
    }
    off += 5 + b.length;
  }

  return buf;
}

/**
 * Parse typed data items from a buffer section.
 *
 * @param data   Buffer containing the items.
 * @param offset Start offset within `data`.
 * @param count  Number of items to read.
 */
export function parseItems(data: Uint8Array, offset: number, count: number): FileHashCacheDataValue[] {
  const items: FileHashCacheDataValue[] = new Array(count);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = offset;

  for (let i = 0; i < count; i++) {
    if (off + 5 > data.length) {
      throw new RangeError(`FileHashCache: truncated data item at index ${i}`);
    }
    const tag = data[off];
    const len = v.getUint32(off + 1, true);
    off += 5;
    if (off + len > data.length) {
      throw new RangeError(`FileHashCache: truncated data item at index ${i}`);
    }

    switch (tag) {
      case T_NULL:
        items[i] = null;
        break;
      case T_UNDEFINED:
        items[i] = undefined;
        break;
      case T_BUFFER:
        items[i] = Buffer.from(data.buffer, data.byteOffset + off, len);
        break;
      case T_STRING:
        items[i] = Buffer.from(data.buffer, data.byteOffset + off, len).toString("utf-8");
        break;
      case T_JSON:
        items[i] = JSON.parse(Buffer.from(data.buffer, data.byteOffset + off, len).toString("utf-8"));
        break;
      default:
        throw new RangeError(`FileHashCache: unknown type tag ${tag} at index ${i}`);
    }

    off += len;
  }

  return items;
}

// ── stat helpers ─────────────────────────────────────────────────────────

/** stat() all files with bounded concurrency. */
export async function statAll(paths: string[]): Promise<(StatResult | null)[]> {
  const n = paths.length;
  const results = new Array<StatResult | null>(n);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= n) {
        break;
      }
      try {
        const s = await fsStat(paths[i]);
        results[i] = { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        results[i] = null;
      }
    }
  };

  const lanes = Math.min(STAT_CONCURRENCY, n);
  const tasks = new Array<Promise<void>>(lanes);
  for (let i = 0; i < lanes; i++) {
    tasks[i] = worker();
  }
  await Promise.all(tasks);
  return results;
}
