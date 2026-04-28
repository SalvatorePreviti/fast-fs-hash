/**
 * find-project-root-core.h — pure C++ project-root walker (no napi).
 *
 * Walks the parent chain of a start path recording, in a single pass:
 *   - gitRoot:             innermost directory containing .git (dir OR file).
 *                          Matches `git rev-parse --show-toplevel` semantics —
 *                          a .git file (submodule / worktree pointer) is a
 *                          valid boundary.
 *   - gitSuperRoot:        outermost directory containing a .git *directory*
 *                          (never a file). null when equal to gitRoot (i.e.
 *                          when not inside a submodule / nested worktree).
 *   - nearestPackageJson:  first package.json encountered walking up.
 *   - rootPackageJson:     last package.json encountered walking up, bounded
 *                          by the enclosing gitRoot (does not cross into the
 *                          superproject).
 *   - nearestTsconfigJson: first tsconfig.json encountered walking up.
 *   - rootTsconfigJson:    last tsconfig.json encountered, bounded by gitRoot.
 *   - nearestNodeModules:  first `node_modules/` directory encountered.
 *   - rootNodeModules:     last `node_modules/` encountered, bounded by gitRoot.
 *
 * Stop conditions (walk ends at any of these, outer-inclusive):
 *   - filesystem root ("/" POSIX; drive root "X:\" Win32)
 *   - user home directory OR any ancestor of it
 *   - depth cap (MAX_DEPTH = 128) — symlink-loop defense
 *
 * Error handling: any stat/realpath failure returns with the result populated
 * only up to the last successful step. The start path itself must resolve or
 * we report ERROR_START_PATH.
 *
 * Performance: uses a single in-place path buffer for the walk; no heap alloc
 * inside the loop. Results are snapshotted to std::string only at detection
 * points (at most 6 allocations total for a real repo).
 */

#ifndef _FAST_FS_HASH_FIND_PROJECT_ROOT_CORE_H
#define _FAST_FS_HASH_FIND_PROJECT_ROOT_CORE_H

#include "includes.h"
#include <string>

namespace fast_fs_hash {

  struct ProjectRootResult {
    std::string gitRoot;
    std::string gitSuperRoot;
    std::string nearestPackageJson;
    std::string rootPackageJson;
    std::string nearestTsconfigJson;
    std::string rootTsconfigJson;
    std::string nearestNodeModules;
    std::string rootNodeModules;

    /** Non-null error message if the walk failed before producing anything useful.
     *  The most common case is "start path does not exist". */
    const char * error = nullptr;
  };

  namespace find_project_root_detail {

    /** Maximum parent-chain depth we walk. Guards against symlink loops. */
    static constexpr int MAX_DEPTH = 128;

    /** Length of the three interest probes. */
    static constexpr size_t GIT_LEN = 4;         // "/.git"  (5 with slash)
    static constexpr size_t PKG_LEN = 12;        // "/package.json"
    static constexpr size_t TSCFG_LEN = 13;      // "/tsconfig.json"

    /** Probe suffixes — the leading separator is platform-native so emitted
     *  paths match what Node's `path.join` produces (backslash on Win32). */
#ifdef _WIN32
    static constexpr const char * SUFFIX_GIT = "\\.git";
    static constexpr const char * SUFFIX_PACKAGE_JSON = "\\package.json";
    static constexpr const char * SUFFIX_TSCONFIG_JSON = "\\tsconfig.json";
    static constexpr const char * SUFFIX_NODE_MODULES = "\\node_modules";
#else
    static constexpr const char * SUFFIX_GIT = "/.git";
    static constexpr const char * SUFFIX_PACKAGE_JSON = "/package.json";
    static constexpr const char * SUFFIX_TSCONFIG_JSON = "/tsconfig.json";
    static constexpr const char * SUFFIX_NODE_MODULES = "/node_modules";
#endif

    // Forward declarations (used by resolve_tolerant before their definitions).
    inline size_t trim_to_parent(char * buf, size_t len) noexcept;
    inline int stat_kind(const char * path) noexcept;

    /** Make a path absolute without requiring existence. Writes into `out`
     *  (≥ FSH_MAX_PATH bytes) and returns its length, or 0 on failure. */
    inline size_t make_absolute(const char * input, char * out) noexcept {
#ifdef _WIN32
      DWORD n = GetFullPathNameA(input, static_cast<DWORD>(FSH_MAX_PATH), out, nullptr);
      return (n == 0 || n >= FSH_MAX_PATH) ? 0 : static_cast<size_t>(n);
#else
      if (input[0] == '/') {
        const size_t n = strnlen(input, FSH_MAX_PATH - 1);
        if (n == 0 || n >= FSH_MAX_PATH - 1) {
          return 0;
        }
        memcpy(out, input, n);
        out[n] = '\0';
        return n;
      }
      // Relative — prepend CWD.
      if (!getcwd(out, FSH_MAX_PATH)) {
        return 0;
      }
      size_t cwd_len = strlen(out);
      if (cwd_len == 0 || cwd_len >= FSH_MAX_PATH - 2) {
        return 0;
      }
      const size_t in_len = strnlen(input, FSH_MAX_PATH - 1);
      if (cwd_len + 1 + in_len >= FSH_MAX_PATH) {
        return 0;
      }
      if (out[cwd_len - 1] != '/') {
        out[cwd_len++] = '/';
      }
      memcpy(out + cwd_len, input, in_len);
      out[cwd_len + in_len] = '\0';
      return cwd_len + in_len;
#endif
    }

    /** Resolve a path to an absolute, canonical form. Tolerant: if the path
     *  does not exist, falls back to its longest existing ancestor (canonicalized
     *  via realpath if possible). Returns 0 only if no absolute form can be
     *  produced at all (e.g. input is empty or CWD is unreachable).
     *
     *  Sets `is_dir` true if the final resolved path is a directory, false
     *  if it's a regular file, and leaves it as true (default) when the path
     *  doesn't exist. Caller walks from the parent only when `is_dir == false`. */
    inline size_t resolve_tolerant(const char * input, char * out, bool & is_dir) noexcept {
      is_dir = true;  // default: treat unknown as directory (walk from it)

      // Try the clean fast path first.
#ifndef _WIN32
      {
        char tmp[FSH_MAX_PATH];
        if (realpath(input, tmp)) {
          const size_t n = strnlen(tmp, FSH_MAX_PATH - 1);
          memcpy(out, tmp, n);
          out[n] = '\0';
          struct stat st;
          if (::stat(out, &st) == 0) {
            is_dir = S_ISDIR(st.st_mode);
          }
          return n;
        }
      }
#endif

      size_t len = make_absolute(input, out);
      if (len == 0) {
        return 0;
      }

      // Classify what we have.
      const int k = stat_kind(out);
      if (k == 2) {
        is_dir = true;
        return len;
      }
      if (k == 1) {
        is_dir = false;
        return len;
      }

      // Missing — strip components until we find an existing ancestor.
      // Treat the trimmed path as a directory (we walk from it, not its parent).
      while (len > 0) {
        const size_t parent = trim_to_parent(out, len);
        if (parent == 0 || parent == len) {
          break;
        }
        len = parent;
        if (stat_kind(out) == 2) {
          is_dir = true;
          return len;
        }
      }
      // Couldn't even find an existing ancestor — return the absolute form we had.
      // The walk loop's probes will all fail gracefully (stat_kind == 0).
      return make_absolute(input, out);
    }

    /** True when the current platform's filesystem is case-insensitive by
     *  default. Windows (NTFS), macOS (APFS/HFS+) → insensitive. Linux, BSDs →
     *  sensitive. Note: individual filesystems can override the default (case-
     *  sensitive APFS volumes, ciopfs on Linux, etc.) — this is a best-effort
     *  rule that matches what Git and other tools assume. */
#if defined(_WIN32) || defined(__APPLE__)
    static constexpr bool FS_CASE_INSENSITIVE = true;
#else
    static constexpr bool FS_CASE_INSENSITIVE = false;
#endif

    /** Case-insensitive on Win32 and macOS, case-sensitive on Linux/BSD. On
     *  Win32 also normalizes `\` and `/` so they compare equal. */
    inline bool path_equal(const char * a, size_t al, const char * b, size_t bl) noexcept {
      if (al != bl) {
        return false;
      }
      if constexpr (FS_CASE_INSENSITIVE) {
        for (size_t i = 0; i < al; ++i) {
          char ca = a[i];
          char cb = b[i];
          if (ca >= 'A' && ca <= 'Z') {
            ca = static_cast<char>(ca + 32);
          }
          if (cb >= 'A' && cb <= 'Z') {
            cb = static_cast<char>(cb + 32);
          }
#ifdef _WIN32
          // Normalize backslash vs forward-slash — both count as separators.
          if (ca == '\\') {
            ca = '/';
          }
          if (cb == '\\') {
            cb = '/';
          }
#endif
          if (ca != cb) {
            return false;
          }
        }
        return true;
      } else {
        return memcmp(a, b, al) == 0;
      }
    }

    /** True when `dir` equals `boundary` OR is a strict ancestor of it.
     *  An ancestor means: `boundary` starts with (dir + separator), so walking
     *  up into `dir` would be walking above the boundary. Used for both the
     *  home-directory boundary and the user-provided stopPath. An empty
     *  boundary is treated as "no boundary" (always returns false). */
    inline bool is_at_or_above_boundary(
        const char * dir, size_t dir_len,
        const char * boundary, size_t boundary_len) noexcept {
      if (boundary_len == 0) {
        return false;
      }
      if (path_equal(dir, dir_len, boundary, boundary_len)) {
        return true;
      }
      if (dir_len < boundary_len) {
        // dir may be an ancestor of boundary:
        //   boundary[0..dir_len] == dir AND boundary[dir_len] is a separator.
        if (path_equal(dir, dir_len, boundary, dir_len)
            && (boundary[dir_len] == '/' || boundary[dir_len] == '\\')) {
          return true;
        }
      }
      return false;
    }

    /** True when `dir` is the filesystem root. POSIX: "/". Win32: "X:\" or "X:/". */
    inline bool is_fs_root(const char * dir, size_t dir_len) noexcept {
#ifdef _WIN32
      // Drive-absolute root is 3 chars: "C:\" or "C:/".
      if (dir_len == 3 && dir[1] == ':' && (dir[2] == '\\' || dir[2] == '/')) {
        return true;
      }
      // UNC root "\\server\share" — treat as root-ish; no further parent.
      if (dir_len >= 2 && (dir[0] == '\\' || dir[0] == '/') && (dir[1] == '\\' || dir[1] == '/')) {
        // Find the third separator; if there is none after the share name, it's the root.
        int seps = 0;
        for (size_t i = 2; i < dir_len; ++i) {
          if (dir[i] == '\\' || dir[i] == '/') {
            ++seps;
            if (seps == 2) {
              return false;
            }
          }
        }
        return true;
      }
      return false;
#else
      return dir_len == 1 && dir[0] == '/';
#endif
    }

    /** Trim `buf` in place to its parent directory. Returns the new length.
     *  Returns 0 if there is no parent (already at root). */
    inline size_t trim_to_parent(char * buf, size_t len) noexcept {
      if (len == 0) {
        return 0;
      }
#ifdef _WIN32
      // Drive-root or UNC-root cannot be trimmed further.
      if (is_fs_root(buf, len)) {
        return len;  // caller checks is_fs_root separately; leave as-is.
      }
      // Strip trailing separator (except at root, handled above).
      while (len > 0 && (buf[len - 1] == '\\' || buf[len - 1] == '/')) {
        buf[--len] = '\0';
      }
      // Find last separator.
      size_t i = len;
      while (i > 0 && buf[i - 1] != '\\' && buf[i - 1] != '/') {
        --i;
      }
      if (i <= 3 && buf[1] == ':') {
        // "C:\foo" → parent is "C:\" (length 3).
        buf[2] = '\\';
        buf[3] = '\0';
        return 3;
      }
      if (i == 0) {
        // No separator found — already at a leaf relative path, shouldn't happen
        // after canonicalization. Defensive.
        buf[0] = '\0';
        return 0;
      }
      // Trim the trailing "/name" leaving the separator's predecessor.
      buf[i - 1] = '\0';
      return i - 1;
#else
      if (len == 1 && buf[0] == '/') {
        return 1;  // "/" has no parent.
      }
      // Strip trailing slash (shouldn't happen after realpath, defensive).
      while (len > 1 && buf[len - 1] == '/') {
        buf[--len] = '\0';
      }
      // Find last '/'.
      size_t i = len;
      while (i > 0 && buf[i - 1] != '/') {
        --i;
      }
      if (i == 0) {
        buf[0] = '\0';
        return 0;
      }
      if (i == 1) {
        // Parent is "/".
        buf[1] = '\0';
        return 1;
      }
      buf[i - 1] = '\0';
      return i - 1;
#endif
    }

    /** stat helper returning 0 on missing, 1 on regular file, 2 on directory, -1 on error. */
    inline int stat_kind(const char * path) noexcept {
#ifdef _WIN32
      DWORD attrs = GetFileAttributesA(path);
      if (attrs == INVALID_FILE_ATTRIBUTES) {
        const DWORD err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) {
          return 0;
        }
        return -1;
      }
      return (attrs & FILE_ATTRIBUTE_DIRECTORY) ? 2 : 1;
#else
      struct stat st;
      if (::stat(path, &st) != 0) {
        return (errno == ENOENT || errno == ENOTDIR) ? 0 : -1;
      }
      if (S_ISDIR(st.st_mode)) {
        return 2;
      }
      if (S_ISREG(st.st_mode)) {
        return 1;
      }
      return 0;  // symlink to nothing, socket, etc. — ignore
#endif
    }

    /** True when the last path segment of `dir` equals `"node_modules"` (exact,
     *  case-sensitivity follows the platform FS rule). Used to detect that the
     *  walker is currently *inside* a node_modules tree, in which case the
     *  directory itself already qualifies as a node_modules hit — no probe
     *  syscall needed.
     *
     *  `dir` must be an absolute path with no trailing separator (canonicalized
     *  form). On success the length of the `node_modules` segment is 12. */
    inline bool dir_ends_in_node_modules(const char * dir, size_t dir_len) noexcept {
      constexpr size_t NM_LEN = 12;  // strlen("node_modules")
      if (dir_len < NM_LEN + 1) {
        return false;  // needs at least "/node_modules"
      }
      const char sep = dir[dir_len - NM_LEN - 1];
      if (sep != '/' && sep != '\\') {
        return false;
      }
      return path_equal(dir + dir_len - NM_LEN, NM_LEN, "node_modules", NM_LEN);
    }

    /** Append a fixed suffix to `buf` (length `len`). Returns new length.
     *  Assumes `buf` has enough room (FSH_MAX_PATH). */
    inline size_t append_suffix(char * buf, size_t len, const char * suffix, size_t slen) noexcept {
      if (len + slen + 1 > FSH_MAX_PATH) {
        return len;  // refuse to overflow; caller treats as "not found".
      }
      memcpy(buf + len, suffix, slen);
      buf[len + slen] = '\0';
      return len + slen;
    }

  }  // namespace find_project_root_detail

  /** Core walk. Pure C++, no napi. Thread-safe (operates on local buffers only).
   *
   *  Tolerant: never errors on a missing path. If the start path doesn't exist,
   *  the walker uses its longest existing ancestor as the walk root. If even
   *  that fails, it walks the absolute form as-is — all probes will simply miss
   *  and every field stays empty. The only hard error is an empty input.
   *
   *  `homePath` is the user's home directory — an upper boundary of the walk.
   *  The JS binding layer resolves this from `os.homedir()` / `process.env.HOME`
   *  and passes it here (this keeps Node worker threads honest — each worker's
   *  own `process.env` is visible to JS but not to libc `getenv`). Pass an
   *  empty string to disable the home boundary entirely.
   *
   *  `stopPath` is an optional caller-provided boundary: if the walker reaches
   *  this path (or any strict ancestor of it), the walk stops without probing.
   *  Useful for scoping searches to a known workspace root or halting at a
   *  pre-discovered marker. Empty string disables the boundary. */
  inline void walkProjectRoot(
      const char * input, const char * homePath, const char * stopPath,
      ProjectRootResult & out) noexcept {
    using namespace find_project_root_detail;

    if (!input || !*input) {
      out.error = "findProjectRoot: start path is empty";
      return;
    }

    char buf[FSH_MAX_PATH];
    bool input_is_dir = true;
    size_t buf_len = resolve_tolerant(input, buf, input_is_dir);
    if (buf_len == 0) {
      // Couldn't even derive an absolute form — leave everything null.
      return;
    }
    // If the start path was a regular file, begin walking from its parent directory.
    if (!input_is_dir) {
      const size_t parent = trim_to_parent(buf, buf_len);
      if (parent == 0 || parent == buf_len) {
        return;  // no parent → leave everything null
      }
      buf_len = parent;
    }

    // Canonicalize both caller-provided boundaries via the same tolerant
    // resolver so that /var → /private/var (macOS) and symlinked paths compare
    // correctly against `buf`.
    char home[FSH_MAX_PATH];
    size_t home_len = 0;
    if (homePath && *homePath) {
      bool h_is_dir = true;
      home_len = resolve_tolerant(homePath, home, h_is_dir);
      (void)h_is_dir;
    }
    char stop[FSH_MAX_PATH];
    size_t stop_len = 0;
    if (stopPath && *stopPath) {
      bool s_is_dir = true;
      stop_len = resolve_tolerant(stopPath, stop, s_is_dir);
      (void)s_is_dir;
    }

    // Track whether we've already recorded a gitRoot. Once set, rootPackageJson
    // and rootTsconfigJson stop updating (they're bounded by the enclosing repo).
    bool git_bounded = false;

    for (int depth = 0; depth < MAX_DEPTH; ++depth) {
      // Boundary checks: stop BEFORE inspecting home, any ancestor of home,
      // or the caller-provided stopPath.
      if (is_at_or_above_boundary(buf, buf_len, home, home_len)) {
        break;
      }
      if (is_at_or_above_boundary(buf, buf_len, stop, stop_len)) {
        break;
      }

      // Probe .git
      {
        const size_t tip = append_suffix(buf, buf_len, SUFFIX_GIT, 5);
        if (tip != buf_len) {
          const int kind = stat_kind(buf);
          if (kind > 0) {
            // First-hit wins for gitRoot (innermost).
            if (out.gitRoot.empty()) {
              out.gitRoot.assign(buf, buf_len);
              git_bounded = true;
            }
            // Last-hit wins for gitSuperRoot, but ONLY for .git directories
            // (never files — a .git file is a pointer, not a superproject root).
            if (kind == 2) {
              out.gitSuperRoot.assign(buf, buf_len);
            }
          }
          buf[buf_len] = '\0';  // strip "/.git"
        }
      }

      // package.json / tsconfig.json are only inspected inside the enclosing
      // repository. Once we've crossed the .git boundary (i.e. we're strictly
      // above gitRoot), they're part of a superproject we don't belong to.
      // The gitRoot directory itself is still in-bounds and may contribute
      // both nearest* and root* values.
      const bool in_repo = !git_bounded
        || (out.gitRoot.size() == buf_len && memcmp(out.gitRoot.data(), buf, buf_len) == 0);

      if (in_repo) {
        // Probe package.json
        {
          const size_t tip = append_suffix(buf, buf_len, SUFFIX_PACKAGE_JSON, 13);
          if (tip != buf_len) {
            if (stat_kind(buf) == 1) {
              if (out.nearestPackageJson.empty()) {
                out.nearestPackageJson.assign(buf, tip);
              }
              out.rootPackageJson.assign(buf, tip);
            }
            buf[buf_len] = '\0';
          }
        }

        // Probe tsconfig.json
        {
          const size_t tip = append_suffix(buf, buf_len, SUFFIX_TSCONFIG_JSON, 14);
          if (tip != buf_len) {
            if (stat_kind(buf) == 1) {
              if (out.nearestTsconfigJson.empty()) {
                out.nearestTsconfigJson.assign(buf, tip);
              }
              out.rootTsconfigJson.assign(buf, tip);
            }
            buf[buf_len] = '\0';
          }
        }

        // node_modules detection. Two paths:
        //   1. The walker is currently *at* a directory whose last segment is
        //      `node_modules`. That directory IS a node_modules — no probe
        //      needed, no syscall. Handles "started inside node_modules".
        //   2. Otherwise, probe `buf/node_modules` and stat. Must be a real
        //      directory (a stray `node_modules` regular file wouldn't hold
        //      installed packages).
        if (dir_ends_in_node_modules(buf, buf_len)) {
          if (out.nearestNodeModules.empty()) {
            out.nearestNodeModules.assign(buf, buf_len);
          }
          out.rootNodeModules.assign(buf, buf_len);
        } else {
          const size_t tip = append_suffix(buf, buf_len, SUFFIX_NODE_MODULES, 13);
          if (tip != buf_len) {
            if (stat_kind(buf) == 2) {
              if (out.nearestNodeModules.empty()) {
                out.nearestNodeModules.assign(buf, tip);
              }
              out.rootNodeModules.assign(buf, tip);
            }
            buf[buf_len] = '\0';
          }
        }
      }

      // Stop if we're at the filesystem root (after inspecting it).
      if (is_fs_root(buf, buf_len)) {
        break;
      }

      // Walk up to parent.
      const size_t new_len = trim_to_parent(buf, buf_len);
      if (new_len == 0 || new_len == buf_len) {
        break;  // no progress → avoid infinite loop
      }
      buf_len = new_len;
    }

    // Final cleanup: if gitSuperRoot ended up equal to gitRoot, clear it
    // (they're "equal" meaning we never saw a nested .git directory).
    if (!out.gitSuperRoot.empty() && out.gitSuperRoot == out.gitRoot) {
      out.gitSuperRoot.clear();
    }
  }

}  // namespace fast_fs_hash

#endif
