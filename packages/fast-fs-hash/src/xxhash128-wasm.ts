/**
 * XXHash128Wasm — xxHash3-128 streaming hasher backed by WebAssembly.
 *
 * Call {@link XXHash128Wasm.init} once before creating any instances.
 * Produces output **byte-identical** to the native C++ addon.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { toBuffer } from "./helpers";
import type { HashInput } from "./types";
import type { HashFilesBulkOptions } from "./xxhash128-base";
import { _hashFilesBulkImpl, XXHash128Base } from "./xxhash128-base";

// ── WASM types ───────────────────────────────────────────────────────────

/** Maximum data chunk the WASM I/O buffer can hold at once (16 KiB).
 *  This is a hard limit set by the compiled WASM module's internal buffer. */
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

/** All per-instance WASM state, bundled into one object. */
interface WasmState {
  readonly ex: WasmExports;
  readonly mem: Uint8Array;
  readonly bufOffset: number;
  readonly stateSize: number;
}

/** Instance shape when WASM methods are active on the prototype. */
interface WasmInstance {
  _wasm: WasmState;
  _seedLow: number;
  _seedHigh: number;
}

// ── WASM module management ───────────────────────────────────────────────

const WA: {
  compile(bytes: Uint8Array): Promise<object>;
  Instance: new (module: object) => { exports: Record<string, unknown> };
} = (globalThis as unknown as Record<string, never>).WebAssembly;

let _wasmModule: object | null = null;
let _wasmInitPromise: Promise<void> | null = null;

async function _doWasmInit(): Promise<void> {
  const wasmUrl = new URL("./xxhash128.wasm", import.meta.url);
  _wasmModule = await WA.compile(await readFile(wasmUrl));
  patchBaseWithWasm();
}

/** @internal — Check whether WASM module is ready. */
export function isWasmReady(): boolean {
  return _wasmModule !== null;
}

// ── WASM helpers ─────────────────────────────────────────────────────────

function writeSeed(wasmMemory: ArrayBuffer, bufOffset: number, seedLow: number, seedHigh: number): void {
  const view = new DataView(wasmMemory, bufOffset);
  view.setUint32(0, seedLow, true);
  view.setUint32(4, seedHigh, true);
}

function createWasmState(): WasmState {
  if (!_wasmModule) {
    throw new Error("XXHash128Wasm: call XXHash128Wasm.init() before use.");
  }
  const instance = new WA.Instance(_wasmModule);
  const ex = instance.exports as unknown as WasmExports;
  const s = ex.STATE_SIZE;
  const bufOffset = ex.Hash_GetBuffer();
  return {
    ex,
    mem: new Uint8Array(ex.memory.buffer, bufOffset, WASM_BUF_SIZE),
    bufOffset,
    stateSize: typeof s === "number" ? s : s.value,
  };
}

/** Set up WASM instance state on any XXHash128Base instance. */
export function initWasmInstanceState(self: XXHash128Base, seedLow: number, seedHigh: number): void {
  const wasm = createWasmState();
  const inst = self as unknown as WasmInstance;
  inst._wasm = wasm;
  inst._seedLow = seedLow;
  inst._seedHigh = seedHigh;
  writeSeed(wasm.ex.memory.buffer, wasm.bufOffset, seedLow, seedHigh);
  wasm.ex.Hash_Init();
}

// ── Prototype method implementations ─────────────────────────────────────

function wasmReset(this: WasmInstance): void {
  const { ex, bufOffset } = this._wasm;
  writeSeed(ex.memory.buffer, bufOffset, this._seedLow, this._seedHigh);
  ex.Hash_Init();
}

function wasmUpdate(this: WasmInstance, input: HashInput, inputOffset?: number, inputLength?: number): void {
  const buf = toBuffer(input);
  const offset = inputOffset ?? 0;
  const length = inputLength ?? buf.length - offset;
  if (offset + length > buf.length) {
    throw new RangeError("update: offset + length exceeds buffer size");
  }
  const { mem, ex } = this._wasm;
  let read = 0;
  while (read < length) {
    const chunk = Math.min(length - read, WASM_BUF_SIZE);
    mem.set(buf.subarray(offset + read, offset + read + chunk));
    ex.Hash_Update(chunk);
    read += chunk;
  }
}

/** Save state, finalize, execute callback, restore state. */
function wasmFinalizeWithRestore(wasm: WasmState, fn: (bufOffset: number, memBuf: ArrayBuffer) => void): void {
  const { ex, stateSize } = wasm;
  const stateOffset = ex.Hash_GetState();
  const saved = new Uint8Array(ex.memory.buffer, stateOffset, stateSize).slice();
  ex.Hash_Final();
  fn(wasm.bufOffset, ex.memory.buffer);
  new Uint8Array(ex.memory.buffer, stateOffset, stateSize).set(saved);
}

function wasmDigest(this: WasmInstance): Buffer {
  let result!: Buffer;
  wasmFinalizeWithRestore(this._wasm, (bufOffset, memBuf) => {
    result = Buffer.from(new Uint8Array(memBuf, bufOffset, 16).slice());
  });
  return result;
}

function wasmDigestTo(this: WasmInstance, output: Uint8Array, outputOffset?: number): void {
  const off = outputOffset ?? 0;
  if (off + 16 > output.byteLength) {
    throw new RangeError("digestTo: output buffer too small (need 16 bytes)");
  }
  wasmFinalizeWithRestore(this._wasm, (bufOffset, memBuf) => {
    output.set(new Uint8Array(memBuf, bufOffset, 16), off);
  });
}

// ── Prototype patching ───────────────────────────────────────────────────

/**
 * Optimized batch file hasher for the WASM backend.
 *
 * Accesses WASM linear memory directly — avoids method dispatch,
 * state save/restore (destructive finalize), and per-file object creation.
 * Creates ONE WASM instance for the entire batch, with pre-allocated
 * TypedArray views that produce zero garbage per file.
 */
function wasmHashFileBuffers(this: unknown, buffers: (Buffer | null)[], hashes: Uint8Array): void {
  const ws = createWasmState();
  const { ex, mem, bufOffset } = ws;
  const memBuf = ex.memory.buffer;
  const seedDv = new DataView(memBuf, bufOffset);
  const digestView = new Uint8Array(memBuf, bufOffset, 16);

  for (let i = 0; i < buffers.length; i++) {
    const data = buffers[i];
    if (data == null) {
      continue;
    }

    // Reset — inline seed write + init (no DataView recreation)
    seedDv.setUint32(0, 0, true);
    seedDv.setUint32(4, 0, true);
    ex.Hash_Init();

    // Update — copy chunks directly into WASM linear memory
    if (data.length > 0) {
      let read = 0;
      const len = data.length;
      while (read < len) {
        const remain = len - read;
        const n = remain < WASM_BUF_SIZE ? remain : WASM_BUF_SIZE;
        mem.set(data.subarray(read, read + n));
        ex.Hash_Update(n);
        read += n;
      }
    }

    // Finalize — destructive (no state save/restore — next iteration resets)
    ex.Hash_Final();
    hashes.set(digestView, i * 16);
  }
}

function patchBaseWithWasm(): void {
  const proto = XXHash128Base.prototype;
  Object.defineProperty(proto, "reset", { value: wasmReset, writable: true, configurable: true });
  Object.defineProperty(proto, "update", { value: wasmUpdate, writable: true, configurable: true });
  Object.defineProperty(proto, "digest", { value: wasmDigest, writable: true, configurable: true });
  Object.defineProperty(proto, "digestTo", { value: wasmDigestTo, writable: true, configurable: true });
  Object.defineProperty(proto, "_hashFileBuffers", { value: wasmHashFileBuffers, writable: true, configurable: true });
}

// ── XXHash128Wasm class ──────────────────────────────────────────────────

/**
 * Streaming xxHash3-128 hasher backed by WebAssembly.
 *
 * Call {@link XXHash128Wasm.init} **once** before creating instances.
 */
export class XXHash128Wasm extends XXHash128Base {
  public override get libraryStatus(): "wasm" {
    return "wasm";
  }

  public static override hash(input: HashInput, seedLow = 0, seedHigh = 0): Buffer {
    const h = new XXHash128Wasm(seedLow, seedHigh);
    h.update(input);
    return h.digest();
  }

  /** @inheritdoc */
  public static override async hashFilesBulk<T extends Uint8Array>(
    options: HashFilesBulkOptions<T> & { outputBuffer: T },
  ): Promise<T>;
  public static override async hashFilesBulk(options: HashFilesBulkOptions): Promise<Buffer>;
  public static override async hashFilesBulk(
    options: HashFilesBulkOptions<Uint8Array>,
  ): Promise<Buffer | Uint8Array> {
    return _hashFilesBulkImpl(XXHash128Wasm, options);
  }

  public constructor(seedLow = 0, seedHigh = 0) {
    super();
    if (!_wasmModule) {
      throw new Error("XXHash128Wasm: call XXHash128Wasm.init() before creating instances.");
    }
    initWasmInstanceState(this, seedLow, seedHigh);
  }

  /**
   * Initialize the WASM backend.
   *
   * Loads and compiles the WASM module, then patches
   * {@link XXHash128Base.prototype} with working implementations.
   * Repeated calls are no-ops.
   */
  public static init(): Promise<void> {
    if (_wasmModule) {
      return Promise.resolve();
    }
    return (_wasmInitPromise ??= _doWasmInit());
  }
}
