#ifndef _FAST_FS_HASH_FILE_HASH_CACHE_FORMAT_H
#define _FAST_FS_HASH_FILE_HASH_CACHE_FORMAT_H

/**
 * Binary format structs and constants for the file-hash-cache subsystem (C++).
 *
 * ### On-disk file format
 *
 * ```
 * [header:80 bytes, uncompressed][LZ4 compressed body]
 * ```
 *
 * The header is always uncompressed — magic, version, fingerprint, and file count
 * can be validated without decompression. The LZ4 body contains:
 * ```
 * [entries:n×48][udDir:m×4][pathEnds:n×4][paths:pathsLen][udPayloads]
 * ```
 *
 * In-memory dataBuf layout is identical: [header:80][body].
 * No trailing data — rootPath/cachePath are passed separately.
 * Per-file state is encoded in the high 2 bits of CacheEntry::ino.
 *
 * Header (80 bytes, all little-endian, naturally aligned):
 *
 *   Offset  Size  Field
 *   ------  ----  ------------------------------------------------
 *     0      4    Magic: 0x00485346 — bytes 'F','S','H', 0x00
 *     4      4    User version (u32)
 *     8      4    File count (u32)
 *    12      4    User data item count (u32)
 *    16     16    Fingerprint (16-byte xxHash3-128, or all-zero)
 *    32      8    payloadValue0 (f64 LE, user-defined payload)
 *    40      8    payloadValue1 (f64 LE, user-defined payload)
 *    48      8    payloadValue2 (f64 LE, user-defined payload)
 *    56      8    payloadValue3 (f64 LE, user-defined payload)
 *    64      4    Paths section byte length (u32)
 *    68      4    User data total byte length (u32)
 *    72      8    Reserved (zero)
 *
 * ### CacheStateBuf (shared JS ↔ C++ per-instance communication buffer)
 *
 * Allocated once per FileHashCache JS instance. Fixed 96-byte header followed
 * by the null-terminated UTF-8 cache path. JS writes config fields before each
 * C++ call; C++ writes result fields in OnOK (JS thread).
 *
 *   Offset  Size  Field
 *   ------  ----  ------------------------------------------------
 *     0     16    fingerprint (JS→C++, zeroed = none)
 *    16      4    version (u32, JS→C++)
 *    20      4    lockTimeoutMs (i32, JS→C++)
 *    24      4    status (u32, C++→JS)
 *    28      4    fileHandle (i32, C++↔JS, -1 = invalid)
 *    32      8    cacheFileStat0 (f64, C++→JS)
 *    40      8    cacheFileStat1 (f64, C++→JS)
 *    48      8    payloadValue0 (f64, JS→C++)
 *    56      8    payloadValue1 (f64, JS→C++)
 *    64      8    payloadValue2 (f64, JS→C++)
 *    72      8    payloadValue3 (f64, JS→C++)
 *    80      4    cancelFlag (u32, JS↔C++, volatile)
 *    84      4    fileCount (u32, JS→C++)
 *    88      4    cachePathLen (u32, JS→C++)
 *    92      4    flags (u32, JS→C++, bit 0 = resolveOnly)
 *    96      N+1  cachePath (UTF-8, null-terminated, JS→C++)
 */

#include "cache-constants.h"
#include "Hash128.h"
#include "../io/PathIndex.h"

namespace fast_fs_hash {

  // On-disk file entry (48 bytes, 16-byte aligned stride)
  //
  // High 2 bits of `ino` encode per-file state in memory (see cache-constants.h).
  // stat_into() always clears these bits, so on-disk data is clean.

  struct CacheEntry {
    uint64_t ino;  //  0: inode number (high 2 bits = state in memory)
    uint64_t mtimeNs;  //  8: modification time (nanoseconds since epoch)
    uint64_t ctimeNs;  // 16: change time (nanoseconds since epoch)
    uint64_t size;  // 24: file size (full u64)
    Hash128 contentHash;  // 32: xxHash3-128 of file contents

    static constexpr size_t STRIDE = 48;
    static constexpr size_t PATH_END_SIZE = 4;

    static_assert(sizeof(uint64_t) * 4 + sizeof(Hash128) == STRIDE);

    FSH_FORCE_INLINE void clearStat() noexcept {
      this->ino = 0;
      this->mtimeNs = 0;
      this->ctimeNs = 0;
      this->size = 0;
    }

    FSH_FORCE_INLINE void writeStat(uint64_t pIno, uint64_t pMtimeNs, uint64_t pCtimeNs, uint64_t pSize) noexcept {
      this->ino = pIno;
      this->mtimeNs = pMtimeNs;
      this->ctimeNs = pCtimeNs;
      this->size = pSize;
    }
  };

  static_assert(sizeof(CacheEntry) == CacheEntry::STRIDE, "CacheEntry must be exactly 48 bytes");
  static_assert(offsetof(CacheEntry, ino) == 0);
  static_assert(offsetof(CacheEntry, mtimeNs) == 8);
  static_assert(offsetof(CacheEntry, ctimeNs) == 16);
  static_assert(offsetof(CacheEntry, size) == 24);
  static_assert(offsetof(CacheEntry, contentHash) == 32);

  struct CacheHeader {
    uint32_t magic;  //  0: 'F','S','H',0x00 = 0x00485346
    uint32_t version;  //  4: user cache version
    uint32_t fileCount;  //  8: number of entries
    uint32_t udItemCount;  // 12: number of user data items (0 = none)
    Hash128 fingerprint;  // 16: 16-byte xxHash3-128 (or all-zero)
    double userValue0;  // 32: f64 LE, user-defined
    double userValue1;  // 40: f64 LE, user-defined
    double userValue2;  // 48: f64 LE, user-defined
    double userValue3;  // 56: f64 LE, user-defined
    uint32_t pathsLen;  // 64: byte length of packed paths section
    uint32_t udPayloadsLen;  // 68: total byte length of user data payloads
    uint64_t reserved;  // 72: reserved (zero on disk)

    static constexpr size_t SIZE = 80;
    static constexpr uint32_t MAGIC = 0x00485346u;

    /** Byte length of the decompressed body (entries+udDir+pathEnds+paths+udPayloads). */
    FSH_FORCE_INLINE size_t bodySize() const noexcept {
      return static_cast<size_t>(this->fileCount) * (CacheEntry::STRIDE + CacheEntry::PATH_END_SIZE) +
        static_cast<size_t>(this->udItemCount) * 4 + this->pathsLen + this->udPayloadsLen;
    }

    /** Full dataBuf length: header + body. */
    FSH_FORCE_INLINE size_t totalSize() const noexcept { return SIZE + this->bodySize(); }

    /** Validate header fields are within safe limits. */
    FSH_FORCE_INLINE bool validateLimits() const noexcept {
      return this->magic == MAGIC && this->fileCount <= CACHE_MAX_FILE_COUNT && this->pathsLen <= CACHE_MAX_PATHS_LEN &&
        this->udItemCount <= CACHE_MAX_FILE_COUNT && this->udPayloadsLen <= CACHE_MAX_UD_PAYLOADS &&
        this->bodySize() <= CACHE_MAX_BODY_SIZE;
    }

    /** Validate packed-paths: monotonically increasing offsets, within bounds, no traversal. */
    inline bool packedPathsValid(const uint8_t * buf) const noexcept;
  };

  static_assert(sizeof(CacheHeader) == CacheHeader::SIZE, "CacheHeader must be exactly 80 bytes");
  static_assert(CacheHeader::SIZE % 16 == 0, "header must be 16-byte aligned for CacheEntry u64/Hash128 fields");
  static_assert(offsetof(CacheHeader, magic) == 0);
  static_assert(offsetof(CacheHeader, version) == 4);
  static_assert(offsetof(CacheHeader, fileCount) == 8);
  static_assert(offsetof(CacheHeader, udItemCount) == 12);
  static_assert(offsetof(CacheHeader, fingerprint) == 16);
  static_assert(offsetof(CacheHeader, userValue0) == 32);
  static_assert(offsetof(CacheHeader, userValue1) == 40);
  static_assert(offsetof(CacheHeader, userValue2) == 48);
  static_assert(offsetof(CacheHeader, userValue3) == 56);
  static_assert(offsetof(CacheHeader, pathsLen) == 64);
  static_assert(offsetof(CacheHeader, udPayloadsLen) == 68);
  static_assert(offsetof(CacheHeader, reserved) == 72);

  /** Shared JS ↔ C++ per-instance communication buffer. */
  struct CacheStateBuf {
    Hash128 fingerprint;  //  0: 16-byte fingerprint (JS→C++, zeroed = none)
    uint32_t version;  // 16: user cache version (JS→C++)
    int32_t lockTimeoutMs;  // 20: lock timeout in ms (JS→C++, -1 = infinite)
    uint32_t status;  // 24: CacheStatus (C++→JS)
    int32_t fileHandle;  // 28: FfshFileHandle (C++↔JS, -1 = invalid)
    double cacheFileStat0;  // 32: xxHash128 of cache file stat (C++→JS)
    double cacheFileStat1;  // 40: (C++→JS)
    double userValue0;  // 48: f64 (JS→C++)
    double userValue1;  // 56: f64 (JS→C++)
    double userValue2;  // 64: f64 (JS→C++)
    double userValue3;  // 72: f64 (JS→C++)
    uint32_t cancelFlag;  // 80: 0=running, 1=cancelled (JS↔C++, volatile read)
    uint32_t fileCount;  // 84: number of file entries (JS→C++)
    uint32_t cachePathLen;  // 88: byte length of cachePath (excluding null)
    uint32_t flags;  // 92: bit 0 = resolveOnly (1 = resolve entries without writing to disk)
    // Byte 96+: null-terminated UTF-8 cachePath (immutable after construction)

    static constexpr size_t HEADER_SIZE = 96;

    /** Pointer to the null-terminated cache path at offset 96. */
    FSH_FORCE_INLINE const char * cachePath() const noexcept { return reinterpret_cast<const char *>(this) + HEADER_SIZE; }

    /** Cancel byte pointer for LockCancel (volatile read from pool thread). */
    FSH_FORCE_INLINE const volatile uint8_t * cancelByte() const noexcept {
      return reinterpret_cast<const volatile uint8_t *>(&this->cancelFlag);
    }

    /** Whether fingerprint is set (non-zero). */
    FSH_FORCE_INLINE bool hasFingerprint() const noexcept { return !this->fingerprint.is_zero(); }
  };

  static_assert(offsetof(CacheStateBuf, fingerprint) == 0);
  static_assert(offsetof(CacheStateBuf, version) == 16);
  static_assert(offsetof(CacheStateBuf, lockTimeoutMs) == 20);
  static_assert(offsetof(CacheStateBuf, status) == 24);
  static_assert(offsetof(CacheStateBuf, fileHandle) == 28);
  static_assert(offsetof(CacheStateBuf, cacheFileStat0) == 32);
  static_assert(offsetof(CacheStateBuf, cacheFileStat1) == 40);
  static_assert(offsetof(CacheStateBuf, userValue0) == 48);
  static_assert(offsetof(CacheStateBuf, userValue1) == 56);
  static_assert(offsetof(CacheStateBuf, userValue2) == 64);
  static_assert(offsetof(CacheStateBuf, userValue3) == 72);
  static_assert(offsetof(CacheStateBuf, cancelFlag) == 80);
  static_assert(offsetof(CacheStateBuf, fileCount) == 84);
  static_assert(offsetof(CacheStateBuf, cachePathLen) == 88);
  static_assert(offsetof(CacheStateBuf, flags) == 92);
  static_assert(CacheStateBuf::HEADER_SIZE == 96);

  enum class CacheStatus : uint32_t {
    UP_TO_DATE = 0,
    CHANGED = 1,
    STALE = 2,
    MISSING = 3,
    STATS_DIRTY = 4,
    LOCK_FAILED = 5,
  };

  struct UserDataSlice {
    const uint8_t * ptr = nullptr;
    size_t len = 0;
  };

  /** Cast a raw buffer pointer to CacheStateBuf. */
  FSH_FORCE_INLINE CacheStateBuf * stateOf(uint8_t * buf) { return reinterpret_cast<CacheStateBuf *>(buf); }
  FSH_FORCE_INLINE const CacheStateBuf * stateOf(const uint8_t * buf) {
    return reinterpret_cast<const CacheStateBuf *>(buf);
  }

  FSH_FORCE_INLINE CacheHeader * headerOf(uint8_t * buf) { return reinterpret_cast<CacheHeader *>(buf); }
  FSH_FORCE_INLINE const CacheHeader * headerOf(const uint8_t * buf) { return reinterpret_cast<const CacheHeader *>(buf); }

  FSH_FORCE_INLINE CacheEntry * entriesOf(uint8_t * buf) { return reinterpret_cast<CacheEntry *>(buf + CacheHeader::SIZE); }
  FSH_FORCE_INLINE const CacheEntry * entriesOf(const uint8_t * buf) {
    return reinterpret_cast<const CacheEntry *>(buf + CacheHeader::SIZE);
  }

  FSH_FORCE_INLINE uint8_t * udDirOf(uint8_t * buf, size_t fileCount) {
    return buf + CacheHeader::SIZE + fileCount * CacheEntry::STRIDE;
  }
  FSH_FORCE_INLINE const uint8_t * udDirOf(const uint8_t * buf, size_t fileCount) {
    return buf + CacheHeader::SIZE + fileCount * CacheEntry::STRIDE;
  }

  FSH_FORCE_INLINE uint32_t * pathEndsOf(uint8_t * buf, size_t fileCount, size_t udItemCount) {
    return reinterpret_cast<uint32_t *>(buf + CacheHeader::SIZE + fileCount * CacheEntry::STRIDE + udItemCount * 4);
  }
  FSH_FORCE_INLINE const uint32_t * pathEndsOf(const uint8_t * buf, size_t fileCount, size_t udItemCount) {
    return reinterpret_cast<const uint32_t *>(buf + CacheHeader::SIZE + fileCount * CacheEntry::STRIDE + udItemCount * 4);
  }

  FSH_FORCE_INLINE uint8_t * pathsOf(uint8_t * buf, size_t fileCount, size_t udItemCount) {
    return buf + CacheHeader::SIZE + fileCount * (CacheEntry::STRIDE + CacheEntry::PATH_END_SIZE) + udItemCount * 4;
  }
  FSH_FORCE_INLINE const uint8_t * pathsOf(const uint8_t * buf, size_t fileCount, size_t udItemCount) {
    return buf + CacheHeader::SIZE + fileCount * (CacheEntry::STRIDE + CacheEntry::PATH_END_SIZE) + udItemCount * 4;
  }

  FSH_FORCE_INLINE uint8_t * udPayloadsOf(uint8_t * buf, size_t fileCount, size_t udItemCount, size_t pathsLen) {
    return buf + CacheHeader::SIZE + fileCount * (CacheEntry::STRIDE + CacheEntry::PATH_END_SIZE) + udItemCount * 4 +
      pathsLen;
  }
  FSH_FORCE_INLINE const uint8_t * udPayloadsOf(const uint8_t * buf, size_t fileCount, size_t udItemCount, size_t pathsLen) {
    return buf + CacheHeader::SIZE + fileCount * (CacheEntry::STRIDE + CacheEntry::PATH_END_SIZE) + udItemCount * 4 +
      pathsLen;
  }

  inline bool CacheHeader::packedPathsValid(const uint8_t * buf) const noexcept {
    const uint32_t fc = this->fileCount;
    if (fc == 0) {
      return true;
    }
    const uint32_t pLen = this->pathsLen;
    const uint32_t * pe = pathEndsOf(buf, fc, this->udItemCount);
    const uint8_t * paths = pathsOf(buf, fc, this->udItemCount);
    uint32_t prevEnd = 0;
    for (uint32_t i = 0; i < fc; ++i) {
      const uint32_t endOff = pe[i];
      if (endOff < prevEnd || endOff > pLen) {
        return false;
      }
      const uint32_t segLen = endOff - prevEnd;
      if (segLen == 0 || is_unsafe_relative_path(paths + prevEnd, segLen)) {
        return false;
      }
      prevEnd = endOff;
    }
    return true;
  }

}  // namespace fast_fs_hash

#endif
