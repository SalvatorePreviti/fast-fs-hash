/**
 * Shared utility functions for FileHashCache.
 *
 * @module
 * @internal
 */

import { CACHE_MAX_USER_DATA_SIZE } from "./file-hash-cache-format";
import { findCommonRootPath, pathResolve } from "./utils";

export function setFingerprint(value: Uint8Array | null | undefined): Uint8Array | null {
  if (value !== null && value !== undefined) {
    if (!(value instanceof Uint8Array) || value.length !== 16) {
      throw new TypeError("FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes");
    }
    return value;
  }
  return null;
}

export function validateUserData(userData: readonly Uint8Array[] | null | undefined): void {
  if (userData) {
    let totalUdSize = 0;
    for (const item of userData) {
      if (!(item instanceof Uint8Array)) {
        throw new TypeError("FileHashCache: userData items must be Uint8Array");
      }
      totalUdSize += item.byteLength;
      if (totalUdSize > CACHE_MAX_USER_DATA_SIZE) {
        throw new Error(`FileHashCache: total user data size exceeds ${CACHE_MAX_USER_DATA_SIZE} bytes`);
      }
    }
  }
}

function resolveDir(p: string): string {
  const r = pathResolve(p);
  return r.charCodeAt(r.length - 1) === 0x2f /* '/' */ ? r : r + "/";
}

/** Resolve root path from explicit rootPath or auto-detect from files. */
export function resolveRoot(
  instanceRootPath: string | null,
  files: Iterable<string> | null,
  rootPath?: string | true | null
): string {
  const rp = rootPath ?? instanceRootPath;
  if (typeof rp === "string") {
    return resolveDir(rp);
  }
  if (!files) {
    throw new Error("FileHashCache: rootPath must be set when files is null");
  }
  return resolveDir(findCommonRootPath(Array.isArray(files) ? files : Array.from(files)) || "/");
}
