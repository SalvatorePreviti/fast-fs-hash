/**
 * Path normalization utilities for {@link FileHashCache}.
 *
 * Converts absolute or relative file paths to clean unix-style relative
 * paths (forward slashes, no leading `./`, absolutely no `../`).
 *
 * Paths outside the root directory are rejected — this is both for
 * portability (cache stays valid when the project directory moves) and
 * for security (prevents accessing files outside the project root).
 *
 * @module
 */

import path from "node:path";

export const {
  sep: pathSep,
  resolve: pathResolve,
  relative: pathRelative,
  isAbsolute: pathIsAbsolute,
  dirname: pathDirname,
} = path;

export const windows = pathSep !== "/";

/**
 * Resolve `filePath` relative to `rootPath` and return a clean unix-style
 * relative path, or `null` if the file is outside the root.
 *
 * - Handles both absolute and relative input paths.
 * - Resolves `.` and `..` segments via `path.resolve`.
 * - Converts backslashes to forward slashes on Windows.
 * - On POSIX, backslashes are preserved (they are valid in filenames).
 * - Strips any leading `./`.
 * - Returns `null` for paths that resolve outside `rootPath`.
 * - Returns `null` for empty strings.
 *
 * @param rootPath  Already-resolved absolute root directory.
 * @param filePath  Absolute or relative file path to normalize.
 * @returns Clean unix relative path (e.g. `"src/index.ts"`), or `null`.
 */
export function toRelativePath(rootPath: string, filePath: string): string | null {
  if (!filePath) {
    return null;
  }

  // ── Fast path ─────────────────────────────────────────────────────
  // When the file is an absolute path that directly starts with
  // rootPath + '/' and the remaining portion contains no unresolved
  // segments ( /./ , /../ , // ), we can produce the relative path
  // with a single slice — no path.resolve or path.relative needed.
  //
  // This is the overwhelmingly common case for build tools that pass
  // already-resolved absolute paths to setFiles().

  const rlen = rootPath.length;
  if (filePath.length > rlen + 1 && filePath.charCodeAt(rlen) === 0x2f /* '/' */ && filePath.startsWith(rootPath)) {
    const rel = filePath.slice(rlen + 1);
    // Reject if the relative portion contains unresolved dot-segments
    // ( /. which covers /./ and /../ ) or empty segments ( // ).
    // Such paths need the slow resolve+relative path below.
    if (rel.indexOf("/.") === -1 && rel.indexOf("//") === -1) {
      return windows ? rel.replaceAll("\\", "/") : rel;
    }
  }

  // ── Slow path ─────────────────────────────────────────────────────
  // Handles relative inputs, paths with . or .. segments, Windows
  // drive-letter differences, and any other edge case.

  // Resolve to absolute, collapsing . and .. segments.
  const abs = pathResolve(rootPath, filePath);

  // Compute the relative path from root. On POSIX this is fast (string prefix
  // check + slice). On Windows path.relative normalizes drive letters etc.
  const rel = pathRelative(rootPath, abs);

  // Reject paths that escape the root:
  //  - starts with ".." followed by the platform separator (parent traversal)
  //  - on Windows also check "..\" since \ is a separator there
  //  - on POSIX \ is a valid filename char so "..\\foo" is NOT a traversal
  //  - is an absolute path (different drive on Windows)
  if (!rel || _isParentTraversal(rel) || pathIsAbsolute(rel)) {
    return null;
  }

  // On Windows, normalize backslash separators to forward slashes.
  // On POSIX, backslash is a valid filename character — leave it alone.
  return windows ? rel.replaceAll("\\", "/") : rel;
}

/**
 * Normalize an iterable of file paths against a root directory.
 *
 * Each path is resolved to a clean unix-style relative path under `rootPath`
 * via {@link toRelativePath}. The result is **sorted lexicographically** and
 * **deduplicated**. Files that resolve outside `rootPath` are silently dropped.
 *
 * The returned array is allocated once at the input length and trimmed at the
 * end — no intermediate allocations or array resizes occur.
 *
 * @param rootPath  Already-resolved absolute root directory.
 * @param files     File paths to normalize (absolute or relative to `rootPath`).
 * @returns Sorted, deduplicated array of clean unix relative paths.
 */
export function normalizeFilePaths(rootPath: string, files: Iterable<string>): string[] {
  const raw = Array.isArray(files) ? files : Array.from(files);
  const len = raw.length;
  if (len === 0) {
    return [];
  }

  // Pre-allocate at full input length.  Write pointer `w` tracks how many
  // entries survived the toRelativePath filter.
  const arr = new Array<string>(len);
  let w = 0;
  for (let i = 0; i < len; i++) {
    const rel = toRelativePath(rootPath, raw[i]);
    if (rel !== null) {
      arr[w++] = rel;
    }
  }

  if (w === 0) {
    return [];
  }

  // Trim the pre-allocated array to the actual number of valid entries.
  arr.length = w;

  arr.sort();

  // In-place deduplication on the already-sorted array.
  if (w > 1) {
    let dw = 1;
    for (let r = 1; r < w; r++) {
      if (arr[r] !== arr[r - 1]) {
        arr[dw++] = arr[r];
      }
    }
    arr.length = dw;
  }

  return arr;
}

/**
 * Remap relative file paths from one root directory to another.
 *
 * For each path in `relativePaths` (relative to `oldRoot`), the function
 * resolves to an absolute path and re-relativizes against `newRoot` via
 * {@link toRelativePath}. Paths that fall outside `newRoot` are returned
 * as `null`.
 *
 * The returned array has the **same length and order** as `relativePaths` —
 * callers can use index correspondence to map entries, buffers, or states.
 *
 * @param oldRoot       Previously-resolved absolute root directory.
 * @param newRoot       New resolved absolute root directory.
 * @param relativePaths Paths relative to `oldRoot` (clean unix-style, as
 *   produced by {@link normalizeFilePaths}).
 * @returns Same-length array: re-relativized path or `null` for each input.
 */
export function remapRootPath(oldRoot: string, newRoot: string, relativePaths: readonly string[]): (string | null)[] {
  const len = relativePaths.length;
  const result = new Array<string | null>(len);
  for (let i = 0; i < len; i++) {
    // Resolve to absolute via oldRoot, then re-relativize against newRoot.
    result[i] = toRelativePath(newRoot, pathResolve(oldRoot, relativePaths[i]));
  }
  return result;
}

/**
 * Given a list of file paths, find the longest common parent directory.
 *
 * Each element is treated as a **file** path — the last segment is the
 * filename, not a directory.  Empty strings are silently ignored.
 *
 * - On Windows, backslash separators are normalized to forward slashes
 *   before comparison.
 * - If the common prefix is a POSIX root (`/`), returns `"/"`.
 * - If no common root exists (e.g. different Windows drives, or all
 *   paths are relative with no shared prefix), returns `""`.
 *
 * The function performs **no I/O** and does **not** call `path.resolve` —
 * it is a pure string operation.  For best results, pass already-resolved
 * absolute paths.
 *
 * @param files       File paths to inspect (absolute paths recommended).
 * @param baseRoot    When provided, the result is the common ancestor of all
 *   file directories AND this path.  This prevents the result from being
 *   deeper than `baseRoot` — use it to set a "minimum root" for the
 *   computation.  Has no effect on which files are included.
 * @param allowedRoot When provided, files whose directory is not under this
 *   path are silently excluded from the computation.  Acts as a security
 *   boundary — the result is always this path or a sub-directory of it
 *   (assuming at least one file is inside it).
 * @returns The longest common parent directory, or `""` if none exists.
 */
export function findCommonRootPath(files: Iterable<string>, baseRoot?: string, allowedRoot?: string): string {
  // Parse allowedRoot segments for filtering.
  let allowedSegs: string[] | null = null;
  let allowedLen = 0;
  if (allowedRoot) {
    const norm = windows ? allowedRoot.replaceAll("\\", "/") : allowedRoot;
    allowedSegs = norm.split("/");
    // Remove trailing empty segment (trailing slash).
    if (allowedSegs.length > 1 && allowedSegs[allowedSegs.length - 1] === "") {
      allowedSegs.pop();
    }
    allowedLen = allowedSegs.length;
  }

  let common: string[] | null = null;

  for (const file of files) {
    if (!file) {
      continue;
    }

    const normalized = windows ? file.replaceAll("\\", "/") : file;
    const segments = normalized.split("/");
    segments.pop(); // remove filename — keep directory segments only

    // Filter: skip files whose directory is not under allowedRoot.
    if (allowedSegs !== null) {
      if (segments.length < allowedLen) {
        continue;
      }
      let ok = true;
      for (let j = 0; j < allowedLen; j++) {
        if (segments[j] !== allowedSegs[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        continue;
      }
    }

    if (common === null) {
      common = segments;
    } else {
      const minLen = Math.min(common.length, segments.length);
      let i = 0;
      while (i < minLen && common[i] === segments[i]) {
        i++;
      }
      common.length = i;
    }

    if (common.length === 0) {
      return "";
    }
  }

  // Intersect with baseRoot: the result is the common ancestor of
  // all file directories AND baseRoot.
  if (baseRoot && common !== null && common.length > 0) {
    const norm = windows ? baseRoot.replaceAll("\\", "/") : baseRoot;
    const baseSegs = norm.split("/");
    // Remove trailing empty segment.
    if (baseSegs.length > 1 && baseSegs[baseSegs.length - 1] === "") {
      baseSegs.pop();
    }
    const minLen = Math.min(common.length, baseSegs.length);
    let i = 0;
    while (i < minLen && common[i] === baseSegs[i]) {
      i++;
    }
    common.length = i;
  }

  if (common === null || common.length === 0) {
    return "";
  }

  // Rejoin segments.
  // On POSIX, root "/" splits to ["", ""] → after pop → [""] → join → "".
  // Return "/" for the filesystem root.
  const result = common.join("/");
  if (!result) {
    return "/";
  }

  // On Windows, a bare drive like "C:" needs a trailing slash to form a
  // valid directory path.  path.resolve handles this anyway, but returning
  // "C:/" is cleaner for callers that don't resolve.
  if (windows && result.charCodeAt(result.length - 1) === 0x3a /* ':' */) {
    return result + "/";
  }

  return result;
}

/**
 * Returns true if `rel` is exactly `".."` or starts with `"../"`.
 * On Windows, also matches `"..\\"` since backslash is a path separator.
 * On POSIX, backslash is a valid filename character so `"..\\foo"` is
 * a legitimate name, not a parent traversal.
 */
function _isParentTraversal(rel: string): boolean {
  if (rel.charCodeAt(0) !== 0x2e /* '.' */ || rel.charCodeAt(1) !== 0x2e /* '.' */) {
    return false;
  }
  if (rel.length === 2) {
    return true;
  }
  const c = rel.charCodeAt(2);
  // On Windows both / and \ are separators; on POSIX only / is.
  return c === 0x2f /* '/' */ || (windows && c === 0x5c); /* '\\' */
}
