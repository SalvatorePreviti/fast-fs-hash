#ifndef _FAST_FS_HASH_CACHE_ASYNC_WORKERS_H
#define _FAST_FS_HASH_CACHE_ASYNC_WORKERS_H

#include "CacheWorkers.h"
#include "PathIndex.h"
namespace fast_fs_hash {

  class CacheStatAndMatchAsyncWorker final : public Napi::AsyncWorker {
   public:
    CacheStatAndMatchAsyncWorker(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      Napi::ObjectReference paths_ref,
      const uint8_t * paths_data,
      size_t paths_len,
      Napi::ObjectReference entries_ref,
      uint8_t * entries_data,
      Napi::ObjectReference old_ref,
      const uint8_t * old_data,
      Napi::ObjectReference states_ref,
      uint8_t * states_data,
      size_t file_count,
      std::string root_path) :
      Napi::AsyncWorker(env),
      deferred_(deferred),
      paths_ref_(std::move(paths_ref)),
      paths_data_(paths_data),
      paths_len_(paths_len),
      entries_ref_(std::move(entries_ref)),
      entries_data_(entries_data),
      old_ref_(std::move(old_ref)),
      old_data_(old_data),
      states_ref_(std::move(states_ref)),
      states_data_(states_data),
      file_count_(file_count),
      root_path_(std::move(root_path)) {}

    void Execute() override {
      const size_t fc = this->file_count_;
      if (fc == 0) {
        this->valid_ = true;
        return;
      }

      PathIndex paths(this->paths_data_, this->paths_len_, fc);
      if (paths.oom()) [[unlikely]] {
        SetError("cacheStatAndMatch: out of memory");
        return;
      }

      if (paths.count == 0) {
        this->valid_ = false;
        return;
      }

      // Use the lesser of path count and expected file count for safety.
      const size_t n = paths.count < fc ? paths.count : fc;

      CacheStatMatchRunner runner{
        paths.segments,
        n,
        this->entries_data_,
        this->old_data_,
        this->states_data_,
        this->root_path_.c_str(),
        this->root_path_.size(),
        paths.max_seg_len,
      };

      if (!runner.run(0)) [[unlikely]] {
        SetError("cacheStatAndMatch: out of memory");
        return;
      }

      this->valid_ = !runner.changed.load(std::memory_order_relaxed) && n == fc;
    }

    void OnOK() override {
      auto env = Env();
      Napi::HandleScope scope(env);
      this->deferred_.Resolve(Napi::Boolean::New(env, this->valid_));
    }

    void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

   private:
    Napi::Promise::Deferred deferred_;
    Napi::ObjectReference paths_ref_;
    const uint8_t * paths_data_;
    size_t paths_len_;
    Napi::ObjectReference entries_ref_;
    uint8_t * entries_data_;
    Napi::ObjectReference old_ref_;
    const uint8_t * old_data_;
    Napi::ObjectReference states_ref_;
    uint8_t * states_data_;
    size_t file_count_;
    std::string root_path_;
    bool valid_ = false;
  };

  class CacheCompleteEntriesAsyncWorker final : public Napi::AsyncWorker {
   public:
    CacheCompleteEntriesAsyncWorker(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      Napi::ObjectReference paths_ref,
      const uint8_t * paths_data,
      size_t paths_len,
      Napi::ObjectReference entries_ref,
      uint8_t * entries_data,
      Napi::ObjectReference states_ref,
      uint8_t * states_data,
      size_t file_count,
      std::string root_path) :
      Napi::AsyncWorker(env),
      deferred_(deferred),
      paths_ref_(std::move(paths_ref)),
      paths_data_(paths_data),
      paths_len_(paths_len),
      entries_ref_(std::move(entries_ref)),
      entries_data_(entries_data),
      states_ref_(std::move(states_ref)),
      states_data_(states_data),
      file_count_(file_count),
      root_path_(std::move(root_path)) {}

    void Execute() override {
      const size_t fc = this->file_count_;
      if (fc == 0) {
        return;
      }

      PathIndex paths(this->paths_data_, this->paths_len_, fc);
      if (paths.oom()) [[unlikely]] {
        SetError("cacheCompleteEntries: out of memory");
        return;
      }

      const size_t n = paths.count < fc ? paths.count : fc;

      if (n == 0) {
        memset(this->entries_data_, 0, fc * CACHE_ENTRY_STRIDE);
        memset(this->states_data_, CACHE_F_NOT_CHECKED, fc);
        return;
      }

      CacheCompleteRunner runner{
        paths.segments,
        n,
        this->entries_data_,
        this->states_data_,
        this->root_path_.c_str(),
        this->root_path_.size(),
        paths.max_seg_len,
      };

      if (!runner.run(0)) [[unlikely]] {
        SetError("cacheCompleteEntries: out of memory");
        return;
      }

      if (n < fc) {
        memset(this->entries_data_ + n * CACHE_ENTRY_STRIDE, 0, (fc - n) * CACHE_ENTRY_STRIDE);
        memset(this->states_data_ + n, CACHE_F_NOT_CHECKED, fc - n);
      }
    }

    void OnOK() override {
      auto env = Env();
      Napi::HandleScope scope(env);
      this->deferred_.Resolve(env.Undefined());
    }

    void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

   private:
    Napi::Promise::Deferred deferred_;
    Napi::ObjectReference paths_ref_;
    const uint8_t * paths_data_;
    size_t paths_len_;
    Napi::ObjectReference entries_ref_;
    uint8_t * entries_data_;
    Napi::ObjectReference states_ref_;
    uint8_t * states_data_;
    size_t file_count_;
    std::string root_path_;
  };

  /**
   * cacheStatAndMatch(entriesBuf, oldBuf, fileStates, pathsBuf, rootPath)
   *   -> Promise<boolean>
   *
   * File count is derived from fileStates.ElementLength().
   * File paths are parsed from pathsBuf (null-separated UTF-8 relative paths).
   * rootPath is prepended to each relative path before stat/hash.
   *
   * Parallel stat + compare with old entries.  Returns true if all files match.
   */
  inline Napi::Value CacheStatAndMatch(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto entriesBuf = info[0].As<Napi::Uint8Array>();
    auto oldBuf = info[1].As<Napi::Uint8Array>();
    auto fileStates = info[2].As<Napi::Uint8Array>();
    auto pathsBuf = info[3].As<Napi::Uint8Array>();
    std::string rootPath = info[4].As<Napi::String>().Utf8Value();

    const size_t file_count = fileStates.ElementLength();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new CacheStatAndMatchAsyncWorker(
      env,
      deferred,
      Napi::ObjectReference::New(pathsBuf, 1),
      pathsBuf.Data(),
      pathsBuf.ElementLength(),
      Napi::ObjectReference::New(entriesBuf, 1),
      entriesBuf.Data(),
      Napi::ObjectReference::New(oldBuf, 1),
      oldBuf.Data(),
      Napi::ObjectReference::New(fileStates, 1),
      fileStates.Data(),
      file_count,
      std::move(rootPath));

    worker->Queue();
    return deferred.Promise();
  }

  /**
   * cacheCompleteEntries(entriesBuf, fileStates, pathsBuf, rootPath)
   *   -> Promise<undefined>
   *
   * File count is derived from fileStates.ElementLength().
   * File paths are parsed from pathsBuf (null-separated UTF-8 relative paths).
   * rootPath is prepended to each relative path before stat/hash.
   *
   * Parallel stat + hash for entries that still need work.
   */
  inline Napi::Value CacheCompleteEntries(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto entriesBuf = info[0].As<Napi::Uint8Array>();
    auto fileStates = info[1].As<Napi::Uint8Array>();
    auto pathsBuf = info[2].As<Napi::Uint8Array>();
    std::string rootPath = info[3].As<Napi::String>().Utf8Value();

    const size_t file_count = fileStates.ElementLength();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new CacheCompleteEntriesAsyncWorker(
      env,
      deferred,
      Napi::ObjectReference::New(pathsBuf, 1),
      pathsBuf.Data(),
      pathsBuf.ElementLength(),
      Napi::ObjectReference::New(entriesBuf, 1),
      entriesBuf.Data(),
      Napi::ObjectReference::New(fileStates, 1),
      fileStates.Data(),
      file_count,
      std::move(rootPath));

    worker->Queue();
    return deferred.Promise();
  }

  /**
   * remapOldEntries(oldEntries, oldPaths, oldCount, newEntries, newStates, newPaths, newCount)
   *   -> undefined
   *
   * Merge-join old sorted null-separated entries with new file list.  For each
   * file that appears in both lists (same path), copies the 48-byte old entry
   * into newEntries at the new position and sets newStates[ni] = F_HAS_OLD.
   * O(oldCount + newCount) time, zero heap allocations.
   *
   * Walks both buffers inline with byte cursors — no PathIndex, no malloc.
   * Segment comparison uses memcmp on raw bytes (length-first short-circuit).
   *
   * Synchronous — no async worker needed since there's no I/O.
   */
  inline Napi::Value CacheRemapOldEntries(const Napi::CallbackInfo & info) {
    auto oldEntriesBuf = info[0].As<Napi::Uint8Array>();
    auto oldPathsBuf = info[1].As<Napi::Uint8Array>();
    const size_t oldCount = info[2].As<Napi::Number>().Uint32Value();
    auto newEntriesBuf = info[3].As<Napi::Uint8Array>();
    auto newStatesBuf = info[4].As<Napi::Uint8Array>();
    auto newPathsBuf = info[5].As<Napi::Uint8Array>();
    const size_t newCount = info[6].As<Napi::Number>().Uint32Value();

    const uint8_t * const oldEntries = oldEntriesBuf.Data();
    uint8_t * const newEntries = newEntriesBuf.Data();
    uint8_t * const newStates = newStatesBuf.Data();

    const uint8_t * const oldPaths = oldPathsBuf.Data();
    const size_t oldPathsLen = oldPathsBuf.ElementLength();
    const uint8_t * const newPaths = newPathsBuf.Data();
    const size_t newPathsLen = newPathsBuf.ElementLength();

    // Byte cursors — no PathIndex, no heap allocations.
    size_t oOff = 0, nOff = 0;
    size_t oi = 0, ni = 0;

    while (oi < oldCount && ni < newCount) {
      // Locate the NUL terminator of the current segment in each buffer.
      const uint8_t * oNul = static_cast<const uint8_t *>(memchr(oldPaths + oOff, 0, oldPathsLen - oOff));
      if (!oNul) [[unlikely]]
        break;
      const uint8_t * nNul = static_cast<const uint8_t *>(memchr(newPaths + nOff, 0, newPathsLen - nOff));
      if (!nNul) [[unlikely]]
        break;

      const size_t oSegLen = static_cast<size_t>(oNul - (oldPaths + oOff));
      const size_t nSegLen = static_cast<size_t>(nNul - (newPaths + nOff));

      // Length-first comparison: if lengths differ the segments cannot be equal.
      int cmp;
      if (oSegLen == nSegLen) {
        cmp = oSegLen > 0 ? memcmp(oldPaths + oOff, newPaths + nOff, oSegLen) : 0;
      } else {
        const size_t minLen = oSegLen < nSegLen ? oSegLen : nSegLen;
        cmp = minLen > 0 ? memcmp(oldPaths + oOff, newPaths + nOff, minLen) : 0;
        if (cmp == 0) cmp = oSegLen < nSegLen ? -1 : 1;
      }

      if (cmp == 0) {
        // Paths match — copy 48-byte old entry to new position.
        memcpy(newEntries + ni * CACHE_ENTRY_STRIDE, oldEntries + oi * CACHE_ENTRY_STRIDE, CACHE_ENTRY_STRIDE);
        newStates[ni] = CACHE_F_HAS_OLD;
        oOff = static_cast<size_t>(oNul - oldPaths) + 1;
        nOff = static_cast<size_t>(nNul - newPaths) + 1;
        ++oi;
        ++ni;
      } else if (cmp < 0) {
        // Old path < new path — file was removed, advance old.
        oOff = static_cast<size_t>(oNul - oldPaths) + 1;
        ++oi;
      } else {
        // Old path > new path — file was added, advance new.
        nOff = static_cast<size_t>(nNul - newPaths) + 1;
        ++ni;
      }
    }

    return info.Env().Undefined();
  }

}  // namespace fast_fs_hash

#endif
