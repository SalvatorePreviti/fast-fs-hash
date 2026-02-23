/**
 * Async worker that hashes a single file entirely off the main thread.
 *
 * Supports:
 *  - Optional external output buffer (writes 16-byte digest at a given offset)
 *  - One-shot fast path for small files (< 128 KiB)
 */

#ifndef _FAST_FS_HASH_HASH_FILE_WORKER_H
#define _FAST_FS_HASH_HASH_FILE_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"
#include "FfshFile.h"
#include "AddonWorker.h"

class HashFileWorker final : public fast_fs_hash::AddonWorker {
 public:
  HashFileWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::string path, bool throw_on_error = true) :
    AddonWorker(env, deferred), path_(std::move(path)), throw_on_error_(throw_on_error) {}

  /** Attach an externally-owned output buffer — digest written at `data`. */
  void setExternalOutput(uint8_t * data, Napi::ObjectReference ref) {
    this->output_data_ = data;
    this->output_ref_ = std::move(ref);
    this->has_external_ = true;
  }

  void Execute() override {
    fast_fs_hash::FfshFile fh(this->path_.c_str());
    if (!fh) [[unlikely]] {
      if (this->throw_on_error_) {
        this->signal("hashFile: cannot open file");
      } else {
        this->signal();
      }
      return;
    }

    AlignedPtr<uint8_t> rbuf(64, fast_fs_hash::READ_BUFFER_SIZE);
    if (!rbuf) [[unlikely]] {
      this->signal("hashFile: out of memory");
      return;
    }

    // Try one-shot for small files.
    const int64_t n = fh.read_at_most(rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE);
    if (n < 0) [[unlikely]] {
      if (this->throw_on_error_) {
        this->signal("hashFile: read error");
      } else {
        this->signal();
      }
      return;
    }

    const size_t bytes = static_cast<size_t>(n);
    if (bytes < fast_fs_hash::READ_BUFFER_SIZE) [[likely]] {
      // Entire file in one read — one-shot hash (fast path).
      XXH128_canonicalFromHash(
        reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits(rbuf.ptr, bytes));
    } else {
      // Large file — streaming.
      fh.hint_sequential();
      XXH3_state_t state;
      XXH3_128bits_reset(&state);
      XXH3_128bits_update(&state, rbuf.ptr, bytes);

      for (;;) {
        const int64_t n2 = fh.read(rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE);
        if (n2 <= 0) [[unlikely]] {
          if (n2 < 0) {
            if (this->throw_on_error_) {
              this->signal("hashFile: read error");
            } else {
              this->signal();
            }
            return;
          }
          break;
        }
        XXH3_128bits_update(&state, rbuf.ptr, static_cast<size_t>(n2));
      }

      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_digest(&state));
    }

    this->hashed_ = true;

    // Write to external output if provided.
    if (this->has_external_) {
      memcpy(this->output_data_, this->digest_, 16);
    }

    this->signal();
  }

  void OnOK() override {
    auto env = Napi::Env(this->env);
    Napi::HandleScope scope(env);
    if (this->has_external_) {
      // When not hashed (throwOnError=false, file error), zero the output.
      if (!this->hashed_) {
        memset(this->output_data_, 0, 16);
      }
      this->deferred.Resolve(this->output_ref_.Value());
    } else {
      this->deferred.Resolve(Napi::Buffer<uint8_t>::Copy(env, this->digest_, 16));
    }
  }

 private:
  std::string path_;
  bool throw_on_error_;
  bool has_external_ = false;
  bool hashed_ = false;
  uint8_t * output_data_ = nullptr;
  Napi::ObjectReference output_ref_;
  uint8_t digest_[16] = {};
};

#endif
