/**
 * CacheOpen: acquires an exclusive lock on the cache file, then reads,
 * validates, and stat-matches entries using the locked fd.
 *
 * Always locks. Resolves with Buffer<dataBuf>.
 * The lock handle is embedded in the header at offset 76 (in-memory only).
 * The lock handle is registered with AddonData for crash-safe cleanup.
 *
 * Runs on a pool thread. Lock acquisition is bounded by timeoutMs
 * (non-blocking or short-lived in the common no-contention case).
 */

#ifndef _FAST_FS_HASH_CACHE_OPEN_H
#define _FAST_FS_HASH_CACHE_OPEN_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../file-hash-cache-format.h"
#include "AddonWorker.h"

#include <lz4.h>

namespace fast_fs_hash {

  class CacheOpen final : public AddonWorker {
   public:
    CacheOpen(
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
      timeoutMs_(timeoutMs) {
      if (fingerprint) {
        memcpy(&this->fingerprint_, fingerprint, 16);
      }
      this->cancel_.cancelByte_ = cancelByte;
    }

    ~CacheOpen() override { this->cancel_.fire(); }

    void Start() { this->Queue(); }

    void Execute() override {
      if (this->cancel_.is_fired()) [[unlikely]] {
        this->lockFailed_ = true;
        this->signal();
        return;
      }
      const char * error = nullptr;
      this->lockedFile_ = FfshFile::open_locked(this->cachePath_.c_str(), this->timeoutMs_, error, &this->cancel_);
      if (!this->lockedFile_) [[unlikely]] {
        // Lock failure → resolve with LOCK_FAILED status (not reject).
        this->lockFailed_ = true;
        this->signal();
        return;
      }
      this->doOpen_();
    }

    void OnOK() override {
      auto env = Napi::Env(this->env);
      Napi::HandleScope scope(env);

      if (this->lockFailed_) [[unlikely]] {
        auto buf = Napi::Buffer<uint8_t>::New(env, CacheHeader::SIZE);
        memset(buf.Data(), 0, CacheHeader::SIZE);
        auto * hdr = headerOf(buf.Data());
        hdr->status = static_cast<uint32_t>(CacheStatus::LOCK_FAILED);
        hdr->fileHandle = FFSH_FILE_HANDLE_INVALID;
        this->deferred.Resolve(buf);
        return;
      }

      // Transfer lock ownership to AddonData (JS now owns the fd via the RAII map).
      const int32_t fh = this->addon->registerHeldFile(std::move(this->lockedFile_));

      auto buf = this->makeDataBuf_(env);
      headerOf(buf.Data())->setFileHandle(fh);
      this->deferred.Resolve(buf);
    }

   private:
    // Strings (used on pool thread in stat loop + finalize)
    std::string cachePath_;
    std::string rootPath_;

    // JS refs (prevent GC, never accessed on pool threads)
    Napi::ObjectReference pathsRef_;
    Napi::ObjectReference cancelRef_;

    // Inputs (read once in doOpen_, then done)
    const uint8_t * encodedPaths_;
    size_t encodedLen_;
    uint32_t fileCount_;
    uint32_t version_;
    bool hasFingerprint_;
    Hash128 fingerprint_{};
    int timeoutMs_;

    FfshFile::LockCancel cancel_;
    bool lockFailed_ = false;

    // Locked file handle
    FfshFile lockedFile_;

    // Output buffer
    OwnedBuf<> dataBuf_;

    // Stat-match runner state (set before pool.submit, read by all worker threads)
    size_t workBatch_ = 0;
    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;

    // Work-stealing counter (hot — every thread writes). Own cache line.
    alignas(64) mutable std::atomic<size_t> nextIndex_{0};

    // Match result (cold — written at most once per thread on change)
    mutable std::atomic<MatchResult> matchResult_{MatchResult::OK};

    static_assert(
      READ_BUFFER_SIZE + sizeof(PathResolver) <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "buffers exceed pool thread usable stack");

    /** Build a resolved dataBuf from a Napi::Buffer on the JS thread. */
    Napi::Buffer<uint8_t> makeDataBuf_(Napi::Env env) {
      const size_t len = this->dataBuf_.len;
      uint8_t * ptr = this->dataBuf_.release();
      if (ptr) [[likely]] {
        return Napi::Buffer<uint8_t>::New(env, ptr, len, [](Napi::Env, uint8_t * p) { free(p); });
      }
      // Fallback: return a zeroed header-only buffer with MISSING status
      auto buf = Napi::Buffer<uint8_t>::New(env, CacheHeader::SIZE);
      memset(buf.Data(), 0, CacheHeader::SIZE);
      auto * fallbackHdr = headerOf(buf.Data());
      fallbackHdr->status = static_cast<uint32_t>(CacheStatus::MISSING);
      fallbackHdr->fileHandle = FFSH_FILE_HANDLE_INVALID;
      return buf;
    }

    void finalize_(CacheStatus st) noexcept {
      auto * hdr = headerOf(this->dataBuf_.ptr);
      hdr->magic = CacheHeader::MAGIC;
      hdr->version = this->version_;
      hdr->status = static_cast<uint32_t>(st);
      hdr->fileHandle = FFSH_FILE_HANDLE_INVALID;
      if (this->hasFingerprint_) {
        hdr->fingerprint = this->fingerprint_;
      }
    }

    FSH_NO_INLINE void finish_(CacheStatus st) noexcept {
      if (!this->dataBuf_) [[unlikely]] {
        // Build full dataBuf with file list so CacheWriter skips remap
        if (this->encodedLen_ > 0 && this->fileCount_ > 0) {
          this->dataBuf_ = buildCacheDataBuf(this->encodedPaths_, this->encodedLen_, this->fileCount_);
        }
        if (!this->dataBuf_) {
          this->dataBuf_ = OwnedBuf<>::calloc(CacheHeader::SIZE);
          this->fileCount_ = 0;
        }
      }
      this->finalize_(st);
      this->signal();
    }

    void doOpen_() noexcept {
      const CacheHeader * oldHdr = nullptr;
      uint32_t oldFc = 0;
      size_t oldBodyLen = 0;
      bool stale = false;
      OwnedBuf<> oldBuf;
      const bool hasOld = this->readOldCache_(oldBuf, oldHdr, oldFc, oldBodyLen, stale);

      if (!hasOld) [[unlikely]] {
        this->finish_(CacheStatus::MISSING);
        return;
      }

      const bool reuse = this->encodedLen_ == 0;
      if (reuse) {
        this->fileCount_ = oldFc;
      }

      if (stale) {
        this->dataBuf_ = std::move(oldBuf);
        this->finish_(CacheStatus::STALE);
        return;
      }

      const uint32_t fc = this->fileCount_;
      if (fc == 0) {
        this->dataBuf_ = std::move(oldBuf);
        this->finish_(CacheStatus::UP_TO_DATE);
        return;
      }

      // Check if file list is identical — direct comparison, zero allocation
      bool sameFiles = reuse;
      if (!sameFiles) {
        sameFiles = pathsMatch(this->encodedPaths_, this->encodedLen_, fc, oldBuf.ptr);
      }

      if (!sameFiles) {
        // Different file list — skip stat-match, let write() handle remap + hash
        this->dataBuf_ = std::move(oldBuf);
        this->finish_(CacheStatus::CHANGED);
        return;
      }

      // Same file list — use old body directly for stat-match
      this->dataBuf_ = std::move(oldBuf);

      auto * buf = this->dataBuf_.ptr;
      auto * hdr = headerOf(buf);
      const uint32_t udCount = hdr->udItemCount;

      // Stamp HAS_OLD state into high 2 bits of each entry's ino
      CacheEntry * entries = entriesOf(buf);
      for (uint32_t i = 0; i < fc; ++i) {
        entries[i].ino = (entries[i].ino & INO_VALUE_MASK) | CACHE_S_HAS_OLD;
      }

      this->runEntries_ = entries;
      this->runPathEnds_ = pathEndsOf(buf, fc, udCount);
      this->runPackedPaths_ = pathsOf(buf, fc, udCount);
      this->runPackedPathsSize_ = hdr->pathsLen;

      int threadCount = ThreadPool::compute_threads(0, fc, MAX_OPEN_THREADS, 64);
      this->workBatch_ = computeBatchSize(threadCount, fc);
      this->nextIndex_.store(0, std::memory_order_relaxed);
      this->matchResult_.store(MatchResult::OK, std::memory_order_relaxed);

      this->addon->pool.submit(threadCount, statProc_, this, onStatDone_, this);
    }

    static void onStatDone_(CacheOpen * self) {
      const auto mr = self->matchResult_.load(std::memory_order_relaxed);

      CacheStatus st;
      if (mr >= MatchResult::CHANGED) {
        st = CacheStatus::CHANGED;
      } else if (mr >= MatchResult::STAT_DIRTY) {
        st = CacheStatus::STATS_DIRTY;
      } else {
        st = CacheStatus::UP_TO_DATE;
      }

      self->finalize_(st);
      self->signal();
    }

    /**
     * Read the old cache from the locked fd. Seeks to 0, reads, decompresses.
     * Does NOT close the fd — the lock must stay held.
     */
    bool readOldCache_(
      OwnedBuf<> & oldBuf, const CacheHeader *& hdr, uint32_t & fc, size_t & bodyLen, bool & stale) noexcept {
      // Read from the already-locked fd
      const int lockFd = this->lockedFile_.fd;
      if (lockFd < 0) [[unlikely]] {
        return false;
      }

      const int64_t fileSize = this->lockedFile_.fsize();
      if (fileSize < static_cast<int64_t>(CacheHeader::SIZE) || fileSize > static_cast<int64_t>(CACHE_MAX_FILE_SIZE))
        [[unlikely]] {
        return false;
      }
      const size_t diskSize = static_cast<size_t>(fileSize);

      // Seek to beginning and read the full file
      if (!this->lockedFile_.seek(0)) [[unlikely]] {
        return false;
      }

      OwnedBuf<> fileBuf = OwnedBuf<>::alloc(diskSize);
      if (!fileBuf) [[unlikely]] {
        return false;
      }
      const int64_t n = this->lockedFile_.read_at_most(fileBuf.ptr, diskSize);
      if (n < 0 || static_cast<size_t>(n) < diskSize) [[unlikely]] {
        return false;
      }
      // NOTE: We do NOT close the fd — the lock stays held

      const auto * diskHdr = headerOf(fileBuf.ptr);
      if (!diskHdr->validateLimits()) [[unlikely]] {
        return false;
      }

      fc = diskHdr->fileCount;
      const size_t uncompBodySize = diskHdr->bodySize();
      bodyLen = CacheHeader::SIZE + uncompBodySize;
      if (bodyLen > CACHE_MAX_BODY_SIZE) [[unlikely]] {
        return false;
      }

      // Fast stale check before decompression
      stale = false;
      if (diskHdr->version != this->version_) {
        stale = true;
      } else if (!this->hasFingerprint_) {
        if (!diskHdr->fingerprint.is_zero()) {
          stale = true;
        }
      } else if (diskHdr->fingerprint != this->fingerprint_) {
        stale = true;
      }

      oldBuf = OwnedBuf<>::alloc(bodyLen);
      if (!oldBuf) [[unlikely]] {
        return false;
      }

      memcpy(oldBuf.ptr, fileBuf.ptr, CacheHeader::SIZE);

      if (uncompBodySize > 0) {
        const int compressedSize = static_cast<int>(diskSize - CacheHeader::SIZE);
        if (compressedSize <= 0) [[unlikely]] {
          return false;
        }
        const int decompressed = LZ4_decompress_safe(
          reinterpret_cast<const char *>(fileBuf.ptr + CacheHeader::SIZE),
          reinterpret_cast<char *>(oldBuf.ptr + CacheHeader::SIZE),
          compressedSize,
          static_cast<int>(uncompBodySize));
        if (decompressed < 0 || static_cast<size_t>(decompressed) != uncompBodySize) [[unlikely]] {
          oldBuf.reset();
          return false;
        }
      }

      fileBuf.reset();
      hdr = headerOf(oldBuf.ptr);

      if (!hdr->packedPathsValid(oldBuf.ptr)) [[unlikely]] {
        oldBuf.reset();
        return false;
      }

      return true;
    }

    static void statProc_(CacheOpen * op) { op->processStat_(); }

    FSH_NO_INLINE static bool statMatchHashFile_(
      PathResolver & resolver, CacheEntry & entry, const Hash128 & oldContentHash) {
      alignas(64) unsigned char readBuf[READ_BUFFER_SIZE];
      resolver.hash_file(entry.contentHash, readBuf, READ_BUFFER_SIZE);
      return entry.contentHash == oldContentHash;
    }

    void processStat_() const {
      const size_t fileCount = this->fileCount_;
      const size_t workBatch = this->workBatch_;
      CacheEntry * FSH_RESTRICT const entries = this->runEntries_;
      const uint32_t * FSH_RESTRICT const pathEnds = this->runPathEnds_;
      const uint8_t * FSH_RESTRICT const packedPaths = this->runPackedPaths_;
      const size_t packedPathsSize = this->runPackedPathsSize_;

      const char * rootPath = this->rootPath_.c_str();
      DirFd dirFd(rootPath, fileCount);
      PathResolver resolver;
      resolver.init(dirFd, rootPath, this->rootPath_.size());
      const size_t maxSegCap = FSH_MAX_PATH > resolver.prefix_len + 1 ? FSH_MAX_PATH - resolver.prefix_len - 1 : 0;

      for (;;) {
        if (this->matchResult_.load(std::memory_order_relaxed) >= MatchResult::CHANGED) [[unlikely]] {
          break;
        }
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
            this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
            break;
          }
        }

        for (size_t idx = baseIdx; idx < batchEnd; ++idx) {
          const uint32_t pathEnd = pathEnds[idx];

          if (pathEnd < pathStart || pathEnd > packedPathsSize) [[unlikely]] {
            this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
            goto done;
          }

          CacheEntry & entry = entries[idx];
          const uint64_t inoWithState = entry.ino;
          const uint64_t state = inoWithState & INO_STATE_MASK;

          if (state == CACHE_S_DONE) [[likely]] {
            pathStart = pathEnd;
            continue;
          }

          const size_t pathLen = pathEnd - pathStart;
          const uint32_t pathOffset = pathStart;
          pathStart = pathEnd;

          if (idx + 1 < batchEnd) [[likely]] {
            FSH_PREFETCH(&entries[idx + 1]);
            FSH_PREFETCH_W(&entries[idx + 1]);
            FSH_PREFETCH(packedPaths + pathEnd);
          }

          if (state == CACHE_S_HAS_OLD) [[likely]] {
            if (pathLen > maxSegCap) [[unlikely]] {
              this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
              goto done;
            }

            resolver.resolve(packedPaths + pathOffset, pathLen);

            const uint64_t oldIno = inoWithState & INO_VALUE_MASK;
            const uint64_t oldMtime = entry.mtimeNs;
            const uint64_t oldCtime = entry.ctimeNs;
            const uint64_t oldSize = entry.size;

            const bool statOk = resolver.stat_into(entry);

            if (!statOk) [[unlikely]] {
              entry.contentHash.set_zero();
              entry.ino |= CACHE_S_STAT_DONE;
              this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
              goto done;
            }

            if (entry.ino == oldIno && entry.mtimeNs == oldMtime && entry.ctimeNs == oldCtime) [[likely]] {
              entry.ino |= CACHE_S_DONE;
              continue;
            }

            if (this->matchResult_.load(std::memory_order_relaxed) < MatchResult::STAT_DIRTY) {
              this->matchResult_.store(MatchResult::STAT_DIRTY, std::memory_order_relaxed);
            }

            if (entry.size != oldSize) {
              entry.ino |= CACHE_S_STAT_DONE;
              this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
              goto done;
            }

            {
              const Hash128 oldContentHash = entry.contentHash;
              if (entry.size == 0) {
                entry.contentHash.from_xxh128(XXH3_128bits(nullptr, 0));
                entry.ino |= CACHE_S_DONE;
                if (entry.contentHash == oldContentHash) {
                  continue;
                }
                this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
                goto done;
              }
              if (statMatchHashFile_(resolver, entry, oldContentHash)) {
                entry.ino |= CACHE_S_DONE;
                continue;
              }
            }
            entry.ino |= CACHE_S_DONE;
            this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
            goto done;
          }

          this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
          goto done;
        }
      }
    done:;
    }
  };

}  // namespace fast_fs_hash

#endif
