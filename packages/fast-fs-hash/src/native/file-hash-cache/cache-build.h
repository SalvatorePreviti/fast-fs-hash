/**
 * cache-build.h — Build a new dataBuf from encoded paths.
 * Pure buffer construction, no disk I/O, no stat-match, no threading.
 */

#ifndef _FAST_FS_HASH_CACHE_BUILD_H
#define _FAST_FS_HASH_CACHE_BUILD_H

#include "file-hash-cache-format.h"
#include "OwnedBuf.h"

namespace fast_fs_hash {

  /**
   * Check if encoded paths match the pathEnds+paths in a dataBuf.
   *
   * Two representations of the same file list:
   *   - `encoded`: NUL-separated flat buffer ("a.ts\0b.ts\0c.ts\0")
   *   - `dataBuf`: header + entries + pathEnds[] + packed paths (no NULs)
   *
   * Single pass using pathEnds offsets for O(1) per-segment length,
   * then memcmp + NUL-position verification. This double-checks that
   * the encoded input is well-formed (correct NUL placement).
   *
   * @param encoded     NUL-separated file paths from JS.
   * @param encodedLen  Total byte length of encoded (paths + NULs).
   * @param fileCount   Expected number of files.
   * @param dataBuf     Existing in-memory cache buffer.
   * @return true if the file lists are identical.
   */
  inline bool pathsMatch(
      const uint8_t * encoded, size_t encodedLen, uint32_t fileCount,
      const uint8_t * dataBuf) noexcept {

    if (fileCount == 0 || fileCount > CACHE_MAX_FILE_COUNT) {
      return false;
    }

    const auto * hdr = headerOf(dataBuf);
    if (hdr->fileCount != fileCount) {
      return false;
    }

    const uint32_t pathsLen = hdr->pathsLen;
    // encodedLen must equal pathBytes + one NUL per file
    if (encodedLen != static_cast<size_t>(pathsLen) + fileCount) {
      return false;
    }

    const uint32_t * pe = pathEndsOf(dataBuf, fileCount, hdr->udItemCount);
    const uint8_t * paths = pathsOf(dataBuf, fileCount, hdr->udItemCount);
    const uint8_t * p = encoded;
    uint32_t prevEnd = 0;

    for (uint32_t i = 0; i < fileCount; ++i) {
      const uint32_t end = pe[i];
      if (end < prevEnd || end > pathsLen) [[unlikely]] {
        return false;
      }
      const uint32_t segLen = end - prevEnd;
      if (p[segLen] != 0) {
        return false;
      }
      if (segLen > 0 && memcmp(p, paths + prevEnd, segLen) != 0) {
        return false;
      }
      p += segLen + 1;
      prevEnd = end;
    }

    return true;
  }

  /**
   * Build a new dataBuf from encoded paths. Allocates:
   *   [header:80][entries:n×48][udDir:m×4][pathEnds:n×4][paths][udPayloads]
   *
   * When udItemCount > 0, space is pre-allocated for udDir + udPayloads.
   * Only fills header fields and path data. Entries, udDir, udPayloads are zeroed.
   * On failure, returns an empty OwnedBuf.
   */
  inline OwnedBuf<> buildCacheDataBuf(
      const uint8_t * encoded_paths, size_t encoded_len, uint32_t fileCount,
      uint32_t udItemCount = 0, uint32_t udPayloadsLen = 0) noexcept {

    if (fileCount == 0) {
      auto buf = OwnedBuf<>::calloc(CacheHeader::SIZE);
      if (buf) {
        headerOf(buf.ptr)->fileHandle = FFSH_FILE_HANDLE_INVALID;
      }
      return buf;
    }

    if (fileCount > CACHE_MAX_FILE_COUNT) {
      return {};
    }

    PathIndex<true> idx(encoded_paths, encoded_len, fileCount);
    if (idx.oom() || idx.has_unsafe() || idx.count != fileCount) {
      return {};
    }

    const size_t totalPathBytes = encoded_len - fileCount;
    if (totalPathBytes > CACHE_MAX_PATHS_LEN) {
      return {};
    }

    const size_t total = CacheHeader::SIZE
      + static_cast<size_t>(fileCount) * (CacheEntry::STRIDE + CacheEntry::PATH_END_SIZE)
      + static_cast<size_t>(udItemCount) * 4
      + totalPathBytes
      + udPayloadsLen;
    auto * raw = static_cast<uint8_t *>(calloc(1, total));
    if (!raw) [[unlikely]] {
      return {};
    }

    auto * hdr = headerOf(raw);
    uint32_t * pe = pathEndsOf(raw, fileCount, udItemCount);
    uint8_t * pathsDst = pathsOf(raw, fileCount, udItemCount);
    uint32_t cumulativeOffset = 0;

    const uint8_t * const encodedEnd = encoded_paths + encoded_len;
    for (size_t i = 0; i < fileCount; ++i) {
      const auto * seg = reinterpret_cast<const uint8_t *>(idx.segments[i]);
      const auto * next =
        (i + 1 < fileCount) ? reinterpret_cast<const uint8_t *>(idx.segments[i + 1]) : encodedEnd;
      const size_t segLen = static_cast<size_t>(next - seg) - 1;

      memcpy(pathsDst + cumulativeOffset, seg, segLen);
      cumulativeOffset += static_cast<uint32_t>(segLen);
      pe[i] = cumulativeOffset;
    }

    hdr->magic = CacheHeader::MAGIC;
    hdr->fileCount = fileCount;
    hdr->pathsLen = static_cast<uint32_t>(totalPathBytes);
    hdr->udItemCount = udItemCount;
    hdr->udPayloadsLen = udPayloadsLen;
    hdr->fileHandle = FFSH_FILE_HANDLE_INVALID;

    return OwnedBuf<>::take(raw, total);
  }

}  // namespace fast_fs_hash

#endif
