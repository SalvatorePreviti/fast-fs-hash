/**
 * Async worker that reads a single file off-thread and feeds its raw
 * content into a XXHash128Wrap instance's streaming state on completion.
 *
 * Unlike InstanceHashWorker (two-level per-file hashing for bulk ops),
 * this feeds the file bytes directly — equivalent to update(readFile(path)).
 */

#pragma once

#include "FileHandle.h"

class XXHash128Wrap;

class UpdateFileWorker final : public Napi::AsyncWorker {
 public:
  UpdateFileWorker(Napi::Env env, Napi::Promise::Deferred deferred, Napi::ObjectReference instance_ref, std::string path) :
    Napi::AsyncWorker(env), deferred_(deferred), instance_ref_(std::move(instance_ref)), path_(std::move(path)) {}

  ~UpdateFileWorker() { free(this->data_); }

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference instance_ref_;
  std::string path_;

  uint8_t * data_ = nullptr;
  size_t len_ = 0;
};
