#ifndef _FAST_FS_HASH_INSTANCE_HASH_WORKER_H
#define _FAST_FS_HASH_INSTANCE_HASH_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"
#include "AddonWorker.h"

class InstanceHashWorker final : public fast_fs_hash::AddonWorker {
 public:
  InstanceHashWorker(
    Napi::Env env, Napi::Promise::Deferred deferred,
    Napi::ObjectReference state_ref, uint8_t * state_ptr,
    int concurrency, bool throw_on_error = true) :
    AddonWorker(env, deferred),
    state_ref_(std::move(state_ref)),
    state_ptr_(state_ptr), concurrency_(concurrency),
    throw_on_error_(throw_on_error) {}

  void setPaths(Napi::ObjectReference paths_ref, const uint8_t * data, size_t len) {
    this->paths_ref_ = std::move(paths_ref);
    this->paths_data_ = data;
    this->paths_len_ = len;
  }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error & e) override;

 private:
  Napi::ObjectReference state_ref_;
  uint8_t * state_ptr_;
  Napi::ObjectReference paths_ref_;
  const uint8_t * paths_data_ = nullptr;
  size_t paths_len_ = 0;
  int concurrency_;
  bool throw_on_error_;

  AlignedPtr<uint8_t> output_;
  size_t output_len_ = 0;
  PathIndex<> paths_index_;
  fast_fs_hash::HashFilesWorker worker_;

  static void onHashDone_(void * raw);
};

#endif
