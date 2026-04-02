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
 */

#ifndef _FAST_FS_HASH_CACHE_WRITE_NEW_H
#define _FAST_FS_HASH_CACHE_WRITE_NEW_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../ParsedUserData.h"
#include "AddonWorker.h"

#include <lz4.h>

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
      int timeoutMs) :
      AddonWorker(env, deferred),
      cachePath_(std::move(cachePath)),
      rootPath_(std::move(rootPath)),
      pathsRef_(std::move(pathsRef)),
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
    }

    void Start() { this->Queue(); }

    void Execute() override {
      const char * error = nullptr;
      this->lockedFile_ = FfshFile::open_locked(this->cachePath_.c_str(), this->timeoutMs_, error);
      if (!this->lockedFile_) [[unlikely]] {
        this->signal(error ? error : "CacheWriteNew: failed to acquire lock");
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

    // Locked file handle
    FfshFile lockedFile_;

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
        this->closeLockAndSignal_("CacheWriteNew: failed to build dataBuf");
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

      // Embed lock handle
      FfshFileHandle fh = this->lockedFile_.to_file_handle();
      this->addon->registerHeldFileHandle(fh);
      hdr->setFileHandle(fh);

      if (fc == 0) {
        // No files — just write header
        this->writeFile_(this->dataBuf_.ptr, hdr, 0);
        this->signal();
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

    void closeLockAndSignal_(const char * error) noexcept {
      FfshFileHandle fh = this->lockedFile_.to_file_handle();
      if (fh != FFSH_FILE_HANDLE_INVALID) {
        this->addon->registerHeldFileHandle(fh);
        this->addon->closeHeldFileHandle(fh);
      }
      this->signal(error);
    }

    static void onHashDone_(CacheWriteNew * self) {
      auto * buf = self->dataBuf_.ptr;
      self->writeFile_(buf, headerOf(buf), self->writerFc_);
      self->signal();
    }

    void writeFile_(uint8_t * buf, CacheHeader * hdr, uint32_t fc) noexcept {
      const size_t udCount = this->ud_.count();
      const auto * udItems = this->ud_.data();
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

      // Fresh dataBuf has udItemCount=0, so pathEnds/paths start right after entries
      const uint32_t * inMemPe = pathEndsOf(buf, fc, 0);
      const uint8_t * inMemPaths = pathsOf(buf, fc, 0);
      const uint32_t inMemPathsLen = hdr->pathsLen;
      const size_t entriesLen = static_cast<size_t>(fc) * CacheEntry::STRIDE;
      const size_t peSize = static_cast<size_t>(fc) * 4;

      const size_t bodyTotal = entriesLen + dirSize + peSize + inMemPathsLen + udPayloadsLen;
      OwnedBuf<> body = OwnedBuf<>::alloc(bodyTotal);
      if (!body) [[unlikely]] {
        this->closeFileHandle_(hdr);
        return;
      }

      // Copy entries and strip ino state bits
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

      this->compressAndWrite_(hdr, body.ptr, bodyTotal);
    }

    void closeFileHandle_(CacheHeader * hdr) noexcept {
      const FfshFileHandle lh = hdr->getFileHandle();
      hdr->setFileHandle(FFSH_FILE_HANDLE_INVALID);
      if (lh != FFSH_FILE_HANDLE_INVALID) {
        this->addon->closeHeldFileHandle(lh);
      }
    }

    void compressAndWrite_(CacheHeader * hdr, const uint8_t * body, size_t bodyLen) noexcept {
      const FfshFileHandle lh = hdr->getFileHandle();
      hdr->setFileHandle(FFSH_FILE_HANDLE_INVALID);

      if (bodyLen > CACHE_MAX_BODY_SIZE || bodyLen > static_cast<size_t>(LZ4_MAX_INPUT_SIZE)) [[unlikely]] {
        this->addon->closeHeldFileHandle(lh);
        return;
      }

      hdr->magic = CacheHeader::MAGIC;
      hdr->status = 0;

      const int srcSize = static_cast<int>(bodyLen);
      const int maxCompressed = LZ4_compressBound(srcSize);
      const size_t totalFileSize = CacheHeader::SIZE + static_cast<size_t>(maxCompressed);
      OwnedBuf<> outBuf = OwnedBuf<>::alloc(totalFileSize);
      if (!outBuf) [[unlikely]] {
        this->addon->closeHeldFileHandle(lh);
        return;
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
        this->addon->closeHeldFileHandle(lh);
        return;
      }

      const size_t actualFileSize = CacheHeader::SIZE + static_cast<size_t>(compressedSize);

      FfshFile out = FfshFile::from_file_handle(lh);
      if (!out) [[unlikely]] {
        return;
      }

      out.preallocate(actualFileSize);
      this->writeSuccess_ = out.seek(0) && out.write_all(outBuf.ptr, actualFileSize) && out.truncate(actualFileSize);

      out.release();
      this->addon->closeHeldFileHandle(lh);
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
