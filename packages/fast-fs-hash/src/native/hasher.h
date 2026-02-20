/**
 * Core hashing engine — C++ header.
 *
 * Provides a thread-pool-based parallel file hasher using xxHash (XXH3-128).
 * Returns raw 128-bit digests for maximum throughput.
 *
 * Input: A buffer of null-separated UTF-8 file paths (see encoding below).
 * Output: A flat buffer of N × 16 bytes — one 128-bit hash per file.
 *
 * Path encoding:
 *   - Paths are separated by a single \0 byte.
 *   - Empty segments (length 0) are preserved — they map to zero-hash entries.
 *   - Trailing \0 after the last path is optional.
 *
 * Unreadable files produce all-zero 16-byte hashes.
 * File paths are NOT included in any hash — only raw file content.
 *
 * UTF-8 handling:
 *   - On macOS and Linux, paths are passed directly to fopen() which
 *     accepts UTF-8 byte sequences natively.
 *   - On Windows, paths are converted from UTF-8 to wide chars
 *     and opened via _wfopen() for full Unicode support.
 */

#pragma once

#include <climits>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// ── Branch prediction hints ──────────────────────────────────────────────

#if defined(__GNUC__) || defined(__clang__)
#  define FSH_LIKELY(x) __builtin_expect(!!(x), 1)
#  define FSH_UNLIKELY(x) __builtin_expect(!!(x), 0)
#else
#  define FSH_LIKELY(x) (x)
#  define FSH_UNLIKELY(x) (x)
#endif

namespace fast_fs_hash {

#ifdef _WIN32
  /** Maximum file path length supported (bytes), including null terminator. */
  static constexpr size_t MAX_FILE_PATH = MAX_PATH + 1;
#else
  /** Maximum file path length supported (bytes), including null terminator. */
  static constexpr size_t MAX_FILE_PATH = PATH_MAX + 1;
#endif

  /**
   * Hash files in parallel using XXH3-128.
   *
   * Reads the null-separated path buffer directly — no string copies
   * except for the last segment when it lacks a trailing \0.
   *
   * @param paths_buf   Buffer of \0-separated UTF-8 file paths.
   * @param paths_len   Length of paths_buf in bytes.
   * @param concurrency Max worker threads (0 = auto).
   * @param[out] output Output: flat array of N × 16-byte per-file hashes.
   * @param[out] error_message  Error description on failure.
   * @return 0 on success, non-zero on fatal error.
   */
  int hash_files(
    const uint8_t * paths_buf,
    size_t paths_len,
    int concurrency,
    std::vector<uint8_t> & output,
    std::string & error_message);

  /** Result of reading a single file into memory. */
  struct FileReadResult {
    std::vector<uint8_t> data;
    bool success = false;
  };

  /**
   * Read files in parallel and store their raw contents.
   *
   * Same path encoding as hash_files. Files are read concurrently
   * using a thread pool with lock-free work stealing.
   *
   * @param paths_buf   Buffer of \0-separated UTF-8 file paths.
   * @param paths_len   Length of paths_buf in bytes.
   * @param concurrency Max worker threads (0 = auto).
   * @param[out] results Per-file read results (data + success flag).
   * @param[out] error_message Error description on failure.
   * @return 0 on success, non-zero on fatal error.
   */
  int read_files(
    const uint8_t * paths_buf,
    size_t paths_len,
    int concurrency,
    std::vector<FileReadResult> & results,
    std::string & error_message);

}  // namespace fast_fs_hash
