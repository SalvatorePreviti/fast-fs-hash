/**
 * find-nearest-project-files-core.h — pure C++ "nearest markers" walker (no napi).
 *
 * A trimmed-down sibling of find-project-root-core.h that only finds the
 * NEAREST occurrence (first hit walking up) of three project markers and
 * stops as soon as all three are filled:
 *
 *   - packageJson:   first `package.json` (regular file).
 *   - tsconfigJson:  first `tsconfig.json` (regular file).
 *   - nodeModules:   first `node_modules` (directory) — also detected when the
 *                    walker is currently INSIDE a node_modules tree (zero-syscall).
 *
 * No `.git` probe, no gitRoot bounding, no `root*` fields, no superproject
 * detection. The walk stops the moment all three slots are populated, or at
 * the same outer boundaries as the full project-root walker:
 *
 *   - filesystem root ("/" POSIX; drive root "X:\" Win32)
 *   - user home directory OR any ancestor of it
 *   - caller-provided stopPath OR any strict ancestor of it
 *   - depth cap (MAX_DEPTH = 128) — symlink-loop defense
 *
 * All path-manipulation helpers (resolve, trim_to_parent, stat_kind,
 * boundary checks, suffix constants) are reused from the project-root core
 * header — only the per-iteration probe set and exit condition differ.
 */

#ifndef _FAST_FS_HASH_FIND_NEAREST_PROJECT_FILES_CORE_H
#define _FAST_FS_HASH_FIND_NEAREST_PROJECT_FILES_CORE_H

#include "find-project-root-core.h"

namespace fast_fs_hash {

  struct NearestProjectFilesResult {
    std::string packageJson;
    std::string tsconfigJson;
    std::string nodeModules;

    /** Non-null error message if the walk failed before producing anything
     *  useful. The most common case is "start path is empty". */
    const char * error = nullptr;
  };

  /** Core walk. Pure C++, no napi. Thread-safe (operates on local buffers only).
   *
   *  Tolerant: never errors on a missing path. If the start path doesn't exist,
   *  the walker uses its longest existing ancestor as the walk root. The only
   *  hard error is an empty input.
   *
   *  `homePath` and `stopPath` follow the same semantics as walkProjectRoot —
   *  empty string disables the boundary. */
  inline void walkNearestProjectFiles(
      const char * input, const char * homePath, const char * stopPath,
      NearestProjectFilesResult & out) noexcept {
    using namespace find_project_root_detail;

    if (!input || !*input) {
      out.error = "findNearestProjectFiles: start path is empty";
      return;
    }

    char buf[FSH_MAX_PATH];
    bool input_is_dir = true;
    size_t buf_len = resolve_tolerant(input, buf, input_is_dir);
    if (buf_len == 0) {
      return;
    }
    if (!input_is_dir) {
      const size_t parent = trim_to_parent(buf, buf_len);
      if (parent == 0 || parent == buf_len) {
        return;
      }
      buf_len = parent;
    }

    // Canonicalize boundary paths so symlinked /var → /private/var compares.
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

    // Track which slots are still empty — once all three are filled, exit.
    bool need_pkg = true;
    bool need_tscfg = true;
    bool need_nm = true;

    for (int depth = 0; depth < MAX_DEPTH; ++depth) {
      // Boundary checks: stop BEFORE inspecting home, any ancestor of home,
      // or the caller-provided stopPath.
      if (is_at_or_above_boundary(buf, buf_len, home, home_len)) {
        break;
      }
      if (is_at_or_above_boundary(buf, buf_len, stop, stop_len)) {
        break;
      }

      if (need_pkg) {
        const size_t tip = append_suffix(buf, buf_len, SUFFIX_PACKAGE_JSON, 13);
        if (tip != buf_len) {
          if (stat_kind(buf) == 1) {
            out.packageJson.assign(buf, tip);
            need_pkg = false;
          }
          buf[buf_len] = '\0';
        }
      }

      if (need_tscfg) {
        const size_t tip = append_suffix(buf, buf_len, SUFFIX_TSCONFIG_JSON, 14);
        if (tip != buf_len) {
          if (stat_kind(buf) == 1) {
            out.tsconfigJson.assign(buf, tip);
            need_tscfg = false;
          }
          buf[buf_len] = '\0';
        }
      }

      if (need_nm) {
        // Two paths:
        //  1. Currently inside a node_modules tree → zero-syscall hit.
        //  2. Otherwise probe `<dir>/node_modules` and require a directory.
        if (dir_ends_in_node_modules(buf, buf_len)) {
          out.nodeModules.assign(buf, buf_len);
          need_nm = false;
        } else {
          const size_t tip = append_suffix(buf, buf_len, SUFFIX_NODE_MODULES, 13);
          if (tip != buf_len) {
            if (stat_kind(buf) == 2) {
              out.nodeModules.assign(buf, tip);
              need_nm = false;
            }
            buf[buf_len] = '\0';
          }
        }
      }

      // All three found → done.
      if (!need_pkg && !need_tscfg && !need_nm) {
        break;
      }

      // Stop if we're at the filesystem root (after inspecting it).
      if (is_fs_root(buf, buf_len)) {
        break;
      }

      const size_t new_len = trim_to_parent(buf, buf_len);
      if (new_len == 0 || new_len == buf_len) {
        break;
      }
      buf_len = new_len;
    }
  }

}  // namespace fast_fs_hash

#endif
