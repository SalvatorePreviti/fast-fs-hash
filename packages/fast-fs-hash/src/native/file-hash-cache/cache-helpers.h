#ifndef _FAST_FS_HASH_CACHE_HELPERS_H
#define _FAST_FS_HASH_CACHE_HELPERS_H

#include "file-hash-cache-format.h"
#include "OwnedBuf.h"
#include "ParsedUserData.h"
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
   * LZ4-compress and write a cache file body to a locked fd.
   * Sets header magic, compresses body, writes header+body, truncates.
   * Closes the fd when done (or on error).
   * On success, writes cache file stat hash to statOut[0..1].
   * Returns true on success.
   */
  inline bool compressAndWriteCache(
    CacheHeader * hdr, const uint8_t * body, size_t bodyLen, FfshFile & file, double * statOut) noexcept {
    if (bodyLen > CACHE_MAX_BODY_SIZE) [[unlikely]] {
      file.close();
      return false;
    }

    hdr->magic = CacheHeader::MAGIC;
    hdr->reserved = 0;

    const int srcSize = static_cast<int>(bodyLen);
    const int maxCompressed = LZ4_compressBound(srcSize);
    const size_t totalFileSize = CacheHeader::SIZE + static_cast<size_t>(maxCompressed);
    OwnedBuf<> outBuf = OwnedBuf<>::alloc(totalFileSize);
    if (!outBuf) [[unlikely]] {
      file.close();
      return false;
    }

    memcpy(outBuf.ptr, hdr, CacheHeader::SIZE);

    const int compressedSize = LZ4_compress_fast(
      reinterpret_cast<const char *>(body),
      reinterpret_cast<char *>(outBuf.ptr + CacheHeader::SIZE),
      srcSize,
      maxCompressed,
      2);

    if (compressedSize <= 0) [[unlikely]] {
      file.close();
      return false;
    }

    const size_t actualFileSize = CacheHeader::SIZE + static_cast<size_t>(compressedSize);

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
   * Assemble the on-disk body (entries + ud directory + pathEnds + paths + ud payloads),
   * then LZ4-compress and write to the locked fd.
   *
   * The in-memory dataBuf layout depends on how many user data items were present
   * when it was built (this affects where pathEnds and paths are located, because
   * the udDir sits between entries and pathEnds). When writing, the new udCount
   * may differ — so this function reads pathEnds/paths using the OLD layout offset
   * (prevUdCount) and assembles a fresh body with the NEW udCount layout.
   *
   * @param buf          In-memory dataBuf (header + entries + paths).
   * @param hdr          Header within buf. Updated in-place (udItemCount, udPayloadsLen, magic).
   * @param fc           File count.
   * @param prevUdCount  The udItemCount used when the in-memory layout was built.
   * @param ud           Parsed user data to embed (may have different count than prevUdCount).
   * @param file         Locked fd — closed by this function regardless of success/failure.
   * @param statOut      Output: cache file stat hash [stat0, stat1]. Written on success.
   * @return true on successful write.
   */
  inline bool assembleAndWriteCache(
    uint8_t * buf,
    CacheHeader * hdr,
    uint32_t fc,
    uint32_t prevUdCount,
    const ParsedUserData & ud,
    FfshFile & file,
    double * statOut) noexcept {
    const size_t udCount = ud.count();
    const auto * udItems = ud.data();
    const bool hasUd = udCount > 0 && udCount <= CACHE_MAX_FILE_COUNT && udItems;

    size_t dirSize = 0;
    size_t udPayloadsLen = 0;
    if (hasUd) {
      dirSize = udCount * 4;
      uint32_t cumulative = 0;
      for (size_t i = 0; i < udCount; ++i) {
        cumulative += static_cast<uint32_t>(udItems[i].len);
      }
      udPayloadsLen = cumulative;
    }

    hdr->udItemCount = static_cast<uint32_t>(udCount);
    hdr->udPayloadsLen = static_cast<uint32_t>(udPayloadsLen);

    const uint32_t * inMemPe = pathEndsOf(buf, fc, prevUdCount);
    const uint8_t * inMemPaths = pathsOf(buf, fc, prevUdCount);
    const uint32_t inMemPathsLen = hdr->pathsLen;
    const size_t entriesLen = static_cast<size_t>(fc) * CacheEntry::STRIDE;
    const size_t peSize = static_cast<size_t>(fc) * 4;

    const size_t bodyTotal = entriesLen + dirSize + peSize + inMemPathsLen + udPayloadsLen;
    if (bodyTotal == 0) {
      uint8_t empty = 0;
      return compressAndWriteCache(hdr, &empty, 0, file, statOut);
    }
    OwnedBuf<> body = OwnedBuf<>::alloc(bodyTotal);
    if (!body) [[unlikely]] {
      file.close();
      return false;
    }

    uint8_t * dst = body.ptr;
    memcpy(dst, entriesOf(buf), entriesLen);
    auto * diskEntries = reinterpret_cast<CacheEntry *>(dst);
    for (uint32_t i = 0; i < fc; ++i) {
      diskEntries[i].ino &= INO_VALUE_MASK;
    }
    dst += entriesLen;

    if (hasUd) {
      uint32_t cumulative = 0;
      for (size_t i = 0; i < udCount; ++i) {
        cumulative += static_cast<uint32_t>(udItems[i].len);
        memcpy(dst + i * 4, &cumulative, 4);
      }
      dst += dirSize;
    }

    memcpy(dst, inMemPe, peSize);
    dst += peSize;
    memcpy(dst, inMemPaths, inMemPathsLen);
    dst += inMemPathsLen;

    for (size_t i = 0; i < udCount; ++i) {
      const size_t itemLen = udItems[i].len;
      if (itemLen > 0) {
        memcpy(dst, udItems[i].ptr, itemLen);
        dst += itemLen;
      }
    }

    return compressAndWriteCache(hdr, body.ptr, bodyTotal, file, statOut);
  }

}  // namespace fast_fs_hash

#endif
