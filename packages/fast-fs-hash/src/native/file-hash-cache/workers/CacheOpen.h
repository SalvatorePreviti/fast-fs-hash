#ifndef _FAST_FS_HASH_CACHE_OPEN_H
#define _FAST_FS_HASH_CACHE_OPEN_H

#include "../cache-build.h"
#include "../cache-helpers.h"
#include "../file-hash-cache-format.h"
#include "AddonWorker.h"

#define LZ4_STATIC_LINKING_ONLY  // expose LZ4_DECOMPRESS_INPLACE_MARGIN
#include <lz4.h>
#include <algorithm>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace fast_fs_hash {

  static_assert(CACHE_MAX_FILE_SIZE <= static_cast<size_t>(INT_MAX),
    "compressedSize fits in int — required by LZ4_decompress_safe");

  /**
   * Acquires an exclusive lock on the cache file, then reads,
   * validates, and stat-matches entries using the locked fd.
   *
   * Always locks. Resolves with Buffer<dataBuf>.
   * The lock handle is written to CacheStateBuf in OnOK.
   */
  class CacheOpen final : public AddonWorker {
   public:
    CacheOpen(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      CacheStateBuf * state,
      Napi::ObjectReference && stateRef,
      const uint8_t * encodedPaths,
      size_t encodedLen,
      Napi::ObjectReference && pathsRef,
      uint32_t fileCount,
      const char * cachePath,
      std::string rootPath,
      uint32_t version,
      const uint8_t * fingerprint,
      int timeoutMs,
      const uint8_t * dirtyPaths = nullptr,
      size_t dirtyLen = 0,
      uint32_t dirtyCount = 0,
      bool hasDirtyHint = false,
      Napi::ObjectReference && dirtyRef = {}) :
      AddonWorker(env, deferred),
      state_(state),
      encodedPaths_(encodedPaths),
      encodedLen_(encodedLen),
      fileCount_(fileCount),
      version_(version),
      hasFingerprint_(fingerprint != nullptr),
      timeoutMs_(timeoutMs),
      dirtyPaths_(dirtyPaths),
      dirtyLen_(dirtyLen),
      dirtyCount_(dirtyCount),
      hasDirtyHint_(hasDirtyHint),
      cachePath_(cachePath),
      rootPath_(std::move(rootPath)),
      pathsRef_(std::move(pathsRef)),
      stateRef_(std::move(stateRef)),
      dirtyRef_(std::move(dirtyRef)) {
      if (fingerprint) {
        memcpy(&this->fingerprint_, fingerprint, 16);
      }
      this->diskVersion_ = version;
      this->cancel_.cancelByte_ = state->cancelByte();
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.add(&this->cancel_);
      }
    }

    ~CacheOpen() override {
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
        this->lockFailed_ = true;
        this->signal();
        return;
      }
      this->lockedFile_ = FfshFile::open_locked(this->cachePath_, this->timeoutMs_, &this->cancel_);
      if (!this->lockedFile_) [[unlikely]] {
        this->lockFailed_ = true;
        this->signal();
        return;
      }
      this->doOpen_();
    }

    void OnOK() override {
      Napi::Env napiEnv = Napi::Env(this->env);
      Napi::HandleScope scope(napiEnv);

      CacheStateBuf * state = this->state_;

      if (this->lockFailed_) [[unlikely]] {
        state->status = static_cast<uint32_t>(CacheStatus::LOCK_FAILED);
        state->fileHandle = FFSH_FILE_HANDLE_INVALID;
        state->cacheFileStat0 = 0;
        state->cacheFileStat1 = 0;
        auto buf = Napi::Buffer<uint8_t>::New(napiEnv, CacheHeader::SIZE);
        memset(buf.Data(), 0, CacheHeader::SIZE);
        this->deferred.Resolve(buf);
        return;
      }

      // Write results to state buffer (JS thread — safe)
      state->status = this->resultStatus_;
      state->cacheFileStat0 = this->resultStat_[0];
      state->cacheFileStat1 = this->resultStat_[1];
      // Repurpose the `version` slot (normally JS→C++) to return the on-disk
      // version. JS reads it as `session.diskVersion`, then restores the slot.
      state->version = this->diskVersion_;

      // Transfer lock ownership to AddonData
      const int32_t fh = this->addon->registerHeldFile(std::move(this->lockedFile_));
      state->fileHandle = fh;

      auto buf = this->makeDataBuf_(napiEnv);
      this->deferred.Resolve(buf);
    }

   private:
    // - Pool-thread hot fields

    CacheStateBuf * state_;  // Only accessed in OnOK (JS thread)

    const uint8_t * encodedPaths_;
    size_t encodedLen_;
    uint32_t fileCount_;
    uint32_t version_;
    bool hasFingerprint_;
    int timeoutMs_;
    Hash128 fingerprint_{};

    const uint8_t * dirtyPaths_;
    size_t dirtyLen_;
    uint32_t dirtyCount_;
    bool hasDirtyHint_;

    const char * cachePath_;  // Points into stateBuf (pinned by stateRef_)
    std::string rootPath_;

    FfshFile::LockCancel cancel_;
    FfshFile lockedFile_;
    bool lockFailed_ = false;

    // Results (written on pool thread, read in OnOK)
    uint32_t resultStatus_ = static_cast<uint32_t>(CacheStatus::MISSING);
    uint32_t diskVersion_ = 0;  // header version from disk; defaults to version_ when no disk read happened
    double resultStat_[2] = {0, 0};

    OwnedBuf<> dataBuf_;

    CacheEntry * runEntries_ = nullptr;
    const uint32_t * runPathEnds_ = nullptr;
    const uint8_t * runPackedPaths_ = nullptr;
    size_t runPackedPathsSize_ = 0;
    size_t workBatch_ = 0;
    /** Root directory fd shared by all stat workers. Opened once per CacheOpen call
     *  on the libuv thread, instead of once per worker thread (saves ~3 openat
     *  syscalls per call). Lifetime: from doOpen_ until ~CacheOpen. */
    DirFd runDirFd_{};

    /** Dir-clustered work units. Each represents one directory holding
     *  ≥ STAT_BULK_THRESHOLD tracked files; workers process them via the
     *  platform's bulk-stat API (macOS: getattrlistbulk). Empty when no
     *  directory crosses the threshold or platform lacks bulk-stat.
     *
     *  `entries` is sorted by basename (case-sensitive memcmp order) so
     *  the bulk-stat callback can locate matches via std::lower_bound —
     *  no per-job hash-map allocation. The string_view points into
     *  runPackedPaths_ which is owned by dataBuf_ for the duration. */
    struct BulkDirJob {
      struct Entry {
        std::string_view name;
        uint32_t idx;  // index into runEntries_
      };
      std::string dirPath;          // absolute path (rootPath + relative dir)
      std::vector<Entry> entries;   // sorted by Entry::name (memcmp ascending)
    };

    /** Per-entry Phase-A slot for processBulkDir_. ino == 0 marks unset;
     *  macOS getattrlistbulk on APFS/HFS+ never returns a regular-file
     *  VREG with file_id 0 (root is 2, userland files are larger). */
    struct BulkStat {
      uint64_t ino;
      uint64_t mtime_ns;
      uint64_t ctime_ns;
      uint64_t size;
    };
    std::vector<BulkDirJob> dirJobs_;
    /** Entry indices NOT covered by dirJobs_ — walked by the per-entry path.
     *  When dirJobs_ is empty this is just [0..fileCount_) for compat. */
    std::vector<uint32_t> entryQueueIdx_;

    alignas(64) mutable std::atomic<size_t> nextDirJob_{0};
    mutable std::atomic<size_t> nextIndex_{0};
    mutable std::atomic<MatchResult> matchResult_{MatchResult::OK};

    struct Job : ForkJob<Job, MAX_CACHE_IO_THREADS> {
      CacheOpen * owner;
      void forkWork() noexcept { this->owner->processStat_(); }
      void forkDone() noexcept { onStatDone_(this->owner); }
    };
    mutable Job job_;

    // - JS-thread-only fields

    Napi::ObjectReference pathsRef_;
    Napi::ObjectReference stateRef_;
    Napi::ObjectReference dirtyRef_;

    static_assert(
      READ_BUFFER_SIZE + sizeof(PathResolver) <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "buffers exceed pool thread usable stack");

    Napi::Buffer<uint8_t> makeDataBuf_(Napi::Env napiEnv) {
      const size_t len = this->dataBuf_.len;
      uint8_t * ptr = this->dataBuf_.release();
      if (ptr) [[likely]] {
        return Napi::Buffer<uint8_t>::New(napiEnv, ptr, len, [](Napi::Env, uint8_t * p) {
          free(p);
        });
      }
      auto buf = Napi::Buffer<uint8_t>::New(napiEnv, CacheHeader::SIZE);
      memset(buf.Data(), 0, CacheHeader::SIZE);
      return buf;
    }

    /** Stamp final header fields + store results for OnOK. */
    void finalize_(CacheStatus st) noexcept {
      CacheHeader * hdr = headerOf(this->dataBuf_.ptr);
      // In-memory placeholder; the writer chooses the actual on-disk
      // BodyFormat when it serializes.
      hdr->magic = CacheHeader::makeMagic(BodyFormat::LZ4);
      hdr->version = this->version_;
      if (this->hasFingerprint_) {
        hdr->fingerprint = this->fingerprint_;
      }

      this->resultStatus_ = static_cast<uint32_t>(st);
      // resultStat_ stamped by readOldCache_; left zero on lockFailed / never-read paths.
    }

    /** Adopt `oldBuf` as our dataBuf if its entry count matches what JS
     *  will iterate; otherwise leave dataBuf_ empty so finish_ synthesizes
     *  a fresh one. Then signal completion with `st`. */
    void adoptOldBufOrSynthesize_(OwnedBuf<> & oldBuf, uint32_t oldFc, CacheStatus st) noexcept {
      if (oldFc == this->fileCount_) {
        this->dataBuf_ = std::move(oldBuf);
      }
      this->finish_(st);
    }

    FSH_NO_INLINE void finish_(CacheStatus st) noexcept {
      if (!this->dataBuf_) [[unlikely]] {
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
      OwnedBuf<> oldBuf;
      const CacheStatus loadStatus = this->readOldCache_(oldBuf, oldHdr, oldFc, oldBodyLen);

      if (loadStatus == CacheStatus::MISSING) [[unlikely]] {
        this->finish_(CacheStatus::MISSING);
        return;
      }

      const bool reuse = this->encodedLen_ == 0;
      if (reuse) {
        this->fileCount_ = oldFc;
      }

      if (loadStatus == CacheStatus::STALE || loadStatus == CacheStatus::STALE_VERSION) {
        this->adoptOldBufOrSynthesize_(oldBuf, oldFc, loadStatus);
        return;
      }

      const uint32_t fc = this->fileCount_;
      if (fc == 0) {
        this->dataBuf_ = std::move(oldBuf);
        this->finish_(CacheStatus::UP_TO_DATE);
        return;
      }

      bool sameFiles = reuse;
      if (!sameFiles) {
        sameFiles = pathsMatch(this->encodedPaths_, this->encodedLen_, fc, oldBuf.ptr);
      }

      if (!sameFiles) {
        this->adoptOldBufOrSynthesize_(oldBuf, oldFc, CacheStatus::CHANGED);
        return;
      }

      this->dataBuf_ = std::move(oldBuf);

      if (this->cancel_.is_fired() || this->addon->pool.is_shutdown()) [[unlikely]] {
        this->finish_(CacheStatus::MISSING);
        return;
      }

      uint8_t * buf = this->dataBuf_.ptr;
      CacheHeader * hdr = headerOf(buf);
      const uint32_t compCount = hdr->compressedPayloadItemCount;
      const uint32_t uncCount = hdr->uncompressedPayloadItemCount;
      const uint32_t uncLen = hdr->uncompressedPayloadsLen;

      CacheEntry * entries = entriesOf(buf, uncCount, uncLen);

      // Disk entries have the high 3 bits cleared (CacheWriter strips
      // INO_STATE_MASK | INO_CHANGED_BIT before writing). We can OR-in the
      // initial state without masking — the load-OR-store fuses to a single
      // RMW on the entry's ino byte.
      if (this->hasDirtyHint_ && this->dirtyCount_ == 0 && this->dirtyLen_ == 0) {
        // Empty dirty hint: all entries trusted, no stat needed.
        // Skips pool submission, fork-join overhead, and the entire stat loop.
        for (uint32_t i = 0; i < fc; ++i) {
          entries[i].ino |= CACHE_S_DONE;
        }
        this->finish_(CacheStatus::UP_TO_DATE);
        return;
      } else if (this->hasDirtyHint_ && this->dirtyPaths_ && this->dirtyCount_ > 0) {
        // Sorted-vector membership test: one contiguous allocation instead
        // of std::unordered_set's per-node mallocs. lower_bound binary search
        // is comparable to (or faster than) the hashmap probe at the n we
        // see in practice (tens to low thousands of dirty paths).
        std::vector<std::string_view> dirtyList;
        dirtyList.reserve(this->dirtyCount_);
        const uint8_t * dp = this->dirtyPaths_;
        const uint8_t * dpEnd = dp + this->dirtyLen_;
        const uint8_t * segStart = dp;
        for (const uint8_t * p = dp; p <= dpEnd; ++p) {
          if (p == dpEnd || *p == 0) {
            if (p > segStart) {
              dirtyList.emplace_back(reinterpret_cast<const char *>(segStart), p - segStart);
            }
            segStart = p + 1;
          }
        }
        std::sort(dirtyList.begin(), dirtyList.end());

        const uint32_t * pathEnds = pathEndsOf(buf, fc, compCount, uncCount, uncLen);
        const uint8_t * packedPaths = pathsOf(buf, fc, compCount, uncCount, uncLen);
        uint32_t prevEnd = 0;
        for (uint32_t i = 0; i < fc; ++i) {
          const uint32_t pEnd = pathEnds[i];
          const uint32_t pLen = pEnd - prevEnd;
          std::string_view path(reinterpret_cast<const char *>(packedPaths + prevEnd), pLen);
          prevEnd = pEnd;
          const bool isDirty = std::binary_search(dirtyList.begin(), dirtyList.end(), path);
          entries[i].ino |= isDirty ? CACHE_S_HAS_OLD : CACHE_S_DONE;
        }
      } else {
        for (uint32_t i = 0; i < fc; ++i) {
          entries[i].ino |= CACHE_S_HAS_OLD;
        }
      }

      this->runEntries_ = entries;
      this->runPathEnds_ = pathEndsOf(buf, fc, compCount, uncCount, uncLen);
      this->runPackedPaths_ = pathsOf(buf, fc, compCount, uncCount, uncLen);
      this->runPackedPathsSize_ = hdr->pathsLen;

      // Build work units. By default each entry is a per-file job. On
      // macOS, entries whose parent directory holds many siblings are
      // grouped into a BulkDirJob so workers can stat the whole dir in one
      // getattrlistbulk syscall.
      this->buildWorkUnits_();

      int threadCount = ThreadPool::compute_threads(0, fc, MAX_OPEN_THREADS, 64);
      this->workBatch_ = computeBatchSize(threadCount, fc);
      this->nextDirJob_.store(0, std::memory_order_relaxed);
      this->nextIndex_.store(0, std::memory_order_relaxed);
      this->matchResult_.store(MatchResult::OK, std::memory_order_relaxed);

      // Open the root directory fd ONCE on this thread, instead of once per
      // worker thread. processStat_ workers read from runDirFd_ instead of
      // opening their own DirFd. Saves (threadCount - 1) openat syscalls.
      this->runDirFd_ = DirFd(this->rootPath_.c_str(), fc);

      this->job_.owner = this;
      this->addon->pool.submit(this->job_, threadCount);
    }

    static void onStatDone_(CacheOpen * self) {
      const MatchResult mr = self->matchResult_.load(std::memory_order_relaxed);

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
     * Load the on-disk cache and report status.
     *
     *   - {@link CacheStatus::MISSING} — file missing/truncated, bad
     *     magic, bad header limits, LZ4 body decompress failure, or
     *     packed-paths corruption. `oldBuf` is empty.
     *   - {@link CacheStatus::STALE_VERSION} — well-formed but disk
     *     `version` differs from the caller's. `oldBuf` is populated.
     *   - {@link CacheStatus::STALE} — well-formed at the right version
     *     but fingerprint doesn't match. `oldBuf` is populated.
     *   - {@link CacheStatus::UP_TO_DATE} — passed every load-time
     *     check; may still be downgraded to CHANGED by the caller's
     *     subsequent path-match step.
     */
    CacheStatus readOldCache_(
      OwnedBuf<> & oldBuf,
      const CacheHeader *& hdr,
      uint32_t & fc,
      size_t & bodyLen) noexcept {
      const int lockFd = this->lockedFile_.fd;
      if (lockFd < 0) [[unlikely]] {
        return CacheStatus::MISSING;
      }

      // One fstat covers size + stat hash. Stamp resultStat_ now so finalize_
      // doesn't need a second fstat; compare against the previous value when
      // we have a baseline to detect a byte-identical re-open.
      CacheEntry statEntry{};
      if (!FfshFile::fstat_into(lockFd, statEntry)) [[unlikely]] {
        return CacheStatus::MISSING;
      }
      const int64_t fileSize = static_cast<int64_t>(statEntry.size);
      if (fileSize < static_cast<int64_t>(CacheHeader::SIZE) || fileSize > static_cast<int64_t>(CACHE_MAX_FILE_SIZE))
        [[unlikely]] {
        return CacheStatus::MISSING;
      }
      const size_t diskSize = static_cast<size_t>(fileSize);

      // Cache-file unchanged fast path: the flock window guarantees nobody
      // else has touched the file between our writes, and stat-hash equality
      // ⇒ bit-identical contents ⇒ in-memory validation is redundant.
      bool cacheFileUnchanged = false;
      {
        const double prev0 = this->state_->cacheFileStat0;
        const double prev1 = this->state_->cacheFileStat1;
        hashCacheFileStat(statEntry, this->resultStat_);
        if (prev0 != 0.0 || prev1 != 0.0) {
          cacheFileUnchanged = (this->resultStat_[0] == prev0) && (this->resultStat_[1] == prev1);
        }
      }

      // Peek the header so we can size the final buffer correctly. Positional
      // read — leaves the fd's seek position untouched so the disk-side reads
      // below can be issued in any order via pread_at_most.
      CacheHeader peekHdr;
      const int64_t hn = this->lockedFile_.pread_at_most(&peekHdr, CacheHeader::SIZE, 0);
      if (hn < 0 || static_cast<size_t>(hn) < CacheHeader::SIZE) [[unlikely]] {
        return CacheStatus::MISSING;
      }
      if (!peekHdr.validateLimits()) [[unlikely]] {
        return CacheStatus::MISSING;
      }

      fc = peekHdr.fileCount;
      const size_t uncSectionSize = peekHdr.uncompressedSectionSize();
      const size_t uncompBodySize = peekHdr.bodySize();

      // In-memory dataBuf layout mirrors disk:
      //   [header][uncompressed section][decompressed body]
      bodyLen = CacheHeader::SIZE + uncSectionSize + uncompBodySize;
      if (bodyLen > CACHE_MAX_BODY_SIZE) [[unlikely]] {
        return CacheStatus::MISSING;
      }

      const size_t diskPrefix = CacheHeader::SIZE + uncSectionSize;
      if (diskSize < diskPrefix) [[unlikely]] {
        return CacheStatus::MISSING;
      }
      const size_t onDiskBodyLen = diskSize - diskPrefix;
      if (uncompBodySize > 0 && onDiskBodyLen == 0) [[unlikely]] {
        return CacheStatus::MISSING;
      }
      const BodyFormat bodyFormat = static_cast<BodyFormat>(peekHdr.bodyFormatByte());
      if (bodyFormat == BodyFormat::PLAIN && onDiskBodyLen != uncompBodySize) [[unlikely]] {
        // PLAIN body has no compression — disk size must match the logical
        // body length exactly. Mismatch ⇒ corruption.
        return CacheStatus::MISSING;
      }

      this->diskVersion_ = peekHdr.version;
      CacheStatus staleStatus = CacheStatus::UP_TO_DATE;
      if (peekHdr.version != this->version_) {
        staleStatus = CacheStatus::STALE_VERSION;
      } else if (!this->hasFingerprint_) {
        if (!peekHdr.fingerprint.is_zero()) {
          staleStatus = CacheStatus::STALE;
        }
      } else if (peekHdr.fingerprint != this->fingerprint_) {
        staleStatus = CacheStatus::STALE;
      }

      // Allocation size depends on body encoding:
      //   PLAIN — body fits 1:1 into final position; just bodyLen.
      //   LZ4   — needs extra tail room so the compressed source can sit at
      //           the end of the alloc while in-place decompression writes
      //           forward into the body region. Capacity required is
      //           diskPrefix + max(onDiskBodyLen, uncompBodySize) +
      //           LZ4_DECOMPRESS_INPLACE_MARGIN(onDiskBodyLen) — handles
      //           the incompressible-body edge where the LZ4 frame is
      //           larger than its expanded contents.
      size_t allocLen = bodyLen;
      if (uncompBodySize > 0 && bodyFormat == BodyFormat::LZ4) {
        const size_t maxBody = onDiskBodyLen > uncompBodySize ? onDiskBodyLen : uncompBodySize;
        const size_t bodyCap = maxBody + LZ4_DECOMPRESS_INPLACE_MARGIN(onDiskBodyLen);
        const size_t needed = diskPrefix + bodyCap;
        if (needed > allocLen) {
          allocLen = needed;
        }
      }
      oldBuf = OwnedBuf<>::alloc(allocLen);
      if (!oldBuf) [[unlikely]] {
        return CacheStatus::MISSING;
      }

      memcpy(oldBuf.ptr, &peekHdr, CacheHeader::SIZE);

      // Read uncompressed section directly to its final position.
      if (uncSectionSize > 0) {
        const int64_t un = this->lockedFile_.pread_at_most(
          oldBuf.ptr + CacheHeader::SIZE, uncSectionSize, CacheHeader::SIZE);
        if (un < 0 || static_cast<size_t>(un) < uncSectionSize) [[unlikely]] {
          oldBuf.reset();
          return CacheStatus::MISSING;
        }
      }

      if (uncompBodySize > 0) {
        if (bodyFormat == BodyFormat::PLAIN) {
          // No decompression. One pread directly into final body position.
          const int64_t bn =
            this->lockedFile_.pread_at_most(oldBuf.ptr + diskPrefix, onDiskBodyLen, diskPrefix);
          if (bn < 0 || static_cast<size_t>(bn) < onDiskBodyLen) [[unlikely]] {
            oldBuf.reset();
            return CacheStatus::MISSING;
          }
        } else {
          // LZ4 in-place: read compressed body at the tail, decompress forward.
          uint8_t * const compDst = oldBuf.ptr + allocLen - onDiskBodyLen;
          const int64_t cn = this->lockedFile_.pread_at_most(compDst, onDiskBodyLen, diskPrefix);
          if (cn < 0 || static_cast<size_t>(cn) < onDiskBodyLen) [[unlikely]] {
            oldBuf.reset();
            return CacheStatus::MISSING;
          }
          const int decompressed = LZ4_decompress_safe(
            reinterpret_cast<const char *>(compDst),
            reinterpret_cast<char *>(oldBuf.ptr + diskPrefix),
            static_cast<int>(onDiskBodyLen),
            static_cast<int>(uncompBodySize));
          if (decompressed < 0 || static_cast<size_t>(decompressed) != uncompBodySize) [[unlikely]] {
            oldBuf.reset();
            return CacheStatus::MISSING;
          }
        }
      }

      oldBuf.truncate(bodyLen);

      hdr = headerOf(oldBuf.ptr);

      if (!cacheFileUnchanged && !hdr->packedPathsValid(oldBuf.ptr)) [[unlikely]] {
        oldBuf.reset();
        return CacheStatus::MISSING;
      }

      return staleStatus;
    }

    FSH_FORCE_INLINE static bool statMatchHashFile_(
      PathResolver & resolver, CacheEntry & entry, const Hash128 & oldContentHash,
      unsigned char * readBuf) {
      resolver.hash_file(entry.contentHash, readBuf, READ_BUFFER_SIZE);
      return entry.contentHash == oldContentHash;
    }

    /** Per-directory threshold for promoting a directory to a BulkDirJob
     *  via getattrlistbulk. Env-tunable via FAST_FS_HASH_BULK_STAT_MIN. */
    static FSH_FORCE_INLINE size_t statBulkThreshold_() noexcept {
      static const size_t v = [] {
        const char * env = std::getenv("FAST_FS_HASH_BULK_STAT_MIN");
        if (env && env[0] != '\0') {
          const long val = std::strtol(env, nullptr, 10);
          if (val > 0 && val <= 65536) {
            return static_cast<size_t>(val);
          }
        }
        return STAT_BULK_PER_DIR_MIN;
      }();
      return v;
    }

    /** Return the byte offset of the last '/' in `[p, p+n)`, or `n` when
     *  there is no slash. Used to split each packed path into (dir, basename).
     *  Apple-only helper for now; Linux walks the same packed paths but
     *  doesn't currently need basename extraction. */
    static FSH_FORCE_INLINE size_t lastSlash_(const uint8_t * p, size_t n) noexcept {
      for (size_t i = n; i > 0; --i) {
        if (p[i - 1] == '/') {
          return i - 1;
        }
      }
      return n;
    }

    /** Group entries by their parent-directory prefix.
     *
     *  Inputs: runPathEnds_, runPackedPaths_, runEntries_, fileCount_.
     *  Outputs: this->dirJobs_, this->entryQueueIdx_.
     *
     *  Decision is PER directory: each bucket independently crosses or
     *  doesn't cross STAT_BULK_PER_DIR_MIN. A small project with one
     *  big subdirectory and many scattered files still benefits — the big
     *  directory becomes a bulk job; the scattered files stay on fstatat.
     *
     *  On non-macOS (and when no directory holds enough files), the result is
     *  empty dirJobs_ and entryQueueIdx_ = [0..fc), preserving today's
     *  per-entry work-stealing. */
    void buildWorkUnits_() noexcept {
      const uint32_t fc = this->fileCount_;
      this->dirJobs_.clear();
      this->entryQueueIdx_.clear();
      this->entryQueueIdx_.reserve(fc);

#  ifdef __APPLE__
      if (this->cancel_.is_fired()) [[unlikely]] {
        for (uint32_t i = 0; i < fc; ++i) {
          this->entryQueueIdx_.push_back(i);
        }
        return;
      }
      const size_t threshold = statBulkThreshold_();

      // Per-prefix bucket. unordered_map wins over sort-then-scan here in
      // the typical case: many files share few parent dirs, so hashmap is
      // O(fc) with cheap string_view hashes vs sort's O(fc log fc) with a
      // memcmp comparator that doesn't get amortized away.
      struct Bucket {
        const uint8_t * prefixPtr = nullptr;
        size_t prefixLen = 0;
        std::vector<BulkDirJob::Entry> entries;
      };
      std::unordered_map<std::string_view, Bucket> buckets;
      buckets.reserve(fc / 4);

      uint32_t prevEnd = 0;
      for (uint32_t i = 0; i < fc; ++i) {
        const uint32_t end = this->runPathEnds_[i];
        const uint8_t * pathStart = this->runPackedPaths_ + prevEnd;
        const size_t pathLen = static_cast<size_t>(end - prevEnd);
        prevEnd = end;

        const size_t slashPos = lastSlash_(pathStart, pathLen);
        const size_t prefixLen = (slashPos == pathLen) ? 0 : slashPos;
        const size_t baseStart = (slashPos == pathLen) ? 0 : slashPos + 1;
        const size_t baseLen = pathLen - baseStart;

        std::string_view prefixView(reinterpret_cast<const char *>(pathStart), prefixLen);
        Bucket & b = buckets[prefixView];
        if (b.entries.empty()) {
          b.prefixPtr = pathStart;
          b.prefixLen = prefixLen;
        }
        b.entries.push_back({
          std::string_view(reinterpret_cast<const char *>(pathStart + baseStart), baseLen),
          i,
        });
      }

      const size_t rootLen = this->rootPath_.size();
      const bool rootHasTrailingSlash = rootLen > 0 && this->rootPath_[rootLen - 1] == '/';

      for (auto & kv : buckets) {
        Bucket & b = kv.second;
        const size_t bucketSize = b.entries.size();
        if (bucketSize < threshold) {
          for (const auto & e : b.entries) {
            this->entryQueueIdx_.push_back(e.idx);
          }
          continue;
        }
        // Build the absolute directory path for the bloat probe (and, if we
        // proceed, for the BulkDirJob itself).
        std::string dirPath;
        dirPath.reserve(rootLen + 1 + b.prefixLen);
        dirPath.assign(this->rootPath_);
        if (b.prefixLen > 0) {
          if (!rootHasTrailingSlash) {
            dirPath.push_back('/');
          }
          dirPath.append(reinterpret_cast<const char *>(b.prefixPtr), b.prefixLen);
        }

        // Dir-bloat check: skip bulk when the directory holds vastly more
        // entries than we care about (~1 µs per probed dir).
        const size_t totalEntries = FfshFile::dir_entry_count(dirPath.c_str());
        if (totalEntries != SIZE_MAX && totalEntries > bucketSize * STAT_BULK_MAX_DIR_BLOAT) {
          for (const auto & e : b.entries) {
            this->entryQueueIdx_.push_back(e.idx);
          }
          continue;
        }

        // Promote: sort by basename so the bulk callback can use lower_bound.
        BulkDirJob job;
        job.dirPath = std::move(dirPath);
        job.entries = std::move(b.entries);
        std::sort(job.entries.begin(), job.entries.end(),
                  [](const BulkDirJob::Entry & a, const BulkDirJob::Entry & b) {
                    return a.name < b.name;
                  });
        this->dirJobs_.push_back(std::move(job));
      }
#  else
      // Non-Apple: no bulk-stat path yet. All entries go to the per-entry queue.
      for (uint32_t i = 0; i < fc; ++i) {
        this->entryQueueIdx_.push_back(i);
      }
#  endif
    }

    /** Outcome of comparing fresh stat data against the cached values. */
    enum class ReconcileAction : uint8_t {
      CONTINUE,     // entry handled; caller should move on
      ABORT_BATCH,  // matchResult became CHANGED; caller should bail out of its batch
    };

    /**
     * Compare fresh stat data (already in `entry.ino/mtime/ctime/size`) against
     * the captured `old*` values. On match: mark DONE. On size diff: mark
     * STAT_DONE + CHANGED. On metadata-only diff: queue a hash check. On hash
     * mismatch: mark CHANGED.
     *
     * `statOk` must be true if the stat call succeeded. When false, the entry
     * is treated as missing (CHANGED).
     *
     * `resolver` is only consulted when re-hashing is needed. Pass a fully
     * initialized resolver that can `open_file()` the current entry's path.
     */
    FSH_FORCE_INLINE ReconcileAction reconcileStat_(
      CacheEntry & entry,
      uint64_t oldIno,
      uint64_t oldMtime,
      uint64_t oldCtime,
      uint64_t oldSize,
      bool statOk,
      PathResolver & resolver,
      unsigned char * readBuf) const noexcept {
      if (!statOk) [[unlikely]] {
        entry.contentHash.set_zero();
        entry.ino |= CACHE_S_STAT_DONE;
        this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
        return ReconcileAction::ABORT_BATCH;
      }

      if (entry.ino == oldIno && entry.mtimeNs == oldMtime && entry.ctimeNs == oldCtime && entry.size == oldSize)
        [[likely]] {
        entry.ino |= CACHE_S_DONE;
        return ReconcileAction::CONTINUE;
      }

      if (this->matchResult_.load(std::memory_order_relaxed) < MatchResult::STAT_DIRTY) {
        this->matchResult_.store(MatchResult::STAT_DIRTY, std::memory_order_relaxed);
        this->addon->pool.expand(this->job_, 1);
      }

      if (entry.size != oldSize) {
        entry.ino |= CACHE_S_STAT_DONE;
        this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
        return ReconcileAction::ABORT_BATCH;
      }

      const Hash128 oldContentHash = entry.contentHash;
      if (entry.size == 0) {
        entry.contentHash.from_xxh128(XXH3_128bits(nullptr, 0));
        entry.ino |= CACHE_S_DONE;
        if (entry.contentHash == oldContentHash) {
          return ReconcileAction::CONTINUE;
        }
        this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
        return ReconcileAction::ABORT_BATCH;
      }
      if (statMatchHashFile_(resolver, entry, oldContentHash, readBuf)) {
        entry.ino |= CACHE_S_DONE;
        return ReconcileAction::CONTINUE;
      }
      entry.ino |= CACHE_S_DONE;
      this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
      return ReconcileAction::ABORT_BATCH;
    }

    /** Phase-1 loop: claim and process dir-jobs (bulk-stat per directory).
     *  Returns CONTINUE on normal exhaustion of the queue, ABORT_BATCH when
     *  the worker should bail (matchResult became CHANGED, cancel fired, or
     *  pool shutdown). Empty dirJobs_ → instant CONTINUE. */
    FSH_FORCE_INLINE ReconcileAction processStatDirJobs_(
      PathResolver & resolver, size_t maxSegCap, unsigned char * readBuf,
      std::vector<BulkStat> & bulkData) const noexcept {
      const size_t dirJobCount = this->dirJobs_.size();
      if (dirJobCount == 0) {
        return ReconcileAction::CONTINUE;
      }
      const FfshFile::LockCancel * cancel = &this->cancel_;
      ThreadPool & pool = this->addon->pool;
      for (;;) {
        if (this->matchResult_.load(std::memory_order_relaxed) >= MatchResult::CHANGED) [[unlikely]] {
          return ReconcileAction::ABORT_BATCH;
        }
        if (cancel->is_fired() || pool.is_shutdown()) [[unlikely]] {
          return ReconcileAction::ABORT_BATCH;
        }
        const size_t didx = this->nextDirJob_.fetch_add(1, std::memory_order_relaxed);
        if (didx >= dirJobCount) {
          return ReconcileAction::CONTINUE;
        }
        this->processBulkDir_(this->dirJobs_[didx], resolver, maxSegCap, readBuf, bulkData);
      }
    }

    void processStat_() const {
      const size_t workBatch = this->workBatch_;
      CacheEntry * FSH_RESTRICT const entries = this->runEntries_;
      const uint32_t * FSH_RESTRICT const pathEnds = this->runPathEnds_;
      const uint8_t * FSH_RESTRICT const packedPaths = this->runPackedPaths_;
      const size_t packedPathsSize = this->runPackedPathsSize_;
      const uint32_t * FSH_RESTRICT const entryQueue = this->entryQueueIdx_.data();
      const size_t entryQueueSize = this->entryQueueIdx_.size();
      const FfshFile::LockCancel * cancel = &this->cancel_;
      ThreadPool & pool = this->addon->pool;

      const std::string & rootRef = this->rootPath_;
      const char * rootPath = rootRef.c_str();
      const size_t rootPathLen = rootRef.size();
      // Use the shared root DirFd opened in doOpen_, instead of opening
      // a per-thread one. Saves (threadCount - 1) openat syscalls per call.
      PathResolver resolver;
      resolver.init(this->runDirFd_, rootPath, rootPathLen);
      const size_t maxSegCap = FSH_MAX_PATH > resolver.prefix_len + 1 ? FSH_MAX_PATH - resolver.prefix_len - 1 : 0;

      // Worker-owned scratch for the whole call. Hash readBuf for
      // statMatchHashFile_; the first 32 KiB is also donated to
      // processBulkDir_'s getattrlistbulk iteration. Bulk Phase A and
      // hash Phase B are serialized, so reusing the region is safe.
      alignas(64) unsigned char readBuf[READ_BUFFER_SIZE];

      // Per-worker bulkData vector, reused across all dir-jobs this worker
      // claims — grows monotonically to the largest dir size then stays put.
      // Eliminates the per-dir-job malloc on the validate hot path.
      std::vector<BulkStat> bulkData;

      // Phase 1: dir-clustered work (large directories via platform bulk-stat).
      // Returns early if matchResult / cancel / shutdown aborts the worker.
      if (this->processStatDirJobs_(resolver, maxSegCap, readBuf, bulkData) == ReconcileAction::ABORT_BATCH) [[unlikely]] {
        goto done;
      }

      // Phase 2: per-entry batches over the leftover entries (small dirs +
      // unclustered files). Indexes into entryQueueIdx_ — a possibly-sparse
      // subset of [0..fc) when dir-jobs absorbed the large clusters.
      for (;;) {
        if (this->matchResult_.load(std::memory_order_relaxed) >= MatchResult::CHANGED) [[unlikely]] {
          break;
        }
        if (cancel->is_fired() || pool.is_shutdown()) [[unlikely]] {
          break;
        }

        const size_t baseIdx = this->nextIndex_.fetch_add(workBatch, std::memory_order_relaxed);
        if (baseIdx >= entryQueueSize) [[unlikely]] {
          break;
        }
        const size_t batchEnd = baseIdx + workBatch < entryQueueSize ? baseIdx + workBatch : entryQueueSize;

        for (size_t i = baseIdx; i < batchEnd; ++i) {
          const uint32_t idx = entryQueue[i];
          const uint32_t pathEnd = pathEnds[idx];
          const uint32_t pathStart = idx == 0 ? 0u : pathEnds[idx - 1];

          if (pathEnd < pathStart || pathEnd > packedPathsSize) [[unlikely]] {
            this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
            goto done;
          }

          CacheEntry & entry = entries[idx];
          const uint64_t inoWithState = entry.ino;
          const uint64_t state = inoWithState & INO_STATE_MASK;

          if (state == CACHE_S_DONE) [[likely]] {
            continue;
          }

          const size_t pathLen = pathEnd - pathStart;
          const uint32_t pathOffset = pathStart;

          if (i + 1 < batchEnd) [[likely]] {
            FSH_PREFETCH_W(&entries[entryQueue[i + 1]]);
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
            const ReconcileAction act =
              this->reconcileStat_(entry, oldIno, oldMtime, oldCtime, oldSize, statOk, resolver, readBuf);
            if (act == ReconcileAction::ABORT_BATCH) [[unlikely]] {
              goto done;
            }
            continue;
          }

          this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
          goto done;
        }
      }
    done:;
    }

#  ifdef __APPLE__
    /** Bulk-stat one directory in two phases. Phase A collects stat data
     *  via getattrlistbulk into per-entry slots; Phase B walks the slots
     *  and reconciles (with fstatat fallback for slots Phase A missed:
     *  file gone, name skipped, listing truncated, dir-open failed).
     *
     *  `bulkData` is reused across calls — caller-owned scratch grows
     *  monotonically to fit the largest dir, eliminating per-call malloc. */
    FSH_NO_INLINE void processBulkDir_(
      const BulkDirJob & job, PathResolver & resolver, size_t maxSegCap,
      unsigned char * readBuf, std::vector<BulkStat> & bulkData) const noexcept {
      CacheEntry * FSH_RESTRICT const entries = this->runEntries_;
      const uint32_t * FSH_RESTRICT const pathEnds = this->runPathEnds_;
      const uint8_t * FSH_RESTRICT const packedPaths = this->runPackedPaths_;

      const size_t n = job.entries.size();
      bulkData.assign(n, {0, 0, 0, 0});

      // Defensive cap: dir-bloat probe already filtered bloated dirs in
      // buildWorkUnits_, but if entries appear between the probe and now
      // (concurrent writer) the bulk enumeration could explode. Cap at
      // bloat × n + 64 so worst-case wasted work matches the probe guard.
      const size_t maxRecords = n * STAT_BULK_MAX_DIR_BLOAT + 64;

      constexpr size_t BULK_BUF_SIZE = 32 * 1024;
      static_assert(BULK_BUF_SIZE >= FfshFile::BULK_BUF_MIN_SIZE,
        "bulk iter buf below documented minimum");
      static_assert(BULK_BUF_SIZE <= READ_BUFFER_SIZE,
        "bulk iter buf must fit inside the shared readBuf");
      const int got = FfshFile::bulk_stat_dir(
        job.dirPath.c_str(), readBuf, BULK_BUF_SIZE, maxRecords,
        [&](const char * name, size_t name_len, uint64_t ino, uint64_t mtime_ns,
            uint64_t ctime_ns, uint64_t size) {
          const std::string_view key(name, name_len);
          auto it = std::lower_bound(
            job.entries.begin(), job.entries.end(), key,
            [](const BulkDirJob::Entry & e, std::string_view k) { return e.name < k; });
          if (it == job.entries.end() || it->name != key) {
            return;
          }
          const size_t local = static_cast<size_t>(it - job.entries.begin());
          bulkData[local] = {ino, mtime_ns, ctime_ns, size};
        });

      const bool bulkAborted = (got < 0);

      for (size_t k = 0; k < n; ++k) {
        const uint32_t entryIdx = job.entries[k].idx;
        CacheEntry & entry = entries[entryIdx];
        const uint64_t inoWithState = entry.ino;
        const uint64_t state = inoWithState & INO_STATE_MASK;
        if (state != CACHE_S_HAS_OLD) {
          continue;
        }

        const uint64_t oldIno = inoWithState & INO_VALUE_MASK;
        const uint64_t oldMtime = entry.mtimeNs;
        const uint64_t oldCtime = entry.ctimeNs;
        const uint64_t oldSize = entry.size;

        const uint32_t pathEnd = pathEnds[entryIdx];
        const uint32_t pathStart = entryIdx == 0 ? 0u : pathEnds[entryIdx - 1];
        const size_t pathLen = pathEnd - pathStart;
        if (pathLen > maxSegCap) [[unlikely]] {
          entry.ino |= CACHE_S_STAT_DONE;
          this->matchResult_.store(MatchResult::CHANGED, std::memory_order_relaxed);
          continue;
        }
        resolver.resolve(packedPaths + pathStart, pathLen);

        const BulkStat & bs = bulkData[k];
        bool statOk;
        if (bs.ino != 0 && !bulkAborted) {
          entry.writeStat(bs.ino & INO_VALUE_MASK, bs.mtime_ns, bs.ctime_ns, bs.size);
          statOk = true;
        } else {
          statOk = resolver.stat_into(entry);
        }
        (void)this->reconcileStat_(entry, oldIno, oldMtime, oldCtime, oldSize, statOk, resolver, readBuf);
      }
    }
#  else
    // Stub for non-Apple — never called (dirJobs_ is always empty).
    FSH_FORCE_INLINE void processBulkDir_(
      const BulkDirJob &, PathResolver &, size_t, unsigned char *,
      std::vector<BulkStat> &) const noexcept {}
#  endif
  };

}  // namespace fast_fs_hash

#endif
