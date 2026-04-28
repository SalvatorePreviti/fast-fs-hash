#ifndef _FAST_FS_HASH_CACHE_HELPERS_H
#define _FAST_FS_HASH_CACHE_HELPERS_H

#include "file-hash-cache-format.h"
#include "OwnedBuf.h"
#include "ParsedPayloads.h"
#include "cache-constants.h"

#include <algorithm>
#include <lz4.h>

namespace fast_fs_hash {

  /** Compute cache file stat hash from an open fd. Writes two f64 values to statOut. */
  inline void stampCacheFileStat(double * statOut, int fd) noexcept {
    CacheEntry tmp{};
    if (FfshFile::fstat_into(fd, tmp)) {
      uint64_t fields[4] = {tmp.ino & INO_VALUE_MASK, tmp.ctimeNs, tmp.mtimeNs, tmp.size};
      Hash128 h;
      h.from_xxh128(XXH3_128bits(fields, sizeof(fields)));
      memcpy(&statOut[0], &h.bytes[0], 8);
      memcpy(&statOut[1], &h.bytes[8], 8);
    } else {
      statOut[0] = 0;
      statOut[1] = 0;
    }
  }

  /** Initial threads for CacheOpen stat-match (stat-only is kernel-bound, 4 is optimal). */
  static constexpr int MAX_OPEN_THREADS = 4;

  /** Max threads for cache I/O (stat + read + hash). Used by CacheWriter/CacheWriteNew,
   *  and as the expand ceiling for CacheOpen when it detects files needing hash. */
  static constexpr int MAX_CACHE_IO_THREADS = 8;

  /** Compute batch size for work-stealing and clamp threadCount to useful range. */
  inline size_t computeBatchSize(int & threadCount, size_t fileCount) {
    const size_t batch = std::clamp(fileCount / static_cast<size_t>(threadCount * 8), size_t{4}, size_t{64});

    const int maxUseful = static_cast<int>((fileCount + batch - 1) / batch);
    if (threadCount > maxUseful) {
      threadCount = maxUseful;
    }
    if (threadCount < 1) [[unlikely]] {
      threadCount = 1;
    }

    return batch;
  }

  /**
   * Write [header][uncompressed section][LZ4(body)] to a locked fd.
   *
   * Sets header magic, compresses body, writes header + uncompressed section +
   * compressed body, truncates. Closes the fd when done (or on error).
   * On success, writes cache file stat hash to statOut[0..1].
   *
   * @param hdr          Header (magic + reserved updated in place).
   * @param uncompressed Pointer to the uncompressed payloads section (may be null if uncSize==0).
   * @param uncSize      Byte length of the uncompressed section (dir + payload bytes).
   * @param body         Pointer to the body to LZ4-compress (may be empty).
   * @param bodyLen      Byte length of the body.
   * @param file         Locked fd — closed by this function.
   * @param statOut      Output: cache file stat hash [stat0, stat1].
   */
  inline bool compressAndWriteCache(
    CacheHeader * hdr,
    const uint8_t * uncompressed,
    size_t uncSize,
    const uint8_t * body,
    size_t bodyLen,
    FfshFile & file,
    double * statOut) noexcept {
    if (bodyLen > CACHE_MAX_BODY_SIZE) [[unlikely]] {
      file.close();
      return false;
    }

    hdr->magic = CacheHeader::MAGIC;

    const int srcSize = static_cast<int>(bodyLen);
    const int maxCompressed = bodyLen > 0 ? LZ4_compressBound(srcSize) : 0;
    const size_t totalFileSize = CacheHeader::SIZE + uncSize + static_cast<size_t>(maxCompressed);
    OwnedBuf<> outBuf = OwnedBuf<>::alloc(totalFileSize > 0 ? totalFileSize : CacheHeader::SIZE);
    if (!outBuf) [[unlikely]] {
      file.close();
      return false;
    }

    memcpy(outBuf.ptr, hdr, CacheHeader::SIZE);
    if (uncSize > 0 && uncompressed) {
      memcpy(outBuf.ptr + CacheHeader::SIZE, uncompressed, uncSize);
    }

    int compressedSize = 0;
    if (bodyLen > 0) {
      compressedSize = LZ4_compress_fast(
        reinterpret_cast<const char *>(body),
        reinterpret_cast<char *>(outBuf.ptr + CacheHeader::SIZE + uncSize),
        srcSize,
        maxCompressed,
        2);

      if (compressedSize <= 0) [[unlikely]] {
        file.close();
        return false;
      }
    }

    const size_t actualFileSize = CacheHeader::SIZE + uncSize + static_cast<size_t>(compressedSize);

    if (!file) [[unlikely]] {
      return false;
    }

    file.preallocate(actualFileSize);
    const bool ok = file.seek(0) && file.write_all(outBuf.ptr, actualFileSize) && file.truncate(actualFileSize);

    if (ok && statOut) {
      stampCacheFileStat(statOut, file.fd);
    }

    file.close();
    return ok;
  }

  /**
   * Assemble the uncompressed section and compressed body from the in-memory
   * dataBuf, then write them to the locked fd.
   *
   * The in-memory dataBuf layout depends on how many uncompressed/compressed
   * items were present when it was built (this affects where the body starts
   * and where pathEnds/paths live inside the body). When writing, the new
   * counts may differ — so this function reads the body using the OLD layout
   * offsets and assembles a fresh uncompressed section + fresh body using the
   * NEW counts.
   *
   * @param buf          In-memory dataBuf.
   * @param hdr          Header within buf. Updated in-place.
   * @param fc           File count.
   * @param prevCompCount     Previous compressed item count (for reading current body).
   * @param prevUncCount      Previous uncompressed item count (for reading current body).
   * @param prevUncBytesLen   Previous uncompressed payload bytes length (for reading current body).
   * @param compressed   New compressed payloads to embed (may differ from previous).
   * @param uncompressed New uncompressed payloads to embed (may differ from previous).
   * @param file         Locked fd — closed by this function.
   * @param statOut      Output: cache file stat hash [stat0, stat1]. Written on success.
   */
  inline bool assembleAndWriteCache(
    uint8_t * buf,
    CacheHeader * hdr,
    uint32_t fc,
    uint32_t prevCompCount,
    uint32_t prevUncCount,
    uint32_t prevUncBytesLen,
    const ParsedPayloads & compressed,
    const ParsedPayloads & uncompressed,
    FfshFile & file,
    double * statOut) noexcept {
    // - Compute new compressed section sizes
    const size_t newCompCount = compressed.count();
    const auto * compItems = compressed.data();
    const bool hasComp = newCompCount > 0 && newCompCount <= CACHE_MAX_FILE_COUNT && compItems;

    size_t compDirSize = 0;
    size_t compBytesLen = 0;
    if (hasComp) {
      compDirSize = newCompCount * 4;
      uint64_t cumulative = 0;
      for (size_t i = 0; i < newCompCount; ++i) {
        cumulative += compItems[i].len;
      }
      if (cumulative > CACHE_MAX_COMPRESSED_PAYLOADS) [[unlikely]] {
        file.close();
        return false;
      }
      compBytesLen = static_cast<size_t>(cumulative);
    }

    // - Compute new uncompressed section sizes
    const size_t newUncCount = uncompressed.count();
    const auto * uncItems = uncompressed.data();
    const bool hasUnc = newUncCount > 0 && newUncCount <= CACHE_MAX_FILE_COUNT && uncItems;

    size_t uncDirSize = 0;
    size_t uncBytesLen = 0;
    if (hasUnc) {
      uncDirSize = newUncCount * 4;
      uint64_t cumulative = 0;
      for (size_t i = 0; i < newUncCount; ++i) {
        cumulative += uncItems[i].len;
      }
      if (cumulative > CACHE_MAX_UNCOMPRESSED_PAYLOADS) [[unlikely]] {
        file.close();
        return false;
      }
      uncBytesLen = static_cast<size_t>(cumulative);
    }

    const size_t uncSectionSize = uncDirSize + uncBytesLen;

    // - Update header
    hdr->compressedPayloadItemCount = static_cast<uint32_t>(newCompCount);
    hdr->compressedPayloadsLen = static_cast<uint32_t>(compBytesLen);
    hdr->uncompressedPayloadItemCount = static_cast<uint32_t>(newUncCount);
    hdr->uncompressedPayloadsLen = static_cast<uint32_t>(uncBytesLen);

    // - Read source path data using PREVIOUS in-memory layout
    const uint32_t * inMemPe = pathEndsOf(buf, fc, prevCompCount, prevUncCount, prevUncBytesLen);
    const uint8_t * inMemPaths = pathsOf(buf, fc, prevCompCount, prevUncCount, prevUncBytesLen);
    const CacheEntry * inMemEntries = entriesOf(buf, prevUncCount, prevUncBytesLen);
    const uint32_t inMemPathsLen = hdr->pathsLen;
    const size_t entriesLen = static_cast<size_t>(fc) * CacheEntry::STRIDE;
    const size_t peSize = static_cast<size_t>(fc) * 4;

    const size_t bodyTotal = entriesLen + compDirSize + peSize + inMemPathsLen + compBytesLen;

    OwnedBuf<> uncBuf;
    uint8_t * uncPtr = nullptr;
    if (uncSectionSize > 0) {
      uncBuf = OwnedBuf<>::alloc(uncSectionSize);
      if (!uncBuf) [[unlikely]] {
        file.close();
        return false;
      }
      uncPtr = uncBuf.ptr;
      if (hasUnc) {
        auto * dir = reinterpret_cast<uint32_t *>(uncPtr);
        uint8_t * bytesDst = uncPtr + uncDirSize;
        uint32_t cumulative = 0;
        for (size_t i = 0; i < newUncCount; ++i) {
          const size_t itemLen = uncItems[i].len;
          if (itemLen > 0) {
            memcpy(bytesDst + cumulative, uncItems[i].ptr, itemLen);
          }
          cumulative += static_cast<uint32_t>(itemLen);
          dir[i] = cumulative;
        }
      }
    }

    // - Assemble the new body
    if (bodyTotal == 0) {
      return compressAndWriteCache(hdr, uncPtr, uncSectionSize, nullptr, 0, file, statOut);
    }
    OwnedBuf<> body = OwnedBuf<>::alloc(bodyTotal);
    if (!body) [[unlikely]] {
      file.close();
      return false;
    }

    uint8_t * dst = body.ptr;
    memcpy(dst, inMemEntries, entriesLen);
    auto * diskEntries = reinterpret_cast<CacheEntry *>(dst);
    for (uint32_t i = 0; i < fc; ++i) {
      diskEntries[i].ino &= INO_VALUE_MASK;
    }
    dst += entriesLen;

    if (hasComp) {
      auto * dir = reinterpret_cast<uint32_t *>(dst);
      uint32_t cumulative = 0;
      for (size_t i = 0; i < newCompCount; ++i) {
        cumulative += static_cast<uint32_t>(compItems[i].len);
        dir[i] = cumulative;
      }
      dst += compDirSize;
    }

    memcpy(dst, inMemPe, peSize);
    dst += peSize;
    memcpy(dst, inMemPaths, inMemPathsLen);
    dst += inMemPathsLen;

    for (size_t i = 0; i < newCompCount; ++i) {
      const size_t itemLen = compItems[i].len;
      if (itemLen > 0) {
        memcpy(dst, compItems[i].ptr, itemLen);
        dst += itemLen;
      }
    }

    return compressAndWriteCache(hdr, uncPtr, uncSectionSize, body.ptr, bodyTotal, file, statOut);
  }

}  // namespace fast_fs_hash

#endif
