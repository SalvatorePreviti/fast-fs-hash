/**
 * Native binding loader.
 *
 * Attempts to load the pre-built platform-specific `.node` addon from
 * optional dependency packages (e.g. `@fast-fs-hash/fast-fs-hash-node-darwin-arm64`).
 * Falls back to a local development build at `../build/Release/`.
 *
 * Returns `null` when no native binding is available.
 *
 * @module
 * @internal
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Native XXHash128 instance methods (C++ ObjectWrap).
 * @internal
 */
export interface NativeXXHash128Instance {
  update(data: Buffer, offset: number, length: number): void;
  digest(): Buffer;
  digestTo(output: Buffer, offset: number): void;
  reset(): void;
  updateFilesBulk(pathsBuf: Uint8Array, concurrency: number): Promise<Buffer>;
  updateFilesBulk(
    pathsBuf: Uint8Array,
    concurrency: number,
    outputBuf: Uint8Array,
    outputOffset: number
  ): Promise<null>;
  updateFilesBulkAggregate(pathsBuf: Uint8Array, concurrency: number): Promise<null>;
  updateFile(path: string): Promise<void>;
  hashFile(path: string, output: Uint8Array | undefined, offset: number): Promise<Buffer | Uint8Array>;
}

/**
 * Native XXHash128 class constructor (C++ ObjectWrap).
 * @internal
 */
export interface NativeXXHash128Constructor {
  new (seedLow: number, seedHigh: number): NativeXXHash128Instance;
  staticHash(data: Buffer, offset: number, length: number, seedLow: number, seedHigh: number): Buffer;
  staticHashFilesBulk(
    pathsBuf: Uint8Array,
    concurrency: number,
    seedLow: number,
    seedHigh: number,
    mode: number
  ): Promise<Buffer>;
  staticHashFilesBulkTo(
    pathsBuf: Uint8Array,
    concurrency: number,
    seedLow: number,
    seedHigh: number,
    mode: number,
    output: Uint8Array,
    outputOffset: number
  ): Promise<void>;
  staticHashFile(
    path: string,
    output: Uint8Array | undefined,
    offset: number,
    seedLow: number,
    seedHigh: number,
    salt: Uint8Array | undefined
  ): Promise<Buffer | Uint8Array>;
}

/** Shape of the native binding export. */
interface NativeBindingExport {
  XXHash128: NativeXXHash128Constructor;
  libraryStatus?: "native";
  statAndMatch?: (
    entriesBuf: Buffer,
    oldBuf: Buffer,
    fileStates: Uint8Array,
    pathsBuf: Uint8Array,
    rootPath: string
  ) => Promise<boolean>;
  completeEntries?: (
    entriesBuf: Buffer,
    fileStates: Uint8Array,
    pathsBuf: Uint8Array,
    rootPath: string
  ) => Promise<void>;
  remapOldEntries?: (
    oldEntries: Buffer,
    oldPaths: Buffer,
    oldCount: number,
    newEntries: Buffer,
    newStates: Uint8Array,
    newPaths: Buffer,
    newCount: number
  ) => void;
}

function getPlatformPackages(): string[] {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const isMusl = !report?.header?.glibcVersionRuntime;
    const preferred = isMusl ? "musl" : "gnu";
    const fallback = isMusl ? "gnu" : "musl";
    return [
      `@fast-fs-hash/fast-fs-hash-node-${platform}-${arch}-${preferred}`,
      `@fast-fs-hash/fast-fs-hash-node-${platform}-${arch}-${fallback}`,
    ];
  }
  if (platform === "win32") {
    return [`@fast-fs-hash/fast-fs-hash-node-${platform}-${arch}-msvc`];
  }
  return [`@fast-fs-hash/fast-fs-hash-node-${platform}-${arch}`];
}

/**
 * Cached native binding (loaded once, shared by all callers).
 * `undefined` = not yet attempted, `null` = no native binding available.
 */

let _cachedBinding: NativeBindingExport | null | undefined;
let _nativeWarned = false;
let _nativeLookupTargets: string[] = [];
let _nativeLookupErrors: string[] = [];

// --- FAST_FS_HASH_NO_NATIVE env var support ---
// Modes:
//   "wasm"         - Native disallowed, WASM loaded, warning printed mentioning FAST_FS_HASH_NO_NATIVE
//   "wasm-silent"  - Native disallowed, WASM loaded, no warning at all
//   "fatal"        - If native is missing, print error with stack trace and call process.exit(1)
function getNoNativeMode(): "wasm" | "wasm-silent" | "fatal" | undefined {
  const v = process.env.FAST_FS_HASH_NO_NATIVE;
  if (!v) {
    return undefined;
  }
  switch (v.toLowerCase()) {
    case "wasm": {
      return "wasm";
    }
    case "wasm-silent": {
      return "wasm-silent";
    }
    case "fatal": {
      return "fatal";
    }
    default: {
      return undefined;
    }
  }
}

function warnNativeUnavailable(mode?: string): void {
  if (mode === "wasm-silent") {
    return;
  }
  const lookedIn = _nativeLookupTargets.length > 0 ? `\nlooked in:\n  - ${_nativeLookupTargets.join("\n  - ")}` : "";
  const reasons = _nativeLookupErrors.length > 0 ? `\nerrors:\n  - ${_nativeLookupErrors.join("\n  - ")}` : "";
  if (mode === "wasm") {
    console.warn(
      `fast-fs-hash: native binding disabled by FAST_FS_HASH_NO_NATIVE, using WASM fallback.${lookedIn}${reasons}`
    );
  } else {
    console.warn(`fast-fs-hash: native binding unavailable, using WASM fallback (slower).${lookedIn}${reasons}`);
  }
}

/**
 * Load (or return cached) native binding.
 *
 * @param warn  If `true` and no native binding is found, emit a one-time
 *              `console.warn` so the user knows WASM fallback is active.
 *              Default `false` (silent).
 */
export function getNativeBinding(warn = false): NativeBindingExport | null {
  const mode = getNoNativeMode();
  if (mode === "wasm" || mode === "wasm-silent") {
    // Native disallowed — always use WASM
    _cachedBinding = null;
    if (!_nativeWarned) {
      _nativeWarned = true;
      warnNativeUnavailable(mode);
    }
    return null;
  }

  if (_cachedBinding !== undefined) {
    if (warn && _cachedBinding === null && !_nativeWarned) {
      _nativeWarned = true;
      warnNativeUnavailable(mode);
    }
    if (mode === "fatal" && _cachedBinding === null) {
      fatalNoNative();
    }
    return _cachedBinding;
  }

  _nativeLookupTargets = [];
  _nativeLookupErrors = [];

  for (const pkg of getPlatformPackages()) {
    _nativeLookupTargets.push(`package ${pkg}`);
    try {
      _cachedBinding = require(pkg) as NativeBindingExport;
      return _cachedBinding;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      _nativeLookupErrors.push(`package ${pkg}: ${message}`);
      // Not installed — try next
    }
  }

  // Dev mode: load from the local cmake-js build output.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const localBuildPath = resolve(thisDir, "..", "build", "Release", "fast_fs_hash.node");
  _nativeLookupTargets.push(`file ${localBuildPath}`);
  try {
    _cachedBinding = require(localBuildPath) as NativeBindingExport;
    return _cachedBinding;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    _nativeLookupErrors.push(`file ${localBuildPath}: ${message}`);
    // Build not available
  }

  _cachedBinding = null;
  if (warn && !_nativeWarned) {
    _nativeWarned = true;
    warnNativeUnavailable(mode);
  }
  if (mode === "fatal") {
    fatalNoNative();
  }
  return null;
}

function fatalNoNative(): never {
  const lookedIn = _nativeLookupTargets.length > 0 ? `\nlooked in:\n  - ${_nativeLookupTargets.join("\n  - ")}` : "";
  const reasons = _nativeLookupErrors.length > 0 ? `\nerrors:\n  - ${_nativeLookupErrors.join("\n  - ")}` : "";
  const err = new Error(
    `fast-fs-hash: native binding unavailable and FAST_FS_HASH_NO_NATIVE=fatal.${lookedIn}${reasons}`
  );
  console.error(err);
  process.exit(1);
}
