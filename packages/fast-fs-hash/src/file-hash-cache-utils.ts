/**
 * Shared utility functions for FileHashCache.
 *
 * @module
 * @internal
 */

import { findCommonRootPath, pathResolve } from "./utils";

export function resolveDir(p: string): string {
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
