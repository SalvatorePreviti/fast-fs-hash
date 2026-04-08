/**
 * FileHashCacheEntries and FileHashCacheEntry classes.
 *
 * Provides a readonly snapshot of all resolved file entries from a
 * {@link FileHashCacheSession}, with lazy decoding of stat metadata
 * and content hashes from the native dataBuf.
 *
 * @module
 */

import type { FileHashCacheSession } from "./FileHashCacheSession";
import { ENTRY_STRIDE, HEADER_SIZE } from "./file-hash-cache-format";
import { hashToHex } from "./functions";

// ── FileHashCacheEntries ────────────────────────────────────────────

/**
 * Readonly snapshot of all resolved file entries from a {@link FileHashCacheSession}.
 *
 * Returned by {@link FileHashCacheSession.resolve}. Each entry contains the file's
 * current stat metadata and content hash, decoded lazily from the native dataBuf.
 */
export class FileHashCacheEntries {
  /** The session that produced this snapshot. */
  public readonly session: FileHashCacheSession;

  /** Number of file entries. */
  public readonly length: number;

  /** Pre-allocated array of entry objects. Properties are lazy-loaded from dataBuf. */
  readonly #items: readonly FileHashCacheEntry[];

  /** @internal */
  public constructor(session: FileHashCacheSession, dataBuf: Buffer) {
    this.session = session;
    const files = session.files;
    const fc = files.length;
    this.length = fc;
    const items = new Array<FileHashCacheEntry>(fc);
    for (let i = 0; i < fc; i++) {
      items[i] = new FileHashCacheEntry(dataBuf, i, files[i]);
    }
    this.#items = items;
  }

  /** Get a file entry by index. Returns `undefined` if out of range. */
  public get(index: number): FileHashCacheEntry | undefined {
    return this.#items[index];
  }

  /** Find a file entry by absolute path. Returns `undefined` if not found. */
  public find(path: string): FileHashCacheEntry | undefined {
    const items = this.#items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].path === path) {
        return items[i];
      }
    }
    return undefined;
  }

  /** Iterate all entries. */
  public [Symbol.iterator](): IterableIterator<FileHashCacheEntry> {
    return this.#items[Symbol.iterator]();
  }
}

// ── FileHashCacheEntry ──────────────────────────────────────────────

/**
 * A single fully resolved file entry with stat metadata and content hash.
 *
 * Scalar fields (path, index, size, mtimeMs, ctimeMs, changed) are eagerly populated.
 * `contentHash` is a zero-copy Buffer view into the native dataBuf.
 * `contentHashHex` is lazily computed on first access.
 */
export class FileHashCacheEntry {
  /** Absolute file path. */
  public readonly path: string;

  /** Index in the file list. */
  public readonly index: number;

  /** File size in bytes. */
  public readonly size: number;

  /** Modification time in milliseconds since epoch. */
  public readonly mtimeMs: number;

  /** Change time in milliseconds since epoch. */
  public readonly ctimeMs: number;

  /** `true` if the file content changed from the cached version (or is a new file). */
  public readonly changed: boolean;

  /** 16-byte xxHash3-128 content hash (zero-copy view into the native dataBuf). */
  public readonly contentHash: Buffer;

  #hashHex: string | null;

  /** @internal */
  public constructor(dataBuf: Buffer, index: number, path: string) {
    const offset = HEADER_SIZE + index * ENTRY_STRIDE;
    this.path = path;
    this.index = index;
    this.size = dataBuf.readUInt32LE(offset + 24) + dataBuf.readUInt32LE(offset + 28) * 0x100000000;
    this.mtimeMs = (dataBuf.readUInt32LE(offset + 8) + dataBuf.readUInt32LE(offset + 12) * 0x100000000) / 1e6;
    this.ctimeMs = (dataBuf.readUInt32LE(offset + 16) + dataBuf.readUInt32LE(offset + 20) * 0x100000000) / 1e6;
    // Direct indexing is slightly faster than readUInt8 (skips bounds check);
    // the offset is always in range because dataBuf was sized by C++ to fit fc entries.
    this.changed = (dataBuf[offset + 7] & 0x20) !== 0;
    this.contentHash = dataBuf.subarray(offset + 32, offset + 48);
    this.#hashHex = null;
  }

  /** Content hash as a 32-character lowercase hex string (xxHash3-128). Lazily computed. */
  public get contentHashHex(): string {
    let h = this.#hashHex;
    if (h === null) {
      h = hashToHex(this.contentHash);
      this.#hashHex = h;
    }
    return h;
  }
}
