#ifndef _FAST_FS_HASH_CACHE_WRITE_NEW_H
#define _FAST_FS_HASH_CACHE_WRITE_NEW_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../ParsedUserData.h"
#include "AddonWorker.h"

namespace fast_fs_hash {

  /**
   * Static write — acquires an exclusive lock, hashes all files,
   * LZ4-compresses, and writes a brand-new cache file without reading the old one.
   *
   * On-disk format: [header:80 uncompressed][LZ4(body)]
   *
   * All config (version, fingerprint, lockTimeoutMs, userValues, fileCount)
   * is read from CacheStateBuf by the binding function and copied to member fields.
   * Stat result is written back to CacheStateBuf in OnOK.
   */
  class CacheWriteNew final : public AddonWorker {
   public:
    CacheWriteNew(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      CacheStateBuf * state,
      Napi::ObjectReference && stateRef,
      const uint8_t * encodedPaths,
      size_t encodedLen,
      Napi::ObjectReference && pathsRef,
      uint32_t fileCount,
      std::string cachePath,
      std::string rootPath,
      uint32_t version,
      const uint8_t * fingerprint,
      double userValue0,
      double userValue1,
      double userValue2,
      double userValue3,
      ParsedUserData && ud,
      int timeoutMs) :
      AddonWorker(env, deferred),
      state_(state),
      encodedPaths_(encodedPaths),
      encodedLen_(encodedLen),
      fileCount_(fileCount),
      version_(version),
      hasFingerprint_(fingerprint != nullptr),
      timeoutMs_(timeoutMs),
      userValue0_(userValue0),
      userValue1_(userValue1),
      userValue2_(userValue2),
      userValue3_(userValue3),
      cachePath_(std::move(cachePath)),
      rootPath_(std::move(rootPath)),
      ud_(std::move(ud)),
      pathsRef_(std::move(pathsRef)),
      stateRef_(std::move(stateRef)) {
      if (fingerprint) {
        memcpy(&this->fingerprint_, fingerprint, 16);
      }
      this->cancel_.cancelByte_ = state->cancelByte();
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.add(&this->cancel_);
      }
    }

    ~CacheWriteNew() override {
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.remove(&this->cancel_);
      }
      this->cancel_.fire();
    }

    void Start() { this->Queue(); }

    void Execute() override {
      AddonData * d = this->addon;
      if (this->cancel_.is_fired() || d->pool.is_shutdown()) [[unlikely]] {
        this->signal();
        return;
      }
      this->lockedFile_ = FfshFile::open_locked(this->cachePath_.c_str(), this->timeoutMs_, &this->cancel_);
      if (!this->lockedFile_) [[unlikely]] {
        this->signal();
        return;
      }
      this->doWriteNew_();
    }

    void OnOK() override {
      auto e = Napi::Env(this->env);
      if (this->writeSuccess_) {
        this->state_->cacheFileStat0 = this->resultStat_[0];
        this->state_->cacheFileStat1 = this->resultStat_[1];
      }
      this->deferred.Resolve(Napi::Number::New(e, this->writeSuccess_ ? 0 : -1));
    }

   private:
    CacheStateBuf * state_;

    const uint8_t * encodedPaths_;
    size_t encodedLen_;
    uint32_t fileCount_;
    uint32_t version_;
    bool hasFingerprint_;
    int timeoutMs_;
    Hash128 fingerprint_{};
    double userValue0_;
    double userValue1_;
    double userValue2_;
    double userValue3_;

    std::string cachePath_;
    std::string rootPath_;

    ParsedUserData ud_;

    FfshFile::LockCancel cancel_;
    FfshFile lockedFile_;

    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;
    size_t workBatch_ = 0;
    uint32_t writerFc_ = 0;
    bool writeSuccess_ = false;
    double resultStat_[2] = {0, 0};

    OwnedBuf<> dataBuf_;

    alignas(64) mutable std::atomic<size_t> nextIndex_{0};

    struct Job : ForkJob<Job, MAX_CACHE_IO_THREADS> {
      CacheWriteNew * owner;
      void forkWork() noexcept { hashProc_(this->owner); }
      void forkDone() noexcept { onHashDone_(this->owner); }
    };
    Job job_;

    Napi::ObjectReference pathsRef_;
    Napi::ObjectReference stateRef_;

    static_assert(
      READ_BUFFER_SIZE + sizeof(PathResolver) <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "buffers exceed pool thread usable stack");

    void signalAndClose_() noexcept {
      FfshFile f(std::move(this->lockedFile_));
      this->signal();
    }

    void signalAndClose_(const char * error) noexcept {
      FfshFile f(std::move(this->lockedFile_));
      this->signal(error);
    }

    void doWriteNew_() noexcept {
      const uint32_t fc = this->fileCount_;

      this->dataBuf_ = buildCacheDataBuf(this->encodedPaths_, this->encodedLen_, fc);
      if (!this->dataBuf_) [[unlikely]] {
        this->signalAndClose_("CacheWriteNew: failed to build dataBuf");
        return;
      }

      CacheHeader * hdr = headerOf(this->dataBuf_.ptr);
      hdr->version = this->version_;
      hdr->userValue0 = this->userValue0_;
      hdr->userValue1 = this->userValue1_;
      hdr->userValue2 = this->userValue2_;
      hdr->userValue3 = this->userValue3_;
      if (this->hasFingerprint_) {
        hdr->fingerprint = this->fingerprint_;
      }

      if (fc == 0) {
        this->writeFile_(this->dataBuf_.ptr, hdr, 0);
        this->signalAndClose_();
        return;
      }

      if (this->cancel_.is_fired() || this->addon->pool.is_shutdown()) [[unlikely]] {
        this->signalAndClose_();
        return;
      }

      uint8_t * buf = this->dataBuf_.ptr;
      this->writerFc_ = fc;
      this->runEntries_ = entriesOf(buf);
      this->runPathEnds_ = pathEndsOf(buf, fc, 0);
      this->runPackedPaths_ = pathsOf(buf, fc, 0);
      this->runPackedPathsSize_ = hdr->pathsLen;

      int threadCount = ThreadPool::compute_threads(0, fc, MAX_CACHE_IO_THREADS, 4);
      this->workBatch_ = computeBatchSize(threadCount, fc);
      this->nextIndex_.store(0, std::memory_order_relaxed);

      this->job_.owner = this;
      this->addon->pool.submit(this->job_, threadCount);
    }

    static void onHashDone_(CacheWriteNew * self) {
      if (!self->cancel_.is_fired() && !self->addon->pool.is_shutdown()) [[likely]] {
        uint8_t * buf = self->dataBuf_.ptr;
        self->writeFile_(buf, headerOf(buf), self->writerFc_);
      }
      self->signalAndClose_();
    }

    void writeFile_(uint8_t * buf, CacheHeader * hdr, uint32_t fc) noexcept {
      this->writeSuccess_ = assembleAndWriteCache(buf, hdr, fc, 0, this->ud_, this->lockedFile_, this->resultStat_);
    }

    static void hashProc_(CacheWriteNew * self) {
      alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
      self->processHash_(rbuf);
    }

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

          if (!resolver.stat_and_hash_file(entry, entry.contentHash, readBuf, readBufSize)) [[unlikely]] {
            continue;
          }
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
