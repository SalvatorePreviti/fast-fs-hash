import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { isUint8Array } from "node:util/types";
import { decodeFilePaths } from "../functions";
import type { HashInput } from "../helpers";
import { bufferAlloc, bufferAllocUnsafe, loadXxHash128WasmModule, safeClose, toBuffer } from "../helpers";
import type { HashFilesBulkOptions } from "./xxhash128-base";
import { XXHash128Base } from "./xxhash128-base";

/** Max concurrent I/O lanes for WASM batch hash operations. */
export const MAX_WASM_LANES = 8;

/**
 * Read buffer size per lane for chunked file hashing (64 KiB).
 *  Covers most source files in a single read while keeping slab memory small.
 */
const WASM_READ_BUF_SIZE = 64 * 1024;

/**
 * Maximum data chunk the WASM I/O buffer can hold at once (16 KiB).
 * This is a hard limit set by the compiled WASM module's internal buffer.
 */
const WASM_BUF_SIZE = 16 * 1024;

/** WASM exports shape. */
interface WasmExports {
  memory: { buffer: ArrayBuffer };
  Hash_GetBuffer(): number;
  Hash_Init(): void;
  Hash_Update(length: number): void;
  Hash_Final(): void;
  Hash_GetState(): number;
  STATE_SIZE: { value: number } | number;
}

/** All WASM runtime state — singleton shared instance for the entire process. */
class WasmState {
  /** WASM exports. */
  public readonly ex: WasmExports;
  /** WASM memory view. */
  public readonly mem: Uint8Array;
  /** Size of the WASM hash state area. */
  public readonly stateSize: number;
  /** Pre-created view of the WASM hash state area (~500 bytes). */
  public readonly stateView: Uint8Array;
  /** Pre-created Uint32Array at bufOffset for writing seed (2 × u32 LE). */
  public readonly seedView: Uint32Array;
  /** Pre-created view over the first 16 bytes at bufOffset (digest output). */
  public readonly digestView: Uint8Array;

  public constructor() {
    if (!_wasmModule) {
      throw new Error("XXHash128Wasm: call XXHash128Wasm.init() before use.");
    }
    // biome-ignore lint/suspicious/noExplicitAny: Wasm and tsc issue for node, we don't want to bring all the dom lib
    const ex: WasmExports = new (globalThis as any).WebAssembly.Instance(_wasmModule).exports;

    const s = ex.STATE_SIZE;
    const bufOffset = ex.Hash_GetBuffer();
    const stateSize = typeof s === "number" ? s : s.value;
    const stateOffset = ex.Hash_GetState();
    const memBuf = ex.memory.buffer;
    this.ex = ex;
    this.mem = new Uint8Array(memBuf, bufOffset, WASM_BUF_SIZE);
    this.stateSize = stateSize;
    this.stateView = new Uint8Array(memBuf, stateOffset, stateSize);
    this.seedView = new Uint32Array(memBuf, bufOffset, 2);
    this.digestView = new Uint8Array(memBuf, bufOffset, 16);
  }

  /** Write seed into the WASM I/O buffer (first 8 bytes). */
  public initSeed(seedLow: number, seedHigh: number): void {
    const seedView = this.seedView;
    seedView[0] = seedLow;
    seedView[1] = seedHigh;
    this.ex.Hash_Init();
  }

  /** Feed data into WASM in WASM_BUF_SIZE chunks. Caller must have restored state. */
  public feed(data: Uint8Array, dataOffset: number, dataLength: number): void {
    let read = 0;
    const ex = this.ex;
    const mem = this.mem;
    while (read < dataLength) {
      const remain = dataLength - read;
      const n = remain < WASM_BUF_SIZE ? remain : WASM_BUF_SIZE;
      mem.set(data.subarray(dataOffset + read, dataOffset + read + n));
      ex.Hash_Update(n);
      read += n;
    }
  }

  public digest<TBuffer extends Uint8Array | Buffer = Buffer>(
    state: Uint8Array,
    output: TBuffer | null | undefined,
    outputOffset: number = 0
  ): TBuffer {
    if (!output) {
      output = bufferAllocUnsafe(16) as TBuffer;
      outputOffset = 0;
    }
    if (outputOffset + 16 > output.byteLength) {
      throw new RangeError("output buffer too small (need 16 bytes)");
    }
    this.stateView.set(state);
    this.ex.Hash_Final();
    output.set(this.digestView, outputOffset);
    return output;
  }
}

let _wasmModule: object | null = null;
let _wasmInitPromise: Promise<void> | null = null;

/** The ONE shared WASM instance for the entire process. */
let _sharedWasm: WasmState | null = null;

async function _doWasmInit(): Promise<void> {
  _wasmModule ??= await loadXxHash128WasmModule();
  // Eagerly create the shared instance so all subsequent code can use it.
  _sharedWasm ??= new WasmState();
  patchBaseWithWasm();
}

/** @internal — Check whether WASM module is ready. */
export function isWasmReady(): boolean {
  return _sharedWasm !== null;
}

/** Get the shared WASM state (created once at init). */
function getSharedWasm(): WasmState {
  if (!_sharedWasm) {
    throw new Error("XXHash128Wasm: call XXHash128Wasm.init() before use.");
  }
  return _sharedWasm;
}

/** Set up WASM instance state on any XXHash128Base instance. */
export function initWasmInstanceState(seedLow: number, seedHigh: number): Uint8Array {
  const ws = getSharedWasm();
  ws.initSeed(seedLow, seedHigh);
  return ws.stateView.slice();
}

// All instance methods restore from _state before touching WASM,
// and save back to _state after mutations (update). Digest is
// non-destructive from the instance's perspective — it restores,
// finalizes (destructive in WASM), reads the result, but _state
// is never updated so it stays at the pre-finalize snapshot.

function wasmReset(this: XXHash128WasmInternal): void {
  const ws = getSharedWasm();
  ws.initSeed(this.seedLow, this.seedHigh);
  this._state.set(ws.stateView);
}

function wasmUpdate(this: XXHash128WasmInternal, input: HashInput, inputOffset?: number, inputLength?: number): void {
  const buf = toBuffer(input);
  const offset = inputOffset ?? 0;
  const length = inputLength ?? buf.length - offset;
  if (offset + length > buf.length) {
    throw new RangeError("update: offset + length exceeds buffer size");
  }
  const ws = getSharedWasm();
  ws.stateView.set(this._state);
  ws.feed(buf, offset, length);
  this._state.set(ws.stateView);
}

function wasmDigest(this: XXHash128WasmInternal): Buffer {
  const ws = getSharedWasm();
  ws.stateView.set(this._state);
  ws.ex.Hash_Final();
  const result = bufferAlloc(16);
  result.set(ws.digestView);
  return result;
}

function wasmDigestTo(this: XXHash128WasmInternal, output: Uint8Array, outputOffset?: number): void {
  const off = outputOffset ?? 0;
  if (off + 16 > output.byteLength) {
    throw new RangeError("digestTo: output buffer too small (need 16 bytes)");
  }
  const ws = getSharedWasm();
  ws.stateView.set(this._state);
  ws.ex.Hash_Final();
  output.set(ws.digestView, off);
}

/**
 * Optimized one-shot synchronous WASM hash.
 *
 * Reuses the shared WASM state — no instance allocation.
 * Safe because fully synchronous (no await points to cause interleaving).
 */
function wasmHash(input: HashInput, seedLow = 0, seedHigh = 0): Buffer {
  const buf = toBuffer(input);
  const ws = getSharedWasm();
  const { ex, seedView, digestView } = ws;

  seedView[0] = seedLow;
  seedView[1] = seedHigh;
  ex.Hash_Init();

  if (buf.length > 0) {
    ws.feed(buf, 0, buf.length);
  }

  ex.Hash_Final();
  const result = bufferAlloc(16);
  result.set(digestView);
  return result;
}

function patchBaseWithWasm(): void {
  const proto = XXHash128Base.prototype;
  const defineProperty = Object.defineProperty;
  defineProperty(proto, "reset", { value: wasmReset, writable: true, configurable: true });
  defineProperty(proto, "update", { value: wasmUpdate, writable: true, configurable: true });
  defineProperty(proto, "digest", { value: wasmDigest, writable: true, configurable: true });
  defineProperty(proto, "digestTo", { value: wasmDigestTo, writable: true, configurable: true });
  defineProperty(proto, "updateFilesBulk", { value: wasmUpdateFilesBulk, writable: true, configurable: true });
  defineProperty(proto, "updateFilesBulkTo", { value: wasmUpdateFilesBulkTo, writable: true, configurable: true });
  defineProperty(proto, "hashFile", { value: wasmInstanceHashFile, writable: true, configurable: true });
  defineProperty(proto, "hashFileTo", { value: wasmInstanceHashFileTo, writable: true, configurable: true });
  defineProperty(proto, "hashFileHandle", { value: wasmInstanceHashFileHandle, writable: true, configurable: true });
  defineProperty(proto, "hashFileHandleTo", {
    value: wasmInstanceHashFileHandleTo,
    writable: true,
    configurable: true,
  });

  // Static methods on XXHash128Wasm — assign optimized functions directly.
  const wasm = XXHash128Wasm;
  defineProperty(wasm, "hash", { value: wasmHash, writable: true, configurable: true });
  defineProperty(wasm, "hashFile", { value: wasmHashFile, writable: true, configurable: true });
  defineProperty(wasm, "hashFileTo", { value: wasmHashFileTo, writable: true, configurable: true });
  defineProperty(wasm, "hashFileHandle", { value: wasmHashFileHandle, writable: true, configurable: true });
  defineProperty(wasm, "hashFileHandleTo", { value: wasmHashFileHandleTo, writable: true, configurable: true });
  defineProperty(wasm, "hashFilesBulk", { value: wasmHashFilesBulk, writable: true, configurable: true });
  defineProperty(wasm, "hashFilesBulkTo", { value: wasmHashFilesBulkTo, writable: true, configurable: true });

  // Also patch XXHash128Base statics so subclasses (like XXHash128) inherit them.
  const base = XXHash128Base;
  defineProperty(base, "hash", { value: wasmHash, writable: true, configurable: true });
  defineProperty(base, "hashFile", { value: wasmHashFile, writable: true, configurable: true });
  defineProperty(base, "hashFileTo", { value: wasmHashFileTo, writable: true, configurable: true });
  defineProperty(base, "hashFileHandle", { value: wasmHashFileHandle, writable: true, configurable: true });
  defineProperty(base, "hashFileHandleTo", { value: wasmHashFileHandleTo, writable: true, configurable: true });
  defineProperty(base, "hashFilesBulk", { value: wasmHashFilesBulk, writable: true, configurable: true });
  defineProperty(base, "hashFilesBulkTo", { value: wasmHashFilesBulkTo, writable: true, configurable: true });

  /** Instance-level chunked hashFile — patches XXHash128Base.prototype.hashFile. */
  async function wasmInstanceHashFile(this: XXHash128WasmInternal, filePath: string): Promise<Buffer> {
    const ws = getSharedWasm();
    ws.initSeed(this.seedLow, this.seedHigh);
    const state = this._state;
    state.set(ws.stateView);

    const fh = await open(filePath, "r");
    try {
      const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await fh.read(readBuf, 0, WASM_READ_BUF_SIZE, pos);
        if (!bytesRead) {
          break;
        }

        ws.stateView.set(state);
        ws.feed(readBuf, 0, bytesRead);
        state.set(ws.stateView);

        pos += bytesRead;
        if (bytesRead < WASM_READ_BUF_SIZE) {
          break;
        }
      }
    } finally {
      await safeClose(fh);
    }

    ws.stateView.set(state);
    ws.ex.Hash_Final();
    const result = bufferAlloc(16);
    result.set(ws.digestView);
    return result;
  }

  /** Instance-level hashFileTo — writes digest into caller-provided buffer. */
  async function wasmInstanceHashFileTo(
    this: XXHash128WasmInternal,
    filePath: string,
    output: Uint8Array,
    outputOffset?: number
  ): Promise<void> {
    const ws = getSharedWasm();
    ws.initSeed(this.seedLow, this.seedHigh);
    const state = this._state;
    state.set(ws.stateView);

    const fh = await open(filePath, "r");
    try {
      const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await fh.read(readBuf, 0, WASM_READ_BUF_SIZE, pos);
        if (!bytesRead) {
          break;
        }

        ws.stateView.set(state);
        ws.feed(readBuf, 0, bytesRead);
        state.set(ws.stateView);

        pos += bytesRead;
        if (bytesRead < WASM_READ_BUF_SIZE) {
          break;
        }
      }
    } finally {
      await safeClose(fh);
    }

    ws.stateView.set(state);
    ws.ex.Hash_Final();
    output.set(ws.digestView, outputOffset ?? 0);
  }

  /** Instance-level chunked hashFileHandle — patches XXHash128Base.prototype.hashFileHandle. */
  async function wasmInstanceHashFileHandle(this: XXHash128WasmInternal, fh: FileHandle): Promise<Buffer> {
    const ws = getSharedWasm();
    const state = this._state;
    ws.initSeed(this.seedLow, this.seedHigh);
    const stateView = ws.stateView;
    state.set(stateView);

    const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(readBuf, 0, WASM_READ_BUF_SIZE, pos);
      if (bytesRead === 0) {
        break;
      }
      ws.stateView.set(this._state);
      ws.feed(readBuf, 0, bytesRead);
      this._state.set(stateView);
      pos += bytesRead;
      if (bytesRead < WASM_READ_BUF_SIZE) {
        break;
      }
    }

    ws.stateView.set(state);
    ws.ex.Hash_Final();
    const result = bufferAlloc(16);
    result.set(ws.digestView);
    return result;
  }

  /** Instance-level hashFileHandleTo — writes digest into caller-provided buffer. */
  async function wasmInstanceHashFileHandleTo(
    this: XXHash128WasmInternal,
    fh: FileHandle,
    output: Uint8Array,
    outputOffset?: number
  ): Promise<void> {
    const ws = getSharedWasm();
    const state = this._state;
    ws.initSeed(this.seedLow, this.seedHigh);
    const stateView = ws.stateView;
    state.set(stateView);

    const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(readBuf, 0, WASM_READ_BUF_SIZE, pos);
      if (bytesRead === 0) {
        break;
      }
      ws.stateView.set(this._state);
      ws.feed(readBuf, 0, bytesRead);
      this._state.set(stateView);
      pos += bytesRead;
      if (bytesRead < WASM_READ_BUF_SIZE) {
        break;
      }
    }

    ws.stateView.set(state);
    ws.ex.Hash_Final();
    output.set(ws.digestView, outputOffset ?? 0);
  }

  /**
   * WASM instance-level updateFilesBulk — bounded-concurrency per-file
   * hashing with slab-allocated buffers.
   *
   * Each file is hashed individually (seed 0, XXH3-128) -> 16-byte per-file hash.
   * All per-file hashes are concatenated and fed as one block into this
   * instance's streaming state. Matches C++ two-level scheme exactly.
   */
  async function wasmUpdateFilesBulk(
    this: XXHash128WasmInternal,
    files: Iterable<string> | Uint8Array,
    allFiles?: boolean
  ): Promise<Buffer | null> {
    const paths = isUint8Array(files) ? decodeFilePaths(files) : Array.from(files);
    const fileCount = paths.length;

    if (fileCount === 0) {
      return allFiles ? bufferAlloc(0) : null;
    }

    // Hash all files -> contiguous N×16 buffer (zero-init).
    const hashes = bufferAlloc(fileCount * 16);
    const conc = this.concurrency;
    await wasmHashFilesBatchStrided(paths, hashes, 0, 16, conc > 0 ? conc : MAX_WASM_LANES);

    // Feed all per-file hashes into this instance as one contiguous block.
    const state = this._state;
    const ws = getSharedWasm();
    ws.stateView.set(state);
    ws.feed(hashes, 0, fileCount * 16);
    state.set(ws.stateView);

    // Return per-file hashes if requested.
    return allFiles ? hashes : null;
  }

  async function wasmUpdateFilesBulkTo(
    this: XXHash128WasmInternal,
    files: Iterable<string> | Uint8Array,
    output: Uint8Array,
    outputOffset?: number
  ): Promise<void> {
    const paths = isUint8Array(files) ? decodeFilePaths(files) : Array.from(files);
    const fileCount = paths.length;

    if (fileCount === 0) {
      return;
    }

    const off = outputOffset ?? 0;
    const needed = fileCount * 16;
    if (off + needed > output.byteLength) {
      throw new RangeError(
        `updateFilesBulkTo: output buffer too small (need ${needed} bytes at offset ${off}, have ${output.byteLength})`
      );
    }

    // Hash all files -> contiguous N×16 buffer (zero-init).
    const hashes = bufferAlloc(needed);
    const conc = this.concurrency;
    await wasmHashFilesBatchStrided(paths, hashes, 0, 16, conc > 0 ? conc : MAX_WASM_LANES);

    // Feed all per-file hashes into this instance as one contiguous block.
    wasmUpdate.call(this, hashes, 0, needed);

    // Write per-file hashes into output.
    output.set(hashes, off);
  }

  /**
   * Static WASM hashFilesBulk — hash files with bounded concurrency,
   * compute aggregate digest, assemble output per outputMode.
   * No class instantiation. Matches C++ behavior.
   */
  async function wasmHashFilesBulk(options: HashFilesBulkOptions): Promise<Buffer> {
    const { files, outputMode: what = "digest", concurrency = 0, seedLow = 0, seedHigh = 0 } = options;

    const paths = isUint8Array(files) ? decodeFilePaths(files) : Array.from(files as Iterable<string>);
    const fileCount = paths.length;
    const includeDigest = what !== "files";
    const includeFiles = what !== "digest";
    const conc = concurrency > 0 ? concurrency : MAX_WASM_LANES;

    if (includeFiles) {
      // "files" or "all": single allocation — per-file hashes at hashesOff, digest (if needed) at 0.
      const hashesOff = includeDigest ? 16 : 0;
      const result = bufferAlloc(hashesOff + fileCount * 16);
      if (fileCount > 0) {
        await wasmHashFilesBatchStrided(paths, result, hashesOff, 16, conc);
      }
      if (includeDigest) {
        const ws = getSharedWasm();
        ws.initSeed(seedLow, seedHigh);
        if (fileCount > 0) {
          ws.feed(result, hashesOff, fileCount * 16);
        }
        ws.ex.Hash_Final();
        result.set(ws.digestView, 0);
      }
      return result;
    }

    // "digest" only: temp buffer for per-file hashes, return 16-byte digest.
    const hashes = bufferAlloc(fileCount * 16);
    if (fileCount > 0) {
      await wasmHashFilesBatchStrided(paths, hashes, 0, 16, conc);
    }
    const ws = getSharedWasm();
    ws.initSeed(seedLow, seedHigh);
    if (fileCount > 0) {
      ws.feed(hashes, 0, fileCount * 16);
    }
    ws.ex.Hash_Final();
    const digest = bufferAlloc(16);
    digest.set(ws.digestView);
    return digest;
  }

  async function wasmHashFilesBulkTo(
    options: HashFilesBulkOptions,
    output: Uint8Array,
    outputOffset?: number
  ): Promise<void> {
    const { files, outputMode: what = "digest", concurrency = 0, seedLow = 0, seedHigh = 0 } = options;

    const paths = isUint8Array(files) ? decodeFilePaths(files) : Array.from(files as Iterable<string>);
    const fileCount = paths.length;
    const includeDigest = what !== "files";
    const includeFiles = what !== "digest";
    const off = outputOffset ?? 0;
    const resultSize = (includeDigest ? 16 : 0) + (includeFiles ? fileCount * 16 : 0);

    if (off + resultSize > output.byteLength) {
      throw new RangeError(
        `hashFilesBulkTo: output buffer too small (need ${resultSize} bytes at offset ${off}, have ${output.byteLength})`
      );
    }

    const conc = concurrency > 0 ? concurrency : MAX_WASM_LANES;

    if (includeFiles) {
      // "files" or "all": write per-file hashes directly into output — zero temp allocations.
      const hashesOff = off + (includeDigest ? 16 : 0);
      if (fileCount > 0) {
        await wasmHashFilesBatchStrided(paths, output, hashesOff, 16, conc);
      }
      if (includeDigest) {
        const ws = getSharedWasm();
        ws.initSeed(seedLow, seedHigh);
        if (fileCount > 0) {
          ws.feed(output, hashesOff, fileCount * 16);
        }
        ws.ex.Hash_Final();
        output.set(ws.digestView, off);
      }
      return;
    }

    // "digest" only: temp buffer for per-file hashes.
    const hashes = bufferAlloc(fileCount * 16);
    if (fileCount > 0) {
      await wasmHashFilesBatchStrided(paths, hashes, 0, 16, conc);
    }
    const ws = getSharedWasm();
    ws.initSeed(seedLow, seedHigh);
    if (fileCount > 0) {
      ws.feed(hashes, 0, fileCount * 16);
    }
    ws.ex.Hash_Final();
    output.set(ws.digestView, off);
  }
}

/**
 * Read a file from a FileHandle in readBuf-sized chunks, feeding each into
 * the shared WASM instance with save/restore around every yield point.
 *
 * Caller must have already called Hash_Init + fed any salt/seed before
 * this helper, and must have saved the current state into `savedState`.
 */
async function wasmHashChunks(
  ws: WasmState,
  savedState: Uint8Array,
  stateView: Uint8Array,
  fh: FileHandle,
  readBuf: Buffer
): Promise<void> {
  const readBufSize = readBuf.length;
  let pos = 0;
  for (;;) {
    const { bytesRead } = await fh.read(readBuf, 0, readBufSize, pos);
    if (bytesRead === 0) {
      break;
    }
    // Restore state -> feed chunk -> save state
    stateView.set(savedState);
    ws.feed(readBuf, 0, bytesRead);
    savedState.set(stateView);
    pos += bytesRead;
    // Short-circuit: partial read means EOF — skip the extra zero-byte read.
    if (bytesRead < readBufSize) {
      break;
    }
  }
}

/**
 * Chunked one-shot WASM file hasher.
 *
 * Opens the file, reads in WASM_READ_BUF_SIZE chunks, hashes via the shared WASM
 * instance with save/restore around every yield point.
 *
 * @internal — Exported for file-hash-cache WASM impl.
 */
export async function wasmHashFile(
  filePath: string,
  seedLow?: number,
  seedHigh?: number,
  salt?: Uint8Array
): Promise<Buffer> {
  const ws = getSharedWasm();
  const { ex, stateView, stateSize } = ws;

  ws.initSeed(seedLow ?? 0, seedHigh ?? 0);

  if (salt && salt.length > 0) {
    ws.feed(salt, 0, salt.length);
  }

  // Save WASM state before first yield
  const savedState = new Uint8Array(stateSize);
  savedState.set(stateView);
  const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);

  // Read file in chunks with save/restore around each yield
  const fh = await open(filePath, "r");
  try {
    await wasmHashChunks(ws, savedState, stateView, fh, readBuf);
  } finally {
    await safeClose(fh);
  }

  // Restore and finalize
  stateView.set(savedState);
  ex.Hash_Final();

  const result = bufferAlloc(16);
  result.set(ws.digestView);
  return result;
}

/**
 * Like wasmHashFile but writes the 16-byte digest into the provided output buffer.
 * @internal
 */
export async function wasmHashFileTo(
  filePath: string,
  output: Uint8Array,
  outputOffset?: number,
  seedLow?: number,
  seedHigh?: number,
  salt?: Uint8Array
): Promise<void> {
  const ws = getSharedWasm();
  const { ex, stateView, stateSize } = ws;

  ws.initSeed(seedLow ?? 0, seedHigh ?? 0);

  if (salt && salt.length > 0) {
    ws.feed(salt, 0, salt.length);
  }

  const savedState = new Uint8Array(stateSize);
  savedState.set(stateView);
  const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);

  const fh = await open(filePath, "r");
  try {
    await wasmHashChunks(ws, savedState, stateView, fh, readBuf);
  } finally {
    await safeClose(fh);
  }

  stateView.set(savedState);
  ex.Hash_Final();

  output.set(ws.digestView, outputOffset ?? 0);
}

/**
 * Chunked one-shot WASM file-handle hasher.
 *
 * Reads in WASM_READ_BUF_SIZE chunks from a caller-provided FileHandle,
 * hashing via the shared WASM instance with save/restore.
 * The caller retains ownership of the handle (no close).
 */
async function wasmHashFileHandle(fh: FileHandle, seedLow?: number, seedHigh?: number): Promise<Buffer> {
  const ws = getSharedWasm();
  const { ex, stateView, stateSize } = ws;

  ws.initSeed(seedLow ?? 0, seedHigh ?? 0);

  const savedState = new Uint8Array(stateSize);
  savedState.set(stateView);
  const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);

  await wasmHashChunks(ws, savedState, stateView, fh, readBuf);

  stateView.set(savedState);
  ex.Hash_Final();

  const result = bufferAlloc(16);
  result.set(ws.digestView);
  return result;
}

async function wasmHashFileHandleTo(
  fh: FileHandle,
  output: Uint8Array,
  outputOffset?: number,
  seedLow?: number,
  seedHigh?: number
): Promise<void> {
  const ws = getSharedWasm();
  const { ex, stateView, stateSize } = ws;

  ws.initSeed(seedLow ?? 0, seedHigh ?? 0);

  const savedState = new Uint8Array(stateSize);
  savedState.set(stateView);
  const readBuf = bufferAllocUnsafe(WASM_READ_BUF_SIZE);

  await wasmHashChunks(ws, savedState, stateView, fh, readBuf);

  stateView.set(savedState);
  ex.Hash_Final();

  output.set(ws.digestView, outputOffset ?? 0);
}

/**
 * Hash multiple files with bounded concurrency and slab-allocated buffers.
 *
 * Allocates TWO contiguous slabs (read buffers + saved WASM state) and
 * distributes per-lane views, matching the C++ pattern of slab allocation.
 * Concurrency is capped at {@link MAX_WASM_LANES}.
 *
 * On read failure, zeros the 16 hash bytes at the corresponding offset.
 *
 * @param paths         File paths to hash.
 * @param output        Buffer to write 16-byte digests into.
 * @param outputOffsets Per-file byte offset into output for the 16-byte digest.
 * @param concurrency   Number of parallel worker lanes (capped at MAX_WASM_LANES).
 *
 * @internal — Exported for file-hash-cache WASM impl.
 */
export async function wasmHashFilesBatch(
  paths: readonly string[],
  output: Uint8Array,
  outputOffsets: readonly number[],
  concurrency = MAX_WASM_LANES
): Promise<void> {
  const n = paths.length;
  if (!n) {
    return;
  }

  const lanes = Math.min(concurrency, MAX_WASM_LANES, n);
  const hashLane = wasmCreateHashLanes(lanes);
  let cursor = 0;

  const worker = async (laneIdx: number): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= n) {
        break;
      }
      await hashLane(laneIdx, paths[i], output, outputOffsets[i]);
    }
  };

  const tasks = new Array<Promise<void>>(lanes);
  for (let i = 0; i < lanes; i++) {
    tasks[i] = worker(i);
  }
  await Promise.all(tasks);
}

/**
 * Like {@link wasmHashFilesBatch}, but writes hashes at `startOffset + i * stride`.
 *
 * Avoids allocating an intermediate offsets array for contiguous layouts.
 *
 * @internal
 */
async function wasmHashFilesBatchStrided(
  paths: readonly string[],
  output: Uint8Array,
  startOffset: number,
  stride = 16,
  concurrency = MAX_WASM_LANES
): Promise<void> {
  const n = paths.length;
  if (!n) {
    return;
  }

  const lanes = Math.min(concurrency, MAX_WASM_LANES, n);
  const hashLane = wasmCreateHashLanes(lanes);
  let cursor = 0;

  const worker = async (laneIdx: number): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= n) {
        break;
      }
      await hashLane(laneIdx, paths[i], output, startOffset + i * stride);
    }
  };

  const tasks = new Array<Promise<void>>(lanes);
  for (let i = 0; i < lanes; i++) {
    tasks[i] = worker(i);
  }
  await Promise.all(tasks);
}

/**
 * Pre-allocate slab-backed read buffers and WASM state snapshots for
 * `laneCount` concurrent hash workers.
 *
 * Returns a per-lane hash function that writes the 16-byte XXH3-128
 * digest directly into the output buffer at the given offset.
 * On read failure, zeros the 16 bytes at outputOffset.
 *
 * This avoids per-file allocation entirely — each lane reuses its
 * slice of the pre-allocated slabs across all files it processes.
 *
 * @param laneCount  Number of concurrent worker lanes to allocate for.
 * @returns A function `(laneIdx, filePath, output, outputOffset) => Promise<void>`.
 *
 * @internal — Exported for file-hash-cache WASM impl.
 */
export function wasmCreateHashLanes(
  laneCount: number
): (laneIdx: number, filePath: string, output: Uint8Array, outputOffset: number) => Promise<void> {
  const ws = getSharedWasm();
  const { ex, stateView, stateSize, digestView } = ws;

  // Slab-allocate read buffers + saved states for all lanes.
  const readSlab = bufferAllocUnsafe(laneCount * WASM_READ_BUF_SIZE);
  const stateSlab = new Uint8Array(laneCount * stateSize);

  // Pre-compute per-lane views to avoid subarray overhead in hot loop.
  const readBufs = new Array<Buffer>(laneCount);
  const savedStates = new Array<Uint8Array>(laneCount);
  for (let i = 0; i < laneCount; i++) {
    readBufs[i] = readSlab.subarray(i * WASM_READ_BUF_SIZE, (i + 1) * WASM_READ_BUF_SIZE) as Buffer;
    savedStates[i] = stateSlab.subarray(i * stateSize, (i + 1) * stateSize);
  }

  return async (laneIdx: number, filePath: string, output: Uint8Array, outputOffset: number): Promise<void> => {
    const readBuf = readBufs[laneIdx];
    const savedState = savedStates[laneIdx];

    ws.initSeed(0, 0);
    savedState.set(stateView);

    try {
      const fh = await open(filePath, "r");
      try {
        await wasmHashChunks(ws, savedState, stateView, fh, readBuf);
      } finally {
        await safeClose(fh);
      }
      stateView.set(savedState);
      ex.Hash_Final();
      output.set(digestView, outputOffset);
    } catch {
      output.fill(0, outputOffset, outputOffset + 16);
    }
  };
}

/**
 * Streaming xxHash3-128 hasher backed by WebAssembly.
 *
 * All instances share a single WASM runtime and store a snapshot of the
 * internal hash state (~500 bytes). Operations restore/save state around
 * the shared WASM instance. This is much cheaper than creating a new
 * WASM instance per hasher.
 *
 * Call {@link XXHash128Wasm.init} **once** before creating instances.
 */
export class XXHash128Wasm extends XXHash128Base {
  public override get libraryStatus(): "wasm" {
    return "wasm";
  }

  public constructor(seedLow = 0, seedHigh = 0, concurrency = 0) {
    super(seedLow, seedHigh, concurrency);
    if (!_sharedWasm) {
      throw new Error("XXHash128Wasm: call XXHash128Wasm.init() before creating instances.");
    }
    (this as XXHash128WasmInternalOptional)._state = initWasmInstanceState(seedLow, seedHigh);
  }

  /**
   * Initialize the WASM backend.
   *
   * Loads and compiles the WASM module, creates the shared WASM runtime,
   * then patches {@link XXHash128Base.prototype} with working implementations.
   * Repeated calls are no-ops.
   */
  public static init(): Promise<void> {
    if (_wasmModule) {
      return Promise.resolve();
    }
    return (_wasmInitPromise ??= _doWasmInit());
  }
}

export interface XXHash128WasmInternalOptional extends XXHash128Wasm {
  /** Saved WASM hash state snapshot (~500 bytes). */
  _state?: Uint8Array;
}

export interface XXHash128WasmInternal extends XXHash128WasmInternalOptional {
  /** Saved WASM hash state snapshot (~500 bytes). */
  _state: Uint8Array;
}
