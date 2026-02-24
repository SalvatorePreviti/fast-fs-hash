/**
 * Native binding loader.
 *
 * Attempts to load the pre-built platform-specific `.node` addon from
 * optional dependency packages (e.g. `@fast-fs-hash/darwin-arm64`).
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
  hashFileHandle(fd: number, output: Uint8Array | undefined, offset: number, fh: object): Promise<Buffer | Uint8Array>;
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
  staticHashFileHandle(
    fd: number,
    output: Uint8Array | undefined,
    offset: number,
    seedLow: number,
    seedHigh: number,
    fh: object
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
    return [`@fast-fs-hash/${platform}-${arch}-${preferred}`, `@fast-fs-hash/${platform}-${arch}-${fallback}`];
  }

  if (platform === "win32") {
    return [`@fast-fs-hash/${platform}-${arch}-msvc`];
  }

  return [`@fast-fs-hash/${platform}-${arch}`];
}

/**
 * Cached native binding (loaded once, shared by all callers).
 * `undefined` = not yet attempted, `null` = no native binding available.
 */
let _cachedBinding: NativeBindingExport | null | undefined;

/** Whether we've already warned on stderr about the missing native addon. */
let _nativeWarned = false;

/** Lookup targets tried while resolving the native binding. */
let _nativeLookupTargets: string[] = [];
let _nativeLookupErrors: string[] = [];

function warnNativeUnavailable(): void {
  const lookedIn = _nativeLookupTargets.length > 0 ? `\nlooked in:\n  - ${_nativeLookupTargets.join("\n  - ")}` : "";
  const reasons = _nativeLookupErrors.length > 0 ? `\nerrors:\n  - ${_nativeLookupErrors.join("\n  - ")}` : "";
  console.warn(`fast-fs-hash: native binding unavailable, using WASM fallback (slower).${lookedIn}${reasons}`);
}

/**
 * Load (or return cached) native binding.
 *
 * @param warn  If `true` and no native binding is found, emit a one-time
 *              `console.warn` so the user knows WASM fallback is active.
 *              Default `false` (silent).
 */
export function getNativeBinding(warn = false): NativeBindingExport | null {
  if (_cachedBinding !== undefined) {
    if (warn && _cachedBinding === null && !_nativeWarned) {
      _nativeWarned = true;
      warnNativeUnavailable();
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
    warnNativeUnavailable();
  }
  return null;
}
