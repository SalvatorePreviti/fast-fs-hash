#pragma once

#include <cstddef>
#include <cstdint>

namespace fast_fs_hash {

  /**
   * Hash files in parallel using XXH3-128.
   *
   * @param paths_buf   Buffer of \0-separated UTF-8 file paths.
   * @param paths_len   Length of paths_buf in bytes.
   * @param concurrency Max worker threads (0 = auto).
   * @param[in,out] output  If null, allocates via malloc(file_count * 16).
   *                        If non-null, must be >= file_count * 16 bytes.
   * @return Number of files found (null terminators in paths_buf).
   */
  size_t hash_files(const uint8_t * paths_buf, size_t paths_len, int concurrency, uint8_t *& output);

}  // namespace fast_fs_hash
