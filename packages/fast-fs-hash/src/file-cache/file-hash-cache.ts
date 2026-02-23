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
import type { FileHashCacheImpl } from "./file-hash-cache-impl";
import { createWasmFileHashCacheImpl } from "./file-hash-cache-impl";
import type { FileHashCacheOptions } from "./types";

let _impl: FileHashCacheImpl | null = null;

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
 * await using cache = new FileHashCache(".cache/fsh", {
 *   version: 1, writable: true,
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
   * @param filePath  Path to the cache file on disk.
   * @param options   Configuration (version, fingerprint, writable, seeds).
   */
  public constructor(filePath: string, options?: FileHashCacheOptions) {
    super(
      filePath,
      options,
      (_impl ??= (getNativeBinding() as FileHashCacheImpl | null) ?? createWasmFileHashCacheImpl())
    );
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
