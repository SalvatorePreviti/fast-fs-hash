/**
 * FileHashCache — Cache-file reader/validator/writer using xxHash3-128
 * with automatic fallback from native to WASM backend.
 *
 * Call {@link FileHashCache.init} once before creating instances.
 *
 * @module
 */

import { getNativeBinding } from "../native";
import { XXHash128 } from "../xxhash128/xxhash128";
import { FileHashCacheBase } from "./file-hash-cache-base";
import type { FileHashCacheImpl, NativeCacheBinding } from "./file-hash-cache-impl";
import { createNativeFileHashCacheImpl, createWasmFileHashCacheImpl } from "./file-hash-cache-impl";
import type { FileHashCacheOptions } from "./types";

let _impl: FileHashCacheImpl | null = null;

function resolveImpl(): FileHashCacheImpl {
  if (_impl) {
    return _impl;
  }
  const binding = getNativeBinding();
  _impl = binding ? createNativeFileHashCacheImpl(binding as NativeCacheBinding) : createWasmFileHashCacheImpl();
  return _impl;
}

/**
 * Cache-file reader/validator/writer using xxHash3-128.
 *
 * Automatically selects the fastest available backend (native addon
 * or WASM). This is the main entry point for most users.
 * Call {@link FileHashCache.init} once at startup, then create
 * instances freely.
 *
 * @example
 * ```ts
 * await FileHashCache.init();
 * await using cache = new FileHashCache("/my/project", ".cache/fsh", {
 *   version: 1,
 * });
 * cache.setFiles(["src/a.ts", "src/b.ts"]);
 * const valid = await cache.validate();
 * if (!valid) {
 *   await cache.serialize();
 *   await cache.write(myData);
 *   cache.position += myData.length;
 * } else {
 *   const buf = Buffer.alloc(expectedLen);
 *   await cache.read(buf);
 * }
 * ```
 */
export class FileHashCache extends FileHashCacheBase {
  /**
   * @param rootPath  Absolute path to the project root directory, or `true`
   *   to auto-compute the root from the file list on every {@link setFiles}
   *   call.  All tracked files must be inside this directory — files outside
   *   it are silently ignored. Stored paths are unix-style relative paths
   *   for portability and security.
   * @param filePath  Path to the cache file on disk.
   * @param options   Configuration (version, fingerprint, seeds).
   */
  public constructor(rootPath: string | true, filePath: string, options?: FileHashCacheOptions) {
    super(rootPath, filePath, options, resolveImpl());
  }

  /**
   * Initialize the hash backend.
   *
   * Loads the fastest available hashing implementation.
   * Must be called before creating any {@link FileHashCache}
   * instances. Repeated calls are no-ops.
   */
  public static init(): Promise<void> {
    return XXHash128.init();
  }
}
