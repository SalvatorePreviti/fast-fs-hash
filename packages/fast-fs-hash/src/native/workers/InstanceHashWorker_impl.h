#ifndef _FAST_FS_HASH_INSTANCE_HASH_WORKER_IMPL_H
#define _FAST_FS_HASH_INSTANCE_HASH_WORKER_IMPL_H

#include "InstanceHashWorker.h"
#include "HashFilesWorker.h"
#include "PathIndex.h"

inline void InstanceHashWorker::Execute() {
  this->paths_index_.init(this->paths_data_, this->paths_len_);
  if (this->paths_index_.oom()) [[unlikely]] {
    this->signal("hash_files: out of memory");
    return;
  }

  const size_t fileCount = this->paths_index_.count;
  if (fileCount == 0) [[unlikely]] {
    this->signal();
    return;
  }

  const size_t needed = fileCount * 16;
  this->output_ = AlignedPtr<uint8_t>(fast_fs_hash::OUTPUT_ALIGNMENT, needed);
  if (!this->output_) [[unlikely]] {
    this->signal("hash_files: out of memory");
    return;
  }
  this->output_len_ = needed;

  this->worker_.init(this->paths_index_.segments, fileCount, this->output_.ptr);
  this->worker_.throwOnError = this->throw_on_error_;

  auto * d = this->addon;
  this->worker_.run(d->pool, this->concurrency_, onHashDone_, this);
}

inline void InstanceHashWorker::onHashDone_(void * raw) {
  auto * self = static_cast<InstanceHashWorker *>(raw);
  if (self->throw_on_error_ && self->worker_.hasError.load(std::memory_order_relaxed)) {
    self->signal("hash_files: one or more files could not be read");
    return;
  }

  // Feed per-file hashes into the streaming state on the pool thread.
  // Safe: JS does not touch the state while the promise is pending.
  if (self->output_len_ > 0) {
    auto * state = reinterpret_cast<XXH3_state_t *>(self->state_ptr_);
    XXH3_128bits_update(state, self->output_.ptr, self->output_len_);
  }

  self->signal();
}

inline void InstanceHashWorker::OnOK() {
  fast_fs_hash::clearStreamBusy(this->state_ptr_);
  auto env = Napi::Env(this->env);
  Napi::HandleScope scope(env);
  this->deferred.Resolve(env.Null());
}

inline void InstanceHashWorker::OnError(const Napi::Error & e) {
  fast_fs_hash::clearStreamBusy(this->state_ptr_);
  this->deferred.Reject(e.Value());
}

#endif
