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
      cancelRef_(std::move(cancelRef)) {
      if (fingerprint) {
        memcpy(&this->fingerprint_, fingerprint, 16);
      }
      this->cancel_.cancelByte_ = cancelByte;
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

    /** Queue this worker on the thread pool. */
    void Start() { this->Queue(); }

    void Execute() override {
      AddonData * d = this->addon;
      if (this->cancel_.is_fired() || d->pool.is_shutdown()) [[unlikely]] {
        this->signal();
        return;
      }
      const char * error = nullptr;
      this->lockedFile_ = FfshFile::open_locked(this->cachePath_.c_str(), this->timeoutMs_, error, &this->cancel_);
      if (!this->lockedFile_) [[unlikely]] {
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
    // ── Pool-thread hot fields ──────────────────────────────────────────

    // Inputs (read on pool thread)
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

    // Paths (used on pool thread for hash loop + disk write)
    std::string cachePath_;
    std::string rootPath_;

    // User data (read on pool thread during write)
    ParsedUserData ud_;

    // Cancellation
    FfshFile::LockCancel cancel_;

    // RAII locked fd. Destructor closes if not already closed.
    FfshFile lockedFile_;

    // Hash runner state
    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;
    size_t workBatch_ = 0;
    uint32_t writerFc_ = 0;
    bool writeSuccess_ = false;

    // Working dataBuf
    OwnedBuf<> dataBuf_;

    // Work-stealing counter — own cache line to avoid false sharing
    alignas(64) mutable std::atomic<size_t> nextIndex_{0};

    struct Job : ForkJob<Job, MAX_CACHE_IO_THREADS> {
      CacheWriteNew * owner;
      void forkWork() noexcept { hashProc_(this->owner); }
      void forkDone() noexcept { onHashDone_(this->owner); }
    };
    Job job_;

    // ── JS-thread-only fields (cold, never touched by pool threads) ─────

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

    /** Build dataBuf, populate header, and fork hash threads. */
    void doWriteNew_() noexcept {
      const uint32_t fc = this->fileCount_;

      // Build a fresh dataBuf from the file list
      this->dataBuf_ = buildCacheDataBuf(this->encodedPaths_, this->encodedLen_, fc);
      if (!this->dataBuf_) [[unlikely]] {
        this->signalAndClose_("CacheWriteNew: failed to build dataBuf");
        return;
      }

      // Populate header
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
        // No files — just write header
        this->writeFile_(this->dataBuf_.ptr, hdr, 0);
        this->signalAndClose_();
        return;
      }

      if (this->cancel_.is_fired() || this->addon->pool.is_shutdown()) [[unlikely]] {
        this->signalAndClose_();
        return;
      }

      // All entries are NOT_CHECKED (calloc'd) — hash all of them
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

    /** Called by the last hash thread. Writes file if not cancelled. */
    static void onHashDone_(CacheWriteNew * self) {
      if (!self->cancel_.is_fired() && !self->addon->pool.is_shutdown()) [[likely]] {
        uint8_t * buf = self->dataBuf_.ptr;
        self->writeFile_(buf, headerOf(buf), self->writerFc_);
      }
      self->signalAndClose_();
    }

    /** Assemble and write the cache file to the locked fd. */
    void writeFile_(uint8_t * buf, CacheHeader * hdr, uint32_t fc) noexcept {
      // Fresh dataBuf has udItemCount=0, so prevUdCount=0.
      this->writeSuccess_ = assembleAndWriteCache(buf, hdr, fc, 0, this->ud_, this->lockedFile_);
    }

    /** Per-thread entry point — allocates stack read buffer and runs hash loop. */
    static void hashProc_(CacheWriteNew * self) {
      alignas(64) unsigned char rbuf[READ_BUFFER_SIZE];
      self->processHash_(rbuf);
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
