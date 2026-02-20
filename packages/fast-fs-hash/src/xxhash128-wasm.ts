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
import { XXHash128Base } from "./xxhash128-base";

// ── WASM types ───────────────────────────────────────────────────────────

/** Maximum data chunk the WASM I/O buffer can hold at once (16 KiB). */
const MAX_HEAP = 16 * 1024;

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
  return { ex, mem: new Uint8Array(ex.memory.buffer, ex.Hash_GetBuffer(), MAX_HEAP), bufOffset: ex.Hash_GetBuffer() };
}

function getStateSize(ex: WasmExports): number {
  const s = ex.STATE_SIZE;
  return typeof s === "number" ? s : s.value;
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
    const chunk = Math.min(length - read, MAX_HEAP);
    mem.set(buf.subarray(offset + read, offset + read + chunk));
    ex.Hash_Update(chunk);
    read += chunk;
  }
}

function wasmDigest(this: WasmInstance): Buffer {
  const { ex } = this._wasm;
  const stateOffset = ex.Hash_GetState();
  const stateSize = getStateSize(ex);
  const saved = new Uint8Array(ex.memory.buffer, stateOffset, stateSize).slice();
  ex.Hash_Final();
  const result = Buffer.from(this._wasm.mem.slice(0, 16));
  new Uint8Array(ex.memory.buffer, stateOffset, stateSize).set(saved);
  return result;
}

function wasmDigestTo(this: WasmInstance, output: Uint8Array, outputOffset?: number): void {
  const off = outputOffset ?? 0;
  if (off + 16 > output.byteLength) {
    throw new RangeError("digestTo: output buffer too small (need 16 bytes)");
  }
  const { ex, bufOffset } = this._wasm;
  const stateOffset = ex.Hash_GetState();
  const stateSize = getStateSize(ex);
  const saved = new Uint8Array(ex.memory.buffer, stateOffset, stateSize).slice();
  ex.Hash_Final();
  output.set(new Uint8Array(ex.memory.buffer, bufOffset, 16), off);
  new Uint8Array(ex.memory.buffer, stateOffset, stateSize).set(saved);
}

// ── Prototype patching ───────────────────────────────────────────────────

function patchBaseWithWasm(): void {
  const proto = XXHash128Base.prototype;
  Object.defineProperty(proto, "reset", { value: wasmReset, writable: true, configurable: true });
  Object.defineProperty(proto, "update", { value: wasmUpdate, writable: true, configurable: true });
  Object.defineProperty(proto, "digest", { value: wasmDigest, writable: true, configurable: true });
  Object.defineProperty(proto, "digestTo", { value: wasmDigestTo, writable: true, configurable: true });
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
