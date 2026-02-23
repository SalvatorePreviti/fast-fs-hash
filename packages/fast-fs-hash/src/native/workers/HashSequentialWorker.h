#ifndef _FAST_FS_HASH_HASH_SEQUENTIAL_WORKER_H
#define _FAST_FS_HASH_HASH_SEQUENTIAL_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"
#include "PathIndex.h"
#include "FfshFile.h"
#include "AddonWorker.h"

/**
 * Async worker for sequential file hashing on the pool thread.
 *
 * Two modes:
 *
 * 1. **Instance mode** (setState): streams file data directly into the
 *    caller's XXH3_state_t on the pool thread. Safe because JS does not
 *    touch the state while the promise is pending.
 *
 * 2. **Static/digest mode** (setExternalOutput): uses a local
 *    XXH3_state_t, finalizes the digest, and writes 16 bytes to the
 *    caller-provided output buffer.
 *
 * When throw_on_error is false, files that cannot be opened or read
 * are silently skipped.
 *
 * Resolves with null (instance mode) or the output buffer (static mode).
 */
class HashSequentialWorker final : public fast_fs_hash::AddonWorker {
 public:
  HashSequentialWorker(Napi::Env env, Napi::Promise::Deferred deferred, bool throw_on_error = true) :
    AddonWorker(env, deferred), throw_on_error_(throw_on_error) {}

  /** Set paths from a JS typed array (caller must ref the buffer). */
  void setPaths(Napi::ObjectReference paths_ref, const uint8_t * data, size_t len) {
    this->paths_ref_ = std::move(paths_ref);
    this->paths_data_ = data;
    this->paths_len_ = len;
  }

  /** Instance mode: feed file data into an existing streaming state on pool thread. */
  void setState(Napi::ObjectReference state_ref, uint8_t * state_ptr) {
    this->state_ref_ = std::move(state_ref);
    this->state_ptr_ = state_ptr;
  }

  /** Static/digest mode: write final hash to an external output buffer. */
  void setExternalOutput(uint8_t * ptr, size_t available, Napi::ObjectReference ref) {
    this->external_ptr_ = ptr;
    this->external_available_ = available;
    this->external_ref_ = std::move(ref);
  }

  void Execute() override {
    const bool is_static = this->external_ptr_ != nullptr;

    if (is_static && this->external_available_ < 16) [[unlikely]] {
      this->signal("hashFilesSequential: output buffer too small");
      return;
    }

    PathIndex paths(this->paths_data_, this->paths_len_);
    if (paths.oom()) [[unlikely]] {
      this->signal("hashFilesSequential: out of memory");
      return;
    }

    const size_t fileCount = paths.count;

    // Resolve the state: external instance state, or a local one for static mode.
    XXH3_state_t local_state;
    XXH3_state_t * state;
    if (is_static) {
      state = &local_state;
    } else {
      state = reinterpret_cast<XXH3_state_t *>(this->state_ptr_);
    }

    if (fileCount == 0) [[unlikely]] {
      if (is_static) {
        XXH3_128bits_reset(state);
        XXH128_canonicalFromHash(
          reinterpret_cast<XXH128_canonical_t *>(this->external_ptr_),
          XXH3_128bits_digest(state));
      }
      this->signal();
      return;
    }

    if (is_static) {
      XXH3_128bits_reset(state);
    }

    AlignedPtr<uint8_t> rbuf(64, fast_fs_hash::READ_BUFFER_SIZE);
    if (!rbuf) [[unlikely]] {
      this->signal("hashFilesSequential: out of memory");
      return;
    }

    for (size_t i = 0; i < fileCount; ++i) {
      const char * path = paths.segments[i];
      if (path[0] == '\0') [[unlikely]] {
        continue;
      }

      fast_fs_hash::FfshFile file(path);
      if (!file) [[unlikely]] {
        if (this->throw_on_error_) {
          this->signal("hashFilesSequential: cannot open file");
          return;
        }
        continue;
      }

      for (;;) {
        const int64_t n = file.read(rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE);
        if (n < 0) [[unlikely]] {
          if (this->throw_on_error_) {
            this->signal("hashFilesSequential: read error");
            return;
          }
          break;
        }
        if (n == 0) { break; }
        XXH3_128bits_update(state, rbuf.ptr, static_cast<size_t>(n));
      }
    }

    if (is_static) {
      XXH128_canonicalFromHash(
        reinterpret_cast<XXH128_canonical_t *>(this->external_ptr_),
        XXH3_128bits_digest(state));
    }

    this->signal();
  }

  void OnOK() override {
    auto env = Napi::Env(this->env);
    Napi::HandleScope scope(env);

    if (this->external_ptr_) {
      this->deferred.Resolve(this->external_ref_.Value());
    } else {
      this->deferred.Resolve(env.Null());
    }
  }

 private:
  bool throw_on_error_;

  // Paths
  Napi::ObjectReference paths_ref_;
  const uint8_t * paths_data_ = nullptr;
  size_t paths_len_ = 0;

  // Instance mode
  Napi::ObjectReference state_ref_;
  uint8_t * state_ptr_ = nullptr;

  // Static/digest mode
  uint8_t * external_ptr_ = nullptr;
  size_t external_available_ = 0;
  Napi::ObjectReference external_ref_;
};

#endif
