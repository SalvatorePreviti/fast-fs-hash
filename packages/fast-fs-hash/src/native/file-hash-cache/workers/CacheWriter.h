/**
 * CacheWriter: async worker that hashes remaining entries + writes to locked fd.
 *
 * Flow:
 *   1. If encodedPaths differs from dataBuf → build new dataBuf, remap old entries
 *   2. Count unresolved entries (ino state bits != DONE)
 *   3. If work needed → fork hash threads on pool
 *   4. Assemble body, LZ4 compress, write directly to the locked cache fd
 *
 * On-disk format: [header:80 uncompressed][LZ4(body)]
 */

#ifndef _FAST_FS_HASH_CACHE_WRITER_H
#define _FAST_FS_HASH_CACHE_WRITER_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../ParsedUserData.h"
#include "AddonWorker.h"

#include <lz4.h>

namespace fast_fs_hash {

  class CacheWriter final : public AddonWorker {
   public:
    CacheWriter(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      uint8_t * dataBuf,
      size_t dataLen,
      Napi::ObjectReference && dataRef,
      const uint8_t * encodedPaths,
      size_t encodedLen,
      Napi::ObjectReference && pathsRef,
      uint32_t fileCount,
      std::string cachePath,
      std::string rootPath,
      ParsedUserData && ud) :
      AddonWorker(env, deferred),
      cachePath_(std::move(cachePath)),
      rootPath_(std::move(rootPath)),
      dataRef_(std::move(dataRef)),
      pathsRef_(std::move(pathsRef)),
      dataBuf_(dataBuf),
      dataLen_(dataLen),
      encodedPaths_(encodedPaths),
      encodedLen_(encodedLen),
      fileCount_(fileCount),
      ud_(std::move(ud)) {}

    void Execute() override {
      uint8_t * buf = this->dataBuf_;
      size_t len = this->dataLen_;

      if (this->encodedPaths_ && this->encodedLen_ > 0) {
        const uint32_t newFc = this->fileCount_;
        const auto * prevHdr = headerOf(this->dataBuf_);
        const uint32_t oldFc = prevHdr->fileCount;

        // Same file list → skip remap, preserve ino state bits from CacheOpen
        const bool sameFiles = pathsMatch(this->encodedPaths_, this->encodedLen_, newFc, this->dataBuf_);

        if (!sameFiles) {
          if (!this->buildRemappedBuf_(prevHdr, oldFc, newFc)) {
            return;
          }
          buf = this->newBuf_.ptr;
          len = this->newBuf_.len;
        }
      }

      this->completeAndWrite_(buf, len);
    }

    void OnOK() override {
      const int result = this->writeSuccess_ ? 0 : -1;
      this->deferred.Resolve(Napi::Number::New(Napi::Env(this->env), result));
    }

   private:
    // Paths (used on pool thread for hash loop + disk write)
    std::string cachePath_;
    std::string rootPath_;

    // GC refs (prevent JS buffer collection while worker is in-flight)
    Napi::ObjectReference dataRef_;
    Napi::ObjectReference pathsRef_;

    // Inputs from JS
    uint8_t * dataBuf_;
    size_t dataLen_;
    const uint8_t * encodedPaths_;
    size_t encodedLen_;
    uint32_t fileCount_;
    ParsedUserData ud_;

    // Remap output (owned, freed on destruction)
    OwnedBuf<> newBuf_;

    bool writeSuccess_ = false;

    // Hash runner state (set before pool.submit, read by worker threads)
    size_t workBatch_ = 0;
    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;
    uint32_t writerFc_ = 0;

    // Work-stealing counter — own cache line to avoid false sharing
    alignas(64) mutable std::atomic<size_t> nextIndex_{0};

    static_assert(
      READ_BUFFER_SIZE + sizeof(PathResolver) <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "buffers exceed pool thread usable stack");

    FSH_NO_INLINE bool buildRemappedBuf_(const CacheHeader * prevHdr, uint32_t oldFc, uint32_t newFc) noexcept {
      const uint32_t udCount = prevHdr->udItemCount;
      const uint32_t udPLen = prevHdr->udPayloadsLen;

      this->newBuf_ = buildCacheDataBuf(this->encodedPaths_, this->encodedLen_, newFc, udCount, udPLen);

      if (!this->newBuf_) {
        this->signal("cacheWrite: failed to build dataBuf");
        return false;
      }

      auto * newHdr = headerOf(this->newBuf_.ptr);
      newHdr->version = prevHdr->version;
      newHdr->fingerprint = prevHdr->fingerprint;
      newHdr->userValue0 = prevHdr->userValue0;
      newHdr->userValue1 = prevHdr->userValue1;
      newHdr->userValue2 = prevHdr->userValue2;
      newHdr->userValue3 = prevHdr->userValue3;
      newHdr->setFileHandle(prevHdr->getFileHandle());
      newHdr->status = static_cast<uint32_t>(CacheStatus::CHANGED);

      // Merge-join: copy matched entries from old, stamp CACHE_S_HAS_OLD
      if (oldFc > 0 && newFc > 0) {
        remapEntries_(this->dataBuf_, oldFc, this->newBuf_.ptr, newFc);
      }

      // Copy user data directory + payloads from old buf
      if (udCount > 0) {
        memcpy(udDirOf(this->newBuf_.ptr, newFc), udDirOf(this->dataBuf_, oldFc), static_cast<size_t>(udCount) * 4);
        if (udPLen > 0) {
          memcpy(
            udPayloadsOf(this->newBuf_.ptr, newFc, udCount, newHdr->pathsLen),
            udPayloadsOf(this->dataBuf_, oldFc, udCount, prevHdr->pathsLen),
            udPLen);
        }
      }

      return true;
    }

    void completeAndWrite_(uint8_t * dbuf, size_t dlen) noexcept {
      if (dlen < CacheHeader::SIZE) [[unlikely]] {
        this->signal();
        return;
      }

      auto * hdr = headerOf(dbuf);
      const uint32_t fc = hdr->fileCount;

      if (!hdr->validateLimits()) [[unlikely]] {
        this->signal();
        return;
      }

      this->writerFc_ = fc;
      const uint32_t udCount = hdr->udItemCount;
      const auto st = static_cast<CacheStatus>(hdr->status);

      // Count entries that still need stat/hash (ino state != DONE)
      size_t workNeeded = 0;
      if (st != CacheStatus::UP_TO_DATE && st != CacheStatus::STATS_DIRTY && fc > 0) {
        const CacheEntry * ents = entriesOf(dbuf);
        for (uint32_t i = 0; i < fc; ++i) {
          if ((ents[i].ino & INO_STATE_MASK) != CACHE_S_DONE) {
            ++workNeeded;
          }
        }
      }

      if (workNeeded == 0) {
        this->writeFile_(dbuf, hdr, fc);
        this->signal();
        return;
      }

      this->runEntries_ = entriesOf(dbuf);
      this->runPathEnds_ = pathEndsOf(dbuf, fc, udCount);
      this->runPackedPaths_ = pathsOf(dbuf, fc, udCount);
      this->runPackedPathsSize_ = hdr->pathsLen;
      this->dataBuf_ = dbuf;

      int threadCount = ThreadPool::compute_threads(0, workNeeded, MAX_WRITE_THREADS, 4);
      this->workBatch_ = computeBatchSize(threadCount, fc);
      this->nextIndex_.store(0, std::memory_order_relaxed);

      this->addon->pool.submit(threadCount, hashProc_, this, onHashDone_, this);
    }

    static void onHashDone_(CacheWriter * self) {
      auto * buf = self->dataBuf_;
      self->writeFile_(buf, headerOf(buf), self->writerFc_);
      self->signal();
    }

    void writeFile_(uint8_t * buf, CacheHeader * hdr, uint32_t fc) noexcept {
      const size_t udCount = this->ud_.count();
      const auto * udItems = this->ud_.data();
      const bool hasUd = udCount > 0 && udCount <= CACHE_MAX_FILE_COUNT && udItems;

      // Compute ud sizes
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

      // Snapshot old udItemCount before overwriting (needed for pathEnds/paths offset)
      const uint32_t oldUdCount = hdr->udItemCount;
      hdr->udItemCount = static_cast<uint32_t>(udCount);
      hdr->udPayloadsLen = static_cast<uint32_t>(udPayloadsLen);

      const uint32_t * inMemPe = pathEndsOf(buf, fc, oldUdCount);
      const uint8_t * inMemPaths = pathsOf(buf, fc, oldUdCount);
      const uint32_t inMemPathsLen = hdr->pathsLen;
      const size_t entriesLen = static_cast<size_t>(fc) * CacheEntry::STRIDE;
      const size_t peSize = static_cast<size_t>(fc) * 4;

      const size_t bodyTotal = entriesLen + dirSize + peSize + inMemPathsLen + udPayloadsLen;
      OwnedBuf<> body = OwnedBuf<>::alloc(bodyTotal);
      if (!body) [[unlikely]] {
        return;
      }

      // Copy entries and strip ino state bits (must be 0 on disk)
      uint8_t * dst = body.ptr;
      memcpy(dst, entriesOf(buf), entriesLen);
      auto * diskEntries = reinterpret_cast<CacheEntry *>(dst);
      for (uint32_t i = 0; i < fc; ++i) {
        diskEntries[i].ino &= INO_VALUE_MASK;
      }
      dst += entriesLen;

      // Build ud directory inline
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

      // LZ4 compress and write directly to the locked fd
      this->compressAndWrite_(hdr, body.ptr, bodyTotal);
    }

    void compressAndWrite_(CacheHeader * hdr, const uint8_t * body, size_t bodyLen) noexcept {
      if (bodyLen > CACHE_MAX_BODY_SIZE || bodyLen > static_cast<size_t>(LZ4_MAX_INPUT_SIZE)) [[unlikely]] {
        return;
      }

      // Read the lock handle from the in-memory header — do NOT zero it there,
      // so that subsequent write() calls on the same open can still use the fd.
      const FfshFileHandle lh = hdr->getFileHandle();

      // Prepare the in-memory header fields that must be clean on disk
      hdr->magic = CacheHeader::MAGIC;
      hdr->status = 0;

      const int srcSize = static_cast<int>(bodyLen);
      const int maxCompressed = LZ4_compressBound(srcSize);
      const size_t totalFileSize = CacheHeader::SIZE + static_cast<size_t>(maxCompressed);
      OwnedBuf<> outBuf = OwnedBuf<>::alloc(totalFileSize);
      if (!outBuf) [[unlikely]] {
        return;
      }

      // Copy header to disk buffer, then reset the in-memory-only fields in the copy
      memcpy(outBuf.ptr, hdr, CacheHeader::SIZE);
      auto * diskHdr = headerOf(outBuf.ptr);
      diskHdr->fileHandle = FFSH_FILE_HANDLE_INVALID;

      const int compressedSize = LZ4_compress_fast(
        reinterpret_cast<const char *>(body),
        reinterpret_cast<char *>(outBuf.ptr + CacheHeader::SIZE),
        srcSize,
        maxCompressed,
        2);

      if (compressedSize <= 0) [[unlikely]] {
        return;
      }

      const size_t actualFileSize = CacheHeader::SIZE + static_cast<size_t>(compressedSize);

      // Write directly to the locked fd: seek to 0, write, truncate, fsync
      FfshFile out = FfshFile::from_file_handle(lh);
      if (!out) [[unlikely]] {
        return;
      }

      bool ok = out.seek(0) && out.write_all(outBuf.ptr, actualFileSize) && out.truncate(actualFileSize);

      // Release FfshFile without closing — the lock handle is still owned by JS
      out.release();

      this->writeSuccess_ = ok;
    }

    // ── Merge-join remap ─────────────────────────────────────────────

    static void remapEntries_(
      const uint8_t * FSH_RESTRICT oldData, uint32_t oldFc, uint8_t * FSH_RESTRICT newData, uint32_t newFc) noexcept {
      const auto * oldHdr = headerOf(oldData);
      const CacheEntry * FSH_RESTRICT oldEntries = entriesOf(oldData);
      const uint32_t * FSH_RESTRICT oldPe = pathEndsOf(oldData, oldFc, oldHdr->udItemCount);
      const uint8_t * FSH_RESTRICT oldPaths = pathsOf(oldData, oldFc, oldHdr->udItemCount);
      const size_t oldPathsLen = oldHdr->pathsLen;

      const auto * newHdr = headerOf(newData);
      CacheEntry * FSH_RESTRICT newEntries = entriesOf(newData);
      const uint32_t * FSH_RESTRICT newPe = pathEndsOf(newData, newFc, newHdr->udItemCount);
      const uint8_t * FSH_RESTRICT newPaths = pathsOf(newData, newFc, newHdr->udItemCount);
      const size_t newPathsLen = newHdr->pathsLen;

      uint32_t oldOff = 0, newOff = 0;
      size_t oi = 0, ni = 0;

      while (oi < oldFc && ni < newFc) {
        const uint32_t oldEnd = oldPe[oi];
        const uint32_t newEnd = newPe[ni];
        if (oldEnd < oldOff || oldEnd > oldPathsLen || newEnd < newOff || newEnd > newPathsLen) [[unlikely]] {
          return;
        }

        const uint32_t oldSegLen = oldEnd - oldOff;
        const uint32_t newSegLen = newEnd - newOff;
        const uint32_t minLen = oldSegLen < newSegLen ? oldSegLen : newSegLen;

        int cmp = minLen > 0 ? memcmp(oldPaths + oldOff, newPaths + newOff, minLen) : 0;
        if (cmp == 0 && oldSegLen != newSegLen) {
          cmp = oldSegLen < newSegLen ? -1 : 1;
        }

        if (cmp == 0) {
          newEntries[ni] = oldEntries[oi];
          newEntries[ni].ino = (newEntries[ni].ino & INO_VALUE_MASK) | CACHE_S_HAS_OLD;
          oldOff = oldEnd;
          newOff = newEnd;
          ++oi;
          ++ni;
        } else if (cmp < 0) {
          oldOff = oldEnd;
          ++oi;
        } else {
          newOff = newEnd;
          ++ni;
        }
      }
    }

    static void hashProc_(CacheWriter * wr) {
      alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
      wr->processHash_(rbuf);
    }

    void processHash_(unsigned char * readBuf) const {
      constexpr size_t readBufSize = READ_BUFFER_SIZE;
      const uint32_t fileCount = this->writerFc_;
      const size_t workBatch = this->workBatch_;
      CacheEntry * FSH_RESTRICT const entries = this->runEntries_;
      const uint32_t * FSH_RESTRICT const pathEnds = this->runPathEnds_;
      const uint8_t * FSH_RESTRICT const packedPaths = this->runPackedPaths_;
      const size_t packedPathsSize = this->runPackedPathsSize_;

      const char * rootPath = this->rootPath_.c_str();
      const size_t rootPathLen = this->rootPath_.size();

      DirFd dirFd(rootPath, fileCount);
      PathResolver resolver;
      resolver.init(dirFd, rootPath, rootPathLen);
      const size_t maxSegCap = FSH_MAX_PATH > resolver.prefix_len + 1 ? FSH_MAX_PATH - resolver.prefix_len - 1 : 0;

      for (;;) {
        if (this->addon->pool.is_shutdown()) [[unlikely]] {
          break;
        }
        const size_t baseIdx = this->nextIndex_.fetch_add(workBatch, std::memory_order_relaxed);
        if (baseIdx >= fileCount) [[unlikely]] {
          break;
        }
        const size_t batchEnd = baseIdx + workBatch < fileCount ? baseIdx + workBatch : fileCount;

        uint32_t pathStart;
        if (baseIdx == 0) {
          pathStart = 0;
        } else {
          pathStart = pathEnds[baseIdx - 1];
          if (pathStart > packedPathsSize) [[unlikely]] {
            break;
          }
        }

        for (size_t idx = baseIdx; idx < batchEnd; ++idx) {
          const uint32_t pathEnd = pathEnds[idx];
          if (pathEnd < pathStart || pathEnd > packedPathsSize) [[unlikely]] {
            break;
          }

          CacheEntry & entry = entries[idx];
          const uint64_t state = entry.ino & INO_STATE_MASK;

          // Already resolved by CacheOpen — skip
          if (state == CACHE_S_DONE) [[likely]] {
            pathStart = pathEnd;
            continue;
          }

          const size_t pathLen = pathEnd - pathStart;
          const uint32_t pathOffset = pathStart;
          pathStart = pathEnd;
          if (pathLen > maxSegCap) [[unlikely]] {
            continue;
          }

          if (idx + 1 < batchEnd) [[likely]] {
            FSH_PREFETCH(&entries[idx + 1]);
            FSH_PREFETCH(packedPaths + pathEnd);
          }

          resolver.resolve(packedPaths + pathOffset, pathLen);

          // Old entry from cache — stat to check if unchanged
          if (state == CACHE_S_HAS_OLD) {
            const uint64_t oldIno = entry.ino & INO_VALUE_MASK;
            const uint64_t oldMtime = entry.mtimeNs;
            const uint64_t oldCtime = entry.ctimeNs;
            const bool statOk = resolver.stat_into(entry);
            if (statOk && entry.ino == oldIno && entry.mtimeNs == oldMtime && entry.ctimeNs == oldCtime) [[likely]] {
              continue;
            }
            if (!statOk) [[unlikely]] {
              entry.contentHash.set_zero();
              continue;
            }
            resolver.hash_file(entry.contentHash, readBuf, readBufSize);
            continue;
          }

          // CacheOpen already stat'd — just hash
          if (state == CACHE_S_STAT_DONE) {
            if (entry.size == 0) {
              entry.contentHash.from_xxh128(XXH3_128bits(nullptr, 0));
            } else {
              resolver.hash_file(entry.contentHash, readBuf, readBufSize);
            }
            continue;
          }

          // New entry (NOT_CHECKED) — full stat + hash
          const bool statOk = resolver.stat_into(entry);
          if (!statOk) [[unlikely]] {
            entry.contentHash.set_zero();
            continue;
          }
          resolver.hash_file(entry.contentHash, readBuf, readBufSize);
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
