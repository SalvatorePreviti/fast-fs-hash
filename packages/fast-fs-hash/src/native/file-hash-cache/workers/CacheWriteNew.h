/**
 * CacheWriteNew: static write — acquires an exclusive lock, hashes all files,
 * LZ4-compresses, and writes a brand-new cache file without reading the old one.
 *
 * Flow:
 *   1. Pool thread: acquire exclusive lock on the cache file
 *   2. Build a fresh dataBuf from the encoded path list
 *   3. Fork hash threads on pool (all entries are NOT_CHECKED → stat+hash)
 *   4. Assemble body, LZ4 compress, write directly to the locked fd
 *   5. Close fd and resolve promise
 *
 * Unlike open+write, this skips read/decompress/pathsMatch entirely.
 * The fd is owned end-to-end by this worker — it is NOT registered in the
 * heldFileHandles set (no JS-side ownership, nothing to abandon).
 */

#ifndef _FAST_FS_HASH_CACHE_WRITE_NEW_H
#define _FAST_FS_HASH_CACHE_WRITE_NEW_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../ParsedUserData.h"
#include "AddonWorker.h"

namespace fast_fs_hash {

  class CacheWriteNew final : public AddonWorker {
   public:
    CacheWriteNew(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
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
      int timeoutMs,
      const volatile uint8_t * cancelByte = nullptr,
      Napi::ObjectReference && cancelRef = {}) :
      AddonWorker(env, deferred),
      cachePath_(std::move(cachePath)),
      rootPath_(std::move(rootPath)),
      pathsRef_(std::move(pathsRef)),
      cancelRef_(std::move(cancelRef)),
      encodedPaths_(encodedPaths),
      encodedLen_(encodedLen),
      fileCount_(fileCount),
      version_(version),
      hasFingerprint_(fingerprint != nullptr),
      userValue0_(userValue0),
      userValue1_(userValue1),
      userValue2_(userValue2),
      userValue3_(userValue3),
      ud_(std::move(ud)),
      timeoutMs_(timeoutMs) {
      if (fingerprint) {
        memcpy(&this->fingerprint_, fingerprint, 16);
      }
      this->cancel_.cancelByte_ = cancelByte;
    }

    ~CacheWriteNew() override { this->cancel_.fire(); }

    void Start() { this->Queue(); }

    void Execute() override {
      if (this->cancel_.is_fired()) [[unlikely]] {
        this->signal();
        return;
      }
      const char * error = nullptr;
      this->lockedFile_ = FfshFile::open_locked(this->cachePath_.c_str(), this->timeoutMs_, error, &this->cancel_);
      if (!this->lockedFile_) [[unlikely]] {
        // Lock failure → resolve with -1 (false), same as write failure.
        this->signal();
        return;
      }
      this->doWriteNew_();
    }

    void OnOK() override {
      const int result = this->writeSuccess_ ? 0 : -1;
      this->deferred.Resolve(Napi::Number::New(Napi::Env(this->env), result));
    }

   private:
    std::string cachePath_;
    std::string rootPath_;

    // JS refs (prevent GC)
    Napi::ObjectReference pathsRef_;
    Napi::ObjectReference cancelRef_;

    // Inputs
    const uint8_t * encodedPaths_;
    size_t encodedLen_;
    uint32_t fileCount_;
    uint32_t version_;
    bool hasFingerprint_;
    Hash128 fingerprint_{};
    double userValue0_;
    double userValue1_;
    double userValue2_;
    double userValue3_;
    ParsedUserData ud_;
    int timeoutMs_;

    FfshFile::LockCancel cancel_;

    // RAII locked fd. Destructor closes if not already closed.
    FfshFile lockedFile_;

    /** Signal completion and close fd on the current (pool) thread.
     *  Moves lockedFile_ to a stack local so the JS-thread destructor is a no-op,
     *  then signals, then the local destructs — closing the fd after signal. */
    void signalAndClose_() noexcept {
      FfshFile f(std::move(this->lockedFile_));
      this->signal();
    }

    void signalAndClose_(const char * error) noexcept {
      FfshFile f(std::move(this->lockedFile_));
      this->signal(error);
    }

    // Working dataBuf
    OwnedBuf<> dataBuf_;

    bool writeSuccess_ = false;

    // Hash runner state
    size_t workBatch_ = 0;
    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;
    uint32_t writerFc_ = 0;

    alignas(64) mutable std::atomic<size_t> nextIndex_{0};

    static_assert(
      READ_BUFFER_SIZE + sizeof(PathResolver) <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "buffers exceed pool thread usable stack");

    void doWriteNew_() noexcept {
      const uint32_t fc = this->fileCount_;

      // Build a fresh dataBuf from the file list
      this->dataBuf_ = buildCacheDataBuf(this->encodedPaths_, this->encodedLen_, fc);
      if (!this->dataBuf_) [[unlikely]] {
        this->signalAndClose_("CacheWriteNew: failed to build dataBuf");
        return;
      }

      // Populate header
      auto * hdr = headerOf(this->dataBuf_.ptr);
      hdr->version = this->version_;
      hdr->userValue0 = this->userValue0_;
      hdr->userValue1 = this->userValue1_;
      hdr->userValue2 = this->userValue2_;
      hdr->userValue3 = this->userValue3_;
      if (this->hasFingerprint_) {
        hdr->fingerprint = this->fingerprint_;
      }

      if (fc == 0) {
        // No files — just write header
        this->writeFile_(this->dataBuf_.ptr, hdr, 0);
        this->signalAndClose_();
        return;
      }

      // All entries are NOT_CHECKED (calloc'd) — hash all of them
      this->writerFc_ = fc;
      this->runEntries_ = entriesOf(this->dataBuf_.ptr);
      this->runPathEnds_ = pathEndsOf(this->dataBuf_.ptr, fc, 0);
      this->runPackedPaths_ = pathsOf(this->dataBuf_.ptr, fc, 0);
      this->runPackedPathsSize_ = hdr->pathsLen;

      int threadCount = ThreadPool::compute_threads(0, fc, MAX_WRITE_THREADS, 4);
      this->workBatch_ = computeBatchSize(threadCount, fc);
      this->nextIndex_.store(0, std::memory_order_relaxed);

      this->addon->pool.submit(threadCount, hashProc_, this, onHashDone_, this);
    }

    static void onHashDone_(CacheWriteNew * self) {
      auto * buf = self->dataBuf_.ptr;
      self->writeFile_(buf, headerOf(buf), self->writerFc_);
      self->signalAndClose_();
    }

    void writeFile_(uint8_t * buf, CacheHeader * hdr, uint32_t fc) noexcept {
      // Fresh dataBuf has udItemCount=0, so prevUdCount=0.
      this->writeSuccess_ = assembleAndWriteCache(buf, hdr, fc, 0, this->ud_, this->lockedFile_);
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

      const char * rootPath = this->rootPath_.c_str();
      const size_t rootPathLen = this->rootPath_.size();

      DirFd dirFd(rootPath, fileCount);
      PathResolver resolver;
      resolver.init(dirFd, rootPath, rootPathLen);
      const size_t maxSegCap = FSH_MAX_PATH > resolver.prefix_len + 1 ? FSH_MAX_PATH - resolver.prefix_len - 1 : 0;

      for (;;) {
        if (this->cancel_.is_fired() || this->addon->pool.is_shutdown()) [[unlikely]] {
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
            FSH_PREFETCH(&entries[idx + 1]);
            FSH_PREFETCH(packedPaths + pathEnd);
          }

          resolver.resolve(packedPaths + pathOffset, pathLen);

          // All entries are new (NOT_CHECKED) — combined stat + hash in one open
          if (!resolver.stat_and_hash_file(entry, entry.contentHash, readBuf, readBufSize)) [[unlikely]] {
            continue;
          }
        }
      }
    }
  };

}  // namespace fast_fs_hash

#endif
