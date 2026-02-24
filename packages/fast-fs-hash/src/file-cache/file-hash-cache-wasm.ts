import { XXHash128Wasm } from "../xxhash128/xxhash128-wasm";
import { FileHashCacheBase } from "./file-hash-cache-base";
import type { FileHashCacheImpl } from "./file-hash-cache-impl";
import { createWasmFileHashCacheImpl } from "./file-hash-cache-impl";
import type { FileHashCacheOptions } from "./types";

let _implWasm: FileHashCacheImpl | null = null;

/**
 * Cache-file reader/validator/writer using the WASM xxHash3-128 backend.
 *
 * Identical API to {@link FileHashCache} but always uses WASM — useful
 * when you want a deterministic backend choice or the native addon is
 * unavailable.
 *
 * @example
 * ```ts
 * await FileHashCacheWasm.init();
 * const cache = new FileHashCacheWasm("/my/project", ".cache/fsh", { version: 1 });
 * ```
 */
export class FileHashCacheWasm extends FileHashCacheBase {
  /**
   * @param rootPath  Absolute path to the project root directory, or `true`
   *   to auto-compute the root from the file list.
   * @param filePath  Path to the cache file on disk.
   * @param options   Configuration (version, fingerprint, seeds).
   */
  public constructor(rootPath: string | true, filePath: string, options?: FileHashCacheOptions) {
    super(rootPath, filePath, options, (_implWasm ??= createWasmFileHashCacheImpl()));
  }

  /**
   * Initialize the WASM xxHash3-128 backend.
   *
   * Loads and compiles the WASM module. Must be called before
   * creating any {@link FileHashCacheWasm} instances.
   * Repeated calls are no-ops.
   */
  public static init(): Promise<void> {
    return XXHash128Wasm.init();
  }
}
