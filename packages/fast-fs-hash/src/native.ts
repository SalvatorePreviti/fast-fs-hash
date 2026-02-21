/**
 * Native binding loader.
 *
 * Attempts to load the pre-built platform-specific `.node` addon from
 * optional dependency packages (e.g. `@fast-fs-hash/darwin-arm64`).
 * Falls back to a local development build at `build/Release/`.
 *
 * Returns `null` when no native binding is available.
 *
 * @module
 * @internal
 */

import { createRequire } from "node:module";

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
}

/**
 * Native XXHash128 class constructor (C++ ObjectWrap).
 * @internal
 */
export interface NativeXXHash128Constructor {
  new (seedLow: number, seedHigh: number): NativeXXHash128Instance;
  hash(data: Buffer, offset: number, length: number, seedLow: number, seedHigh: number): Buffer;
  hashFilesBulk(
    pathsBuf: Uint8Array,
    concurrency: number,
    seedLow: number,
    seedHigh: number,
    mode: number
  ): Promise<Buffer>;
}

/** Shape of the native binding export. */
interface NativeBindingExport {
  XXHash128: NativeXXHash128Constructor;
}

/**
 * Platform → npm package name mapping.
 * On Linux, both gnu and musl variants are tried (preferred first).
 */
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
 * Load the native XXHash128 constructor.
 * Returns `null` when no native binding is available.
 */
export function loadNativeXXHash128(): NativeXXHash128Constructor | null {
  for (const pkg of getPlatformPackages()) {
    try {
      return (require(pkg) as NativeBindingExport).XXHash128;
    } catch {
      // Not installed — try next
    }
  }

  try {
    return (require("./native/build/Release/fast_fs_hash.node") as NativeBindingExport).XXHash128;
  } catch {
    // Not built locally
  }

  return null;
}
