/**
 * FileHashCacheManager — immutable configuration holder for cache instances.
 *
 * Stores version and seed parameters that are shared across all cache files
 * using this manager.  The fingerprint is NOT part of the manager — it is
 * per-file and passed to the {@link FileHashCache} constructor instead.
 *
 * @module
 */

import type { FileHashCacheManagerOptions } from "./types";

/**
 * Immutable configuration holder for {@link FileHashCache} instances.
 *
 * @example
 * ```ts
 * const manager = new FileHashCacheManager({ version: 1, seedLow: 42 });
 * ```
 */
export class FileHashCacheManager {
  /** 24-bit user-defined cache version (0–16 777 215). */
  public readonly version: number = 0;

  /** Lower 32 bits of the 64-bit seed for the aggregate digest. */
  public readonly seedLow: number = 0;

  /** Upper 32 bits of the 64-bit seed for the aggregate digest. */
  public readonly seedHigh: number = 0;

  public constructor(options?: FileHashCacheManagerOptions) {
    if (options) {
      this.version = ((options.version || 0) | 0) & 0xffffff;
      this.seedLow = (options.seedLow || 0) | 0;
      this.seedHigh = (options.seedHigh || 0) | 0;
    }
  }
}
