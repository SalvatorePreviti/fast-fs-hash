/**
 * StaticHashFilesWorker — async worker for parallel file hashing.
 * Runs entirely on pool threads via AddonWorker. No libuv worker consumed.
 */

#ifndef _FAST_FS_HASH_STATIC_HASH_FILES_WORKER_H
#define _FAST_FS_HASH_STATIC_HASH_FILES_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"
#include "PathIndex.h"
#include "HashFilesWorker.h"
#include "AddonWorker.h"

class StaticHashFilesWorker final : public fast_fs_hash::AddonWorker {
 public:
  StaticHashFilesWorker(Napi::Env env, Napi::Promise::Deferred deferred, int concurrency, bool throw_on_error = true) :
    AddonWorker(env, deferred), concurrency_(concurrency), throw_on_error_(throw_on_error) {}

  void setPaths(Napi::ObjectReference paths_ref, const uint8_t * data, size_t len) {
    this->paths_ref_ = std::move(paths_ref);
    this->paths_data_ = data;
    this->paths_len_ = len;
  }

  void setExternalOutput(uint8_t * ptr, size_t available, Napi::ObjectReference ref) {
    this->external_ptr_ = ptr;
    this->external_available_ = available;
    this->external_ref_ = std::move(ref);
  }

  void Execute() override {
    if (this->external_available_ < 16) [[unlikely]] {
      signal("digestFilesParallelTo: output buffer too small"); return;
    }

    this->paths_index_ = new (std::nothrow) PathIndex<>(this->paths_data_, this->paths_len_);
    if (!this->paths_index_ || this->paths_index_->oom()) [[unlikely]] {
      signal("digestFilesParallelTo: out of memory"); return;
    }

    const size_t fileCount = this->paths_index_->count;
    if (fileCount == 0) [[unlikely]] {
      XXH128_canonicalFromHash(
        reinterpret_cast<XXH128_canonical_t *>(this->external_ptr_),
        XXH3_128bits(nullptr, 0));
      this->signal();
      return;
    }

    this->fileCount_ = fileCount;
    const size_t perFileBytes = fileCount * 16;
    this->tmp_ = AlignedPtr<uint8_t>(fast_fs_hash::OUTPUT_ALIGNMENT, perFileBytes);
    if (!this->tmp_) [[unlikely]] {
      signal("digestFilesParallelTo: out of memory"); return;
    }

    this->worker_ = new (std::nothrow) fast_fs_hash::HashFilesWorker{
      this->paths_index_->segments, fileCount, this->tmp_.ptr, this->paths_index_->max_seg_len};
    if (!this->worker_) [[unlikely]] {
      signal("digestFilesParallelTo: out of memory"); return;
    }
    this->worker_->throwOnError = this->throw_on_error_;

    auto * d = this->addon;
    this->worker_->run(d->pool, this->concurrency_, onHashDone_, this);
  }

  void OnOK() override {
    auto env = Napi::Env(this->env);
    Napi::HandleScope scope(env);
    this->deferred.Resolve(this->external_ref_.Value());
  }

 private:
  Napi::ObjectReference paths_ref_;
  const uint8_t * paths_data_ = nullptr;
  size_t paths_len_ = 0;
  int concurrency_ = 0;
  bool throw_on_error_;
  uint8_t * external_ptr_ = nullptr;
  size_t external_available_ = 0;
  Napi::ObjectReference external_ref_;

  size_t fileCount_ = 0;
  PathIndex<> * paths_index_ = nullptr;
  AlignedPtr<uint8_t> tmp_;
  fast_fs_hash::HashFilesWorker * worker_ = nullptr;

  ~StaticHashFilesWorker() override {
    delete this->paths_index_;
    delete this->worker_;
  }

  static void onHashDone_(void * raw) {
    auto * self = static_cast<StaticHashFilesWorker *>(raw);

    if (self->throw_on_error_ && self->worker_->hasError.load(std::memory_order_relaxed)) {
      self->signal("digestFilesParallelTo: one or more files could not be read");
      return;
    }

    const size_t perFileBytes = self->fileCount_ * 16;
    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(self->external_ptr_),
      XXH3_128bits(self->tmp_.ptr, perFileBytes));

    self->signal();
  }
};

#endif
