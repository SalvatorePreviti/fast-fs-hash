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
import { encodeFilePaths } from "./functions";
import { bufferAlloc, bufferFrom, isBuffer, toBuffer } from "./helpers";
import type { NativeXXHash128Constructor, NativeXXHash128Instance } from "./native";
import { loadNativeXXHash128 } from "./native";
import type { HashInput } from "./types";
import type { HashFilesBulkOptions } from "./xxhash128-base";
import { _hashFilesBulkImpl, XXHash128Base } from "./xxhash128-base";
import { initWasmInstanceState, isWasmReady, XXHash128Wasm } from "./xxhash128-wasm";

const { isUint8Array } = utilTypes;

// ── Module state ─────────────────────────────────────────────────────────

let _nativeCtor: NativeXXHash128Constructor | null = null;
let _nativeLoadFailed = false;
let _nativeWarned = false;

/** Cached init promise — shared across concurrent calls, preserved on failure. */
let _initPromise: Promise<void> | null = null;

async function _doInit(): Promise<void> {
  const native = loadNativeXXHash128();
  if (native) {
    _nativeCtor = native;
    patchWithNative();
  } else {
    _nativeLoadFailed = true;
    await XXHash128Wasm.init();
    // Mark our prototype with 'wasm' status since we fall back
    Object.defineProperty(XXHash128.prototype, "libraryStatus", {
      get() {
        return "wasm";
      },
      configurable: true,
    });
  }
}

// ── Internal instance shape (avoids Record<string, unknown> casts) ───────

/** @internal Shape of an XXHash128 instance with a native backend. */
interface NativeInstance extends XXHash128Base {
  _native: NativeXXHash128Instance;
}

// ── Module-scope native method implementations ───────────────────────────

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
  allFilesOrOutput?: boolean | Uint8Array,
  outputOffset?: number
): Promise<Buffer | Uint8Array | null> {
  // Accept Uint8Array directly — no Buffer conversion needed (N-API reads Uint8Array).
  const pathsBuf = isUint8Array(files) ? files : encodeFilePaths(files);

  if (!pathsBuf.length) {
    if (!allFilesOrOutput) {
      return null;
    }
    return typeof allFilesOrOutput === "object" ? allFilesOrOutput : bufferAlloc(0);
  }

  // Aggregate only — no per-file output needed.
  if (!allFilesOrOutput) {
    await this._native.updateFilesBulkAggregate(pathsBuf, this.concurrency);
    return null;
  }

  // Per-file hashes into a new buffer.
  if (allFilesOrOutput === true) {
    return this._native.updateFilesBulk(pathsBuf, this.concurrency);
  }

  // Write directly into caller-provided output buffer — no intermediate allocation.
  await this._native.updateFilesBulk(pathsBuf, this.concurrency, allFilesOrOutput, outputOffset ?? 0);
  return allFilesOrOutput;
}

async function nativeUpdateFile(this: XXHash128 & NativeInstance, path: string): Promise<void> {
  await this._native.updateFile(path);
}

/** Static hashFilesBulk — delegates directly to C++ without creating a JS wrapper instance. */
async function nativeStaticHashFilesBulk(options: HashFilesBulkOptions<Uint8Array>): Promise<Buffer | Uint8Array> {
  const ctor = _nativeCtor;
  if (!ctor) {
    throw new Error("XXHash128: library not initialized. Call XXHash128.init() first.");
  }
  const {
    files,
    outputMode: what = "digest",
    concurrency = 0,
    seedLow = 0,
    seedHigh = 0,
    outputBuffer,
    outputOffset = 0,
  } = options;

  // Accept Uint8Array directly — no Buffer conversion needed (N-API reads Uint8Array).
  const pathsBuf = isUint8Array(files) ? files : encodeFilePaths(files);

  // Pass first charCode of outputMode as the mode identifier.
  // 'd' (100) = DIGEST_ONLY, 'f' (102) = FILES_ONLY, 'a' (97) = ALL
  const result = await ctor.hashFilesBulk(pathsBuf, concurrency, seedLow, seedHigh, what.charCodeAt(0));

  if (outputBuffer) {
    if (outputOffset + result.length > outputBuffer.byteLength) {
      throw new RangeError(
        `hashFilesBulk: outputBuffer too small (need ${result.length} bytes at offset ${outputOffset}, have ${outputBuffer.byteLength})`
      );
    }
    outputBuffer.set(result, outputOffset);
    return outputBuffer;
  }
  return result;
}

// ── Prototype patching ───────────────────────────────────────────────────

/** Patch XXHash128.prototype with native-backed method implementations. */
function patchWithNative(): void {
  const proto = XXHash128.prototype;

  Object.defineProperty(proto, "reset", { value: nativeReset, writable: true, configurable: true });
  Object.defineProperty(proto, "update", { value: nativeUpdate, writable: true, configurable: true });
  Object.defineProperty(proto, "digest", { value: nativeDigest, writable: true, configurable: true });
  Object.defineProperty(proto, "digestTo", { value: nativeDigestTo, writable: true, configurable: true });
  Object.defineProperty(proto, "updateFilesBulk", { value: nativeUpdateFilesBulk, writable: true, configurable: true });
  Object.defineProperty(proto, "updateFile", { value: nativeUpdateFile, writable: true, configurable: true });

  Object.defineProperty(proto, "libraryStatus", {
    get() {
      return "native";
    },
    configurable: true,
  });

  // Static methods — delegate to C++ without any JS instance creation.
  Object.defineProperty(XXHash128, "hashFilesBulk", {
    value: nativeStaticHashFilesBulk,
    writable: true,
    configurable: true,
  });
}

// ── XXHash128 class ──────────────────────────────────────────────────────

/**
 * Streaming xxHash3-128 hasher — uses native C++ when available,
 * WASM otherwise.
 *
 * Call {@link XXHash128.init} once before creating instances.
 */
export class XXHash128 extends XXHash128Base {
  /** @inheritdoc */
  public static override hash(input: HashInput, seedLow = 0, seedHigh = 0): Buffer {
    const h = new XXHash128(seedLow, seedHigh);
    h.update(input);
    return h.digest();
  }

  /** @inheritdoc */
  public static override async hashFilesBulk<T extends Uint8Array>(
    options: HashFilesBulkOptions<T> & { outputBuffer: T }
  ): Promise<T>;
  public static override async hashFilesBulk(options: HashFilesBulkOptions): Promise<Buffer>;
  public static override async hashFilesBulk(options: HashFilesBulkOptions<Uint8Array>): Promise<Buffer | Uint8Array> {
    return _hashFilesBulkImpl(XXHash128, options);
  }

  public constructor(seedLow = 0, seedHigh = 0) {
    super();
    this._seedLow = seedLow;
    this._seedHigh = seedHigh;
    if (_nativeCtor) {
      (this as unknown as NativeInstance)._native = new _nativeCtor(seedLow, seedHigh);
    } else if (isWasmReady()) {
      initWasmInstanceState(this, seedLow, seedHigh);
      if (!_nativeWarned && _nativeLoadFailed) {
        _nativeWarned = true;
        console.warn("XXHash128: native binding unavailable, using WASM fallback (slower).");
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
