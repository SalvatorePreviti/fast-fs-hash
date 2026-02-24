/**
 * XXHash128 — Streaming xxHash3-128 hasher with automatic backend selection.
 *
 * Prefers the native C++ addon for maximum performance; falls back
 * to the WASM implementation when the native binding is unavailable.
 *
 * Call {@link XXHash128.init} once before creating any instances.
 *
 * @module
 */

import { types as utilTypes } from "node:util";
import { encodeFilePaths } from "../functions";
import type { HashInput } from "../helpers";
import { bufferAlloc, bufferFrom, isBuffer, toBuffer } from "../helpers";
import type { NativeXXHash128Constructor, NativeXXHash128Instance } from "../native";
import { getNativeBinding } from "../native";
import type { HashFilesBulkOptions } from "./xxhash128-base";
import { XXHash128Base } from "./xxhash128-base";
import type { XXHash128WasmInternalOptional } from "./xxhash128-wasm";
import { initWasmInstanceState, isWasmReady, XXHash128Wasm } from "./xxhash128-wasm";

const { isUint8Array } = utilTypes;

let _nativeCtor: NativeXXHash128Constructor | null = null;
let _nativeLoadFailed = false;

/** Cached init promise — shared across concurrent calls, preserved on failure. */
let _initPromise: Promise<void> | null = null;

async function _doInit(): Promise<void> {
  const native = getNativeBinding()?.XXHash128 ?? null;
  if (native) {
    _nativeCtor = native;
    patchWithNative(native);
  } else {
    _nativeLoadFailed = true;
    await XXHash128Wasm.init();
    // patchBaseWithWasm() already patched XXHash128Base statics + prototype,
    // so XXHash128 inherits all WASM methods automatically.
    Object.defineProperty(XXHash128.prototype, "libraryStatus", {
      get() {
        return "wasm";
      },
      configurable: true,
    });
  }
}

//  - Internal instance shape (avoids Record<string, unknown> casts)

/** @internal Shape of an XXHash128 instance with a native backend. */
interface NativeInstance extends XXHash128Base {
  _native: NativeXXHash128Instance;
}

//  - Module-scope native method implementations

function nativeReset(this: NativeInstance): void {
  this._native.reset();
}

function nativeUpdate(this: NativeInstance, input: HashInput, inputOffset?: number, inputLength?: number): void {
  const buf = toBuffer(input);
  this._native.update(buf, inputOffset ?? 0, inputLength ?? buf.length - (inputOffset ?? 0));
}

function nativeDigest(this: NativeInstance): Buffer {
  return this._native.digest();
}

function nativeDigestTo(this: NativeInstance, output: Uint8Array, outputOffset?: number): void {
  const buf = isBuffer(output) ? output : bufferFrom(output.buffer, output.byteOffset, output.byteLength);
  this._native.digestTo(buf, outputOffset ?? 0);
}

async function nativeUpdateFilesBulk(
  this: XXHash128 & NativeInstance,
  files: Iterable<string> | Uint8Array,
  allFiles?: boolean
): Promise<Buffer | null> {
  // Accept Uint8Array directly — no Buffer conversion needed (N-API reads Uint8Array).
  const pathsBuf = isUint8Array(files) ? files : encodeFilePaths(files);

  if (!pathsBuf.length) {
    if (allFiles) {
      return bufferAlloc(0);
    }
    return null;
  }

  // Aggregate only — no per-file output needed.
  if (!allFiles) {
    await this._native.updateFilesBulkAggregate(pathsBuf, this.concurrency);
    return null;
  }

  // Per-file hashes into a new buffer.
  return this._native.updateFilesBulk(pathsBuf, this.concurrency);
}

async function nativeUpdateFilesBulkTo(
  this: XXHash128 & NativeInstance,
  files: Iterable<string> | Uint8Array,
  output: Uint8Array,
  outputOffset?: number
): Promise<void> {
  const pathsBuf = isUint8Array(files) ? files : encodeFilePaths(files);

  if (!pathsBuf.length) {
    return;
  }

  // Write directly into caller-provided output buffer — no intermediate allocation.
  await this._native.updateFilesBulk(pathsBuf, this.concurrency, output, outputOffset ?? 0);
}

async function nativeUpdateFile(this: XXHash128 & NativeInstance, path: string): Promise<void> {
  await this._native.updateFile(path);
}

async function nativeInstanceHashFile(this: NativeInstance, filePath: string): Promise<Buffer> {
  return this._native.hashFile(filePath, undefined, 0) as Promise<Buffer>;
}

async function nativeInstanceHashFileTo(
  this: NativeInstance,
  filePath: string,
  output: Uint8Array,
  outputOffset?: number
): Promise<void> {
  await this._native.hashFile(filePath, output, outputOffset ?? 0);
}

//  - Static hashFilesBulk

//  - Prototype patching

/** Patch XXHash128.prototype with native-backed method implementations. */
function patchWithNative(nativeCtor: NativeXXHash128Constructor): void {
  const proto = XXHash128.prototype;

  Object.defineProperty(proto, "reset", { value: nativeReset, writable: true, configurable: true });
  Object.defineProperty(proto, "update", { value: nativeUpdate, writable: true, configurable: true });
  Object.defineProperty(proto, "digest", { value: nativeDigest, writable: true, configurable: true });
  Object.defineProperty(proto, "digestTo", { value: nativeDigestTo, writable: true, configurable: true });
  Object.defineProperty(proto, "updateFilesBulk", { value: nativeUpdateFilesBulk, writable: true, configurable: true });
  Object.defineProperty(proto, "updateFilesBulkTo", {
    value: nativeUpdateFilesBulkTo,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(proto, "updateFile", { value: nativeUpdateFile, writable: true, configurable: true });
  Object.defineProperty(proto, "hashFile", { value: nativeInstanceHashFile, writable: true, configurable: true });
  Object.defineProperty(proto, "hashFileTo", { value: nativeInstanceHashFileTo, writable: true, configurable: true });

  Object.defineProperty(proto, "libraryStatus", {
    get() {
      return "native";
    },
    configurable: true,
  });

  const staticHashFilesBulk = nativeCtor.staticHashFilesBulk;
  const staticHashFilesBulkTo = nativeCtor.staticHashFilesBulkTo;
  const staticHash = nativeCtor.staticHash;
  const staticHashTo = nativeCtor.staticHashTo;
  const staticHashFile = nativeCtor.staticHashFile;

  /** Static hashFilesBulk — delegates to C++ StaticHashFilesWorker. */
  async function nativeStaticHashFilesBulk(options: HashFilesBulkOptions): Promise<Buffer> {
    const pathsBuf = isUint8Array(options.files) ? options.files : encodeFilePaths(options.files);
    const mode = (options.outputMode ?? "digest").charCodeAt(0);
    return staticHashFilesBulk(pathsBuf, options.concurrency ?? 0, options.seedLow ?? 0, options.seedHigh ?? 0, mode);
  }

  /** Static hashFilesBulkTo — writes into a pre-allocated output buffer. */
  async function nativeStaticHashFilesBulkTo(
    options: HashFilesBulkOptions,
    output: Uint8Array,
    outputOffset?: number
  ): Promise<void> {
    const pathsBuf = isUint8Array(options.files) ? options.files : encodeFilePaths(options.files);
    const mode = options.outputMode ?? "digest";

    // Count files for size validation.
    let fileCount = 0;
    if (pathsBuf.length > 0) {
      for (let i = 0; i < pathsBuf.length; i++) {
        if (pathsBuf[i] === 0) {
          fileCount++;
        }
      }
    }
    const includeDigest = mode !== "files";
    const includeFiles = mode !== "digest";
    const off = outputOffset ?? 0;
    const resultSize = (includeDigest ? 16 : 0) + (includeFiles ? fileCount * 16 : 0);
    if (off + resultSize > output.byteLength) {
      throw new RangeError(
        `hashFilesBulkTo: output buffer too small (need ${resultSize} bytes at offset ${off}, have ${output.byteLength})`
      );
    }

    return staticHashFilesBulkTo(
      pathsBuf,
      options.concurrency ?? 0,
      options.seedLow ?? 0,
      options.seedHigh ?? 0,
      mode.charCodeAt(0),
      output,
      off
    );
  }

  /** Static hashFile — delegates to C++ HashFileWorker without creating a JS instance. */
  function nativeStaticHashFile(
    filePath: string,
    seedLow?: number,
    seedHigh?: number,
    salt?: Uint8Array
  ): Promise<Buffer> {
    return staticHashFile(filePath, undefined, 0, seedLow ?? 0, seedHigh ?? 0, salt) as Promise<Buffer>;
  }

  async function nativeStaticHashFileTo(
    filePath: string,
    output: Uint8Array,
    outputOffset?: number,
    seedLow?: number,
    seedHigh?: number,
    salt?: Uint8Array
  ): Promise<void> {
    await staticHashFile(filePath, output, outputOffset ?? 0, seedLow ?? 0, seedHigh ?? 0, salt);
  }

  // Static methods — delegate to C++ without any JS instance creation.
  function nativeStaticHash(input: HashInput, seedLow = 0, seedHigh = 0): Buffer {
    const buf = toBuffer(input);
    return staticHash(buf, 0, buf.length, seedLow, seedHigh);
  }

  function nativeStaticHashTo(input: HashInput, output: Uint8Array, outputOffset = 0, seedLow = 0, seedHigh = 0): void {
    const buf = toBuffer(input);
    staticHashTo(buf, buf.length, output, outputOffset, seedLow, seedHigh);
  }

  Object.defineProperty(XXHash128, "hash", { value: nativeStaticHash, writable: true, configurable: true });
  Object.defineProperty(XXHash128, "hashTo", { value: nativeStaticHashTo, writable: true, configurable: true });
  Object.defineProperty(XXHash128, "hashFilesBulk", {
    value: nativeStaticHashFilesBulk,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(XXHash128, "hashFilesBulkTo", {
    value: nativeStaticHashFilesBulkTo,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(XXHash128, "hashFile", {
    value: nativeStaticHashFile,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(XXHash128, "hashFileTo", { value: nativeStaticHashFileTo, writable: true, configurable: true });
}

/**
 * Streaming xxHash3-128 hasher — uses native C++ when available,
 * WASM otherwise.
 *
 * Call {@link XXHash128.init} once before creating instances.
 */
export class XXHash128 extends XXHash128Base {
  public constructor(seedLow = 0, seedHigh = 0) {
    super(seedLow, seedHigh);
    if (_nativeCtor) {
      (this as unknown as NativeInstance)._native = new _nativeCtor(seedLow, seedHigh);
    } else if (isWasmReady()) {
      (this as XXHash128WasmInternalOptional)._state = initWasmInstanceState(seedLow, seedHigh);
      if (_nativeLoadFailed) {
        getNativeBinding(true);
      }
    } else {
      throw new Error("XXHash128: library not initialized. Call XXHash128.init() first.");
    }
  }

  /**
   * Initialize the XXHash128 backend.
   *
   * Attempts to load the native C++ binding. If unavailable, falls back
   * to {@link XXHash128Wasm.init} (WASM).
   *
   * Repeated calls are no-ops.
   */
  public static init(): Promise<void> {
    if (_nativeCtor) {
      return Promise.resolve();
    }
    return (_initPromise ??= _doInit());
  }
}
