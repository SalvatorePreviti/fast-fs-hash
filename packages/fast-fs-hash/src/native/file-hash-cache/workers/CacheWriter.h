#ifndef _FAST_FS_HASH_CACHE_WRITER_H
#define _FAST_FS_HASH_CACHE_WRITER_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../ParsedUserData.h"
#include "AddonWorker.h"

namespace fast_fs_hash {

  /**
   * Async worker that hashes remaining entries + writes to locked fd.
   *
   * Flow:
   *   1. If encodedPaths differs from dataBuf → build new dataBuf, remap old entries
   *   2. Count unresolved entries (ino state bits != DONE)
   *   3. If work needed → fork hash threads on pool
   *   4. Assemble body, LZ4 compress, write directly to the locked cache fd
   *
   * On-disk format: [header:96 uncompressed][LZ4(body)]
   */
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
      ParsedUserData && ud,
      FfshFile && lockedFile,
      const volatile uint8_t * cancelByte = nullptr,
      Napi::ObjectReference && cancelRef = {}) :
      AddonWorker(env, deferred),
      dataBuf_(dataBuf),
      dataLen_(dataLen),
      encodedPaths_(encodedPaths),
      encodedLen_(encodedLen),
      fileCount_(fileCount),
      lockedFile_(std::move(lockedFile)),
      cachePath_(std::move(cachePath)),
      rootPath_(std::move(rootPath)),
      ud_(std::move(ud)),
      dataRef_(std::move(dataRef)),
      pathsRef_(std::move(pathsRef)),
      cancelRef_(std::move(cancelRef)) {
      this->cancel_.cancelByte_ = cancelByte;
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.add(&this->cancel_);
      }
    }

    ~CacheWriter() override {
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.remove(&this->cancel_);
      }
      this->cancel_.fire();
    }

    void Execute() override {
      AddonData * d = this->addon;
      if (this->cancel_.is_fired() || d->pool.is_shutdown()) [[unlikely]] {
        this->signalAndClose_();
        return;
      }

      uint8_t * buf = this->dataBuf_;
      size_t len = this->dataLen_;

      if (this->encodedPaths_ && this->encodedLen_ > 0) {
        const uint32_t newFc = this->fileCount_;
        const CacheHeader * prevHdr = headerOf(this->dataBuf_);
        const uint32_t oldFc = prevHdr->fileCount;

        // Same file list → skip remap, preserve ino state bits from CacheOpen
        const bool sameFiles = pathsMatch(this->encodedPaths_, this->encodedLen_, newFc, this->dataBuf_);

        if (!sameFiles) {
          if (!this->buildRemappedBuf_(prevHdr, oldFc, newFc)) {
            return;  // buildRemappedBuf_ already called signalAndClose_
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
    // ── Pool-thread hot fields ──────────────────────────────────────────

    // Input pointers (read on pool thread during remap/hash)
    uint8_t * dataBuf_;
    size_t dataLen_;
    const uint8_t * encodedPaths_;
    size_t encodedLen_;
    uint32_t fileCount_;

    // RAII locked fd. Destructor closes if not already closed.
    FfshFile lockedFile_;

    // Paths (used on pool thread for hash loop + disk write)
    std::string cachePath_;
    std::string rootPath_;

    // User data (read on pool thread during write)
    ParsedUserData ud_;

    // Cancellation — unified: fire() in dtor, is_fired() in hash loop
    FfshFile::LockCancel cancel_;

    // Hash runner state (set before pool.submit, read by worker threads)
    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;
    size_t workBatch_ = 0;
    uint32_t writerFc_ = 0;
    bool writeSuccess_ = false;

    // Remap output (owned, freed on destruction)
    OwnedBuf<> newBuf_;

    // Work-stealing counter — own cache line to avoid false sharing
    alignas(64) mutable std::atomic<size_t> nextIndex_{0};

    struct Job : ForkJob<Job, MAX_CACHE_IO_THREADS> {
      CacheWriter * owner;
      void forkWork() noexcept { hashProc_(this->owner); }
      void forkDone() noexcept { onHashDone_(this->owner); }
    };
    Job job_;

    // ── JS-thread-only fields (cold, never touched by pool threads) ─────

    Napi::ObjectReference dataRef_;
    Napi::ObjectReference pathsRef_;
    Napi::ObjectReference cancelRef_;

    static_assert(
      READ_BUFFER_SIZE + sizeof(PathResolver) <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "buffers exceed pool thread usable stack");

    /** Signal completion and close fd on the current (pool) thread.
     *  Moves lockedFile_ to a stack local so the JS-thread destructor is a no-op,
     *  then signals, then the local destructs — closing the fd after signal. */
    void signalAndClose_() noexcept {
      FfshFile f(std::move(this->lockedFile_));
      this->signal();
    }

    /** Signal error + completion and close fd. */
    void signalAndClose_(const char * error) noexcept {
      FfshFile f(std::move(this->lockedFile_));
      this->signal(error);
    }

    /** Build a new dataBuf with remapped entries from the old one. */
    FSH_NO_INLINE bool buildRemappedBuf_(const CacheHeader * prevHdr, uint32_t oldFc, uint32_t newFc) noexcept {
      const uint32_t udCount = prevHdr->udItemCount;
      const uint32_t udPLen = prevHdr->udPayloadsLen;

      this->newBuf_ = buildCacheDataBuf(this->encodedPaths_, this->encodedLen_, newFc, udCount, udPLen);

      if (!this->newBuf_) {
        this->signalAndClose_("cacheWrite: failed to build dataBuf");
        return false;
      }

      uint8_t * newPtr = this->newBuf_.ptr;
      CacheHeader * newHdr = headerOf(newPtr);
      newHdr->version = prevHdr->version;
      newHdr->fingerprint = prevHdr->fingerprint;
      newHdr->userValue0 = prevHdr->userValue0;
      newHdr->userValue1 = prevHdr->userValue1;
      newHdr->userValue2 = prevHdr->userValue2;
      newHdr->userValue3 = prevHdr->userValue3;
      newHdr->setFileHandle(FFSH_FILE_HANDLE_INVALID);
      newHdr->status = static_cast<uint32_t>(CacheStatus::CHANGED);

      // Merge-join: copy matched entries from old, stamp CACHE_S_HAS_OLD
      if (oldFc > 0 && newFc > 0) {
        remapEntries_(this->dataBuf_, oldFc, newPtr, newFc);
      }

      // Copy user data directory + payloads from old buf
      if (udCount > 0) {
        memcpy(udDirOf(newPtr, newFc), udDirOf(this->dataBuf_, oldFc), static_cast<size_t>(udCount) * 4);
        if (udPLen > 0) {
          memcpy(
            udPayloadsOf(newPtr, newFc, udCount, newHdr->pathsLen),
            udPayloadsOf(this->dataBuf_, oldFc, udCount, prevHdr->pathsLen),
            udPLen);
        }
      }

      return true;
    }

    /** Count unresolved entries, fork hash threads if needed, then write. */
    void completeAndWrite_(uint8_t * dbuf, size_t dlen) noexcept {
      if (dlen < CacheHeader::SIZE) [[unlikely]] {
        this->signalAndClose_();
        return;
      }

      CacheHeader * hdr = headerOf(dbuf);
      const uint32_t fc = hdr->fileCount;

      if (!hdr->validateLimits()) [[unlikely]] {
        this->signalAndClose_();
        return;
      }

      this->writerFc_ = fc;
      const uint32_t udCount = hdr->udItemCount;
      const CacheStatus st = static_cast<CacheStatus>(hdr->status);

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
        this->signalAndClose_();
        return;
      }

      if (this->cancel_.is_fired() || this->addon->pool.is_shutdown()) [[unlikely]] {
        this->signalAndClose_();
        return;
      }

      this->runEntries_ = entriesOf(dbuf);
      this->runPathEnds_ = pathEndsOf(dbuf, fc, udCount);
      this->runPackedPaths_ = pathsOf(dbuf, fc, udCount);
      this->runPackedPathsSize_ = hdr->pathsLen;
      this->dataBuf_ = dbuf;

      int threadCount = ThreadPool::compute_threads(0, workNeeded, MAX_CACHE_IO_THREADS, 4);
      this->workBatch_ = computeBatchSize(threadCount, fc);
      this->nextIndex_.store(0, std::memory_order_relaxed);

      this->job_.owner = this;
      this->addon->pool.submit(this->job_, threadCount);
    }

    /** Called by the last hash thread. Writes file if not cancelled. */
    static void onHashDone_(CacheWriter * self) {
      if (!self->cancel_.is_fired() && !self->addon->pool.is_shutdown()) [[likely]] {
        uint8_t * buf = self->dataBuf_;
        self->writeFile_(buf, headerOf(buf), self->writerFc_);
      }
      self->signalAndClose_();
    }

    /** Assemble and write the cache file to the locked fd. */
    void writeFile_(uint8_t * buf, CacheHeader * hdr, uint32_t fc) noexcept {
      // Snapshot old udItemCount before assembleAndWriteCache overwrites it
      // (needed for correct pathEnds/paths offset in the in-memory layout).
      const uint32_t oldUdCount = hdr->udItemCount;
      this->writeSuccess_ = assembleAndWriteCache(buf, hdr, fc, oldUdCount, this->ud_, this->lockedFile_);
    }

    /** Merge-join old entries into the new dataBuf by sorted path comparison. */
    static void remapEntries_(
      const uint8_t * FSH_RESTRICT oldData, uint32_t oldFc, uint8_t * FSH_RESTRICT newData, uint32_t newFc) noexcept {
      const CacheHeader * oldHdr = headerOf(oldData);
      const CacheEntry * FSH_RESTRICT oldEntries = entriesOf(oldData);
      const uint32_t * FSH_RESTRICT oldPe = pathEndsOf(oldData, oldFc, oldHdr->udItemCount);
      const uint8_t * FSH_RESTRICT oldPaths = pathsOf(oldData, oldFc, oldHdr->udItemCount);
      const size_t oldPathsLen = oldHdr->pathsLen;

      const CacheHeader * newHdr = headerOf(newData);
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

    /** Per-thread entry point — allocates stack read buffer and runs hash loop. */
    static void hashProc_(CacheWriter * wr) {
      alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
      wr->processHash_(rbuf);
    }

    /** Per-thread hash work loop. Hoists all shared state to locals. */
    void processHash_(unsigned char * readBuf) const {
      constexpr size_t readBufSize = READ_BUFFER_SIZE;
      const uint32_t fileCount = this->writerFc_;
      const size_t workBatch = this->workBatch_;
      CacheEntry * FSH_RESTRICT const entries = this->runEntries_;
      const uint32_t * FSH_RESTRICT const pathEnds = this->runPathEnds_;
      const uint8_t * FSH_RESTRICT const packedPaths = this->runPackedPaths_;
      const size_t packedPathsSize = this->runPackedPathsSize_;
      const FfshFile::LockCancel * cancel = &this->cancel_;
      ThreadPool & pool = this->addon->pool;

      const std::string & rootRef = this->rootPath_;
      const char * rootPath = rootRef.c_str();
      const size_t rootPathLen = rootRef.size();

      DirFd dirFd(rootPath, fileCount);
      PathResolver resolver;
      resolver.init(dirFd, rootPath, rootPathLen);
      const size_t maxSegCap = FSH_MAX_PATH > resolver.prefix_len + 1 ? FSH_MAX_PATH - resolver.prefix_len - 1 : 0;

      for (;;) {
        if (cancel->is_fired() || pool.is_shutdown()) [[unlikely]] {
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
            FSH_PREFETCH_W(&entries[idx + 1]);
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

          // New entry (NOT_CHECKED) — combined stat + hash in one open
          if (!resolver.stat_and_hash_file(entry, entry.contentHash, readBuf, readBufSize)) [[unlikely]] {
            continue;
          }
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
