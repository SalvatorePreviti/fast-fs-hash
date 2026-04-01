#ifndef _FAST_FS_HASH_UPDATE_FILE_WORKER_H
#define _FAST_FS_HASH_UPDATE_FILE_WORKER_H

#include "includes.h"
#include "FfshFile.h"
#include "AddonWorker.h"

/**
 * Async worker that reads a single file on the pool thread and feeds
 * its content directly into an XXH3_state_t streaming state.
 *
 * The state update happens on the pool thread — safe because JS does not
 * touch the state while the worker is in flight (the promise is pending).
 * No intermediate buffer needed — file data is streamed through a
 * fixed stack-allocated read buffer.
 *
 * When throw_on_error is false, file open/read errors are silently ignored.
 */
class UpdateFileWorker final : public fast_fs_hash::AddonWorker {
 public:
  UpdateFileWorker(
    Napi::Env env,
    Napi::Promise::Deferred deferred,
    Napi::ObjectReference state_ref,
    uint8_t * state_ptr,
    std::string path,
    bool throw_on_error = true) :
    AddonWorker(env, deferred),
    state_ref_(std::move(state_ref)),
    state_ptr_(state_ptr),
    path_(std::move(path)),
    throw_on_error_(throw_on_error) {}

  static_assert(
    fast_fs_hash::READ_BUFFER_SIZE <= fast_fs_hash::ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
    "read buffer exceeds pool thread usable stack");

  void Execute() override {
    fast_fs_hash::FfshFile fh(this->path_.c_str());
    if (!fh) [[unlikely]] {
      if (this->throw_on_error_) {
        this->signal("updateFile: cannot open file");
      } else {
        this->signal();
      }
      return;
    }
    auto * state = reinterpret_cast<XXH3_state_t *>(this->state_ptr_);
    alignas(64) uint8_t rbuf[fast_fs_hash::READ_BUFFER_SIZE];

    // First read — defer hint_sequential until we know the file is large.
    const int64_t n0 = fh.read(rbuf, fast_fs_hash::READ_BUFFER_SIZE);
    if (n0 < 0) [[unlikely]] {
      if (this->throw_on_error_) {
        this->signal("updateFile: read error");
      } else {
        this->signal();
      }
      return;
    }
    if (n0 == 0) {
      this->signal();
      return;
    }
    XXH3_128bits_update(state, rbuf, static_cast<size_t>(n0));

    if (static_cast<size_t>(n0) == fast_fs_hash::READ_BUFFER_SIZE) {
      // File is large — hint sequential for remaining reads.
      fh.hint_sequential();
      for (;;) {
        const int64_t n = fh.read(rbuf, fast_fs_hash::READ_BUFFER_SIZE);
        if (n < 0) [[unlikely]] {
          if (this->throw_on_error_) {
            this->signal("updateFile: read error");
          } else {
            this->signal();
          }
          return;
        }
        if (n == 0) { break; }
        XXH3_128bits_update(state, rbuf, static_cast<size_t>(n));
      }
    }

    this->signal();
  }

  void OnOK() override {
    auto env = Napi::Env(this->env);
    Napi::HandleScope scope(env);
    this->deferred.Resolve(env.Undefined());
  }

 private:
  Napi::ObjectReference state_ref_;
  uint8_t * state_ptr_;
  std::string path_;
  bool throw_on_error_;
};

#endif
