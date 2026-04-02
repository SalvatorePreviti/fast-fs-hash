#ifndef _FAST_FS_HASH_CACHE_HELPERS_H
#define _FAST_FS_HASH_CACHE_HELPERS_H

#include "file-hash-cache-format.h"
#include "OwnedBuf.h"
#include "ParsedUserData.h"
#include "cache-constants.h"

#include <algorithm>
#include <lz4.h>

namespace fast_fs_hash {

  /** Max threads for CacheOpen (mostly stat, occasional read+hash on change).
   *  Fewer threads optimal — stat() is kernel-bound, more threads = VFS contention. */
  static constexpr int MAX_OPEN_THREADS = 4;

  /** Max threads for CacheWriter (stat + read + hash on all unresolved entries).
   *  More threads than open — heavier I/O benefits from deeper queue depth. */
  static constexpr int MAX_WRITE_THREADS = 8;

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
   * Sets header magic/status, compresses body, writes header+body, truncates.
   * Closes the fd when done (or on error). Returns true on success.
   */
  inline bool compressAndWriteCache(
    CacheHeader * hdr, const uint8_t * body, size_t bodyLen, FfshFile & file) noexcept {
    if (bodyLen > CACHE_MAX_BODY_SIZE || bodyLen > static_cast<size_t>(LZ4_MAX_INPUT_SIZE)) [[unlikely]] {
      file.close();
      return false;
    }

    hdr->magic = CacheHeader::MAGIC;
    hdr->status = 0;

    const int srcSize = static_cast<int>(bodyLen);
    const int maxCompressed = LZ4_compressBound(srcSize);
    const size_t totalFileSize = CacheHeader::SIZE + static_cast<size_t>(maxCompressed);
    OwnedBuf<> outBuf = OwnedBuf<>::alloc(totalFileSize);
    if (!outBuf) [[unlikely]] {
      file.close();
      return false;
    }

    memcpy(outBuf.ptr, hdr, CacheHeader::SIZE);
    headerOf(outBuf.ptr)->fileHandle = FFSH_FILE_HANDLE_INVALID;

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

    file.close();
    return ok;
  }

  /**
   * Assemble the on-disk body (entries + ud directory + pathEnds + paths + ud payloads),
   * then LZ4-compress and write to the locked fd.
   *
   * @param buf          In-memory dataBuf (header + entries + paths).
   * @param hdr          Header within buf. Updated in-place (udItemCount, udPayloadsLen, magic, status).
   * @param fc           File count.
   * @param prevUdCount  The udItemCount that was in the header when the in-memory layout was built.
   *                     For CacheWriter this is the old header's udItemCount; for CacheWriteNew this is 0.
   * @param ud           Parsed user data to embed.
   * @param file         Locked fd — closed by this function.
   * @return true on successful write.
   */
  inline bool assembleAndWriteCache(
    uint8_t * buf,
    CacheHeader * hdr,
    uint32_t fc,
    uint32_t prevUdCount,
    const ParsedUserData & ud,
    FfshFile & file) noexcept {
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
      return compressAndWriteCache(hdr, &empty, 0, file);
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

    return compressAndWriteCache(hdr, body.ptr, bodyTotal, file);
  }

}  // namespace fast_fs_hash

#endif
