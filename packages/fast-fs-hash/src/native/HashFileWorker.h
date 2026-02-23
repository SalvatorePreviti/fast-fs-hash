/**
 * Async worker that hashes a single file entirely off the main thread.
 *
 * Supports:
 *  - Optional salt (prepended to the hash state before file content)
 *  - Optional external output buffer (writes 16-byte digest at a given offset)
 *  - One-shot fast path for small files (< 128 KiB) when no salt is present
 *
 * Used by both the instance `hashFile()` and static `hashFile()` methods.
 */

#ifndef _FAST_FS_HASH_HASH_FILE_WORKER_H
#define _FAST_FS_HASH_HASH_FILE_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"
#include "FileHandle.h"

class HashFileWorker final : public Napi::AsyncWorker {
 public:
  HashFileWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::string path, uint64_t seed) :
    Napi::AsyncWorker(env), deferred_(deferred), path_(std::move(path)), seed_(seed) {}

  /** Attach an externally-owned output buffer — digest written at `data`. */
  void set_external_output(uint8_t * data, Napi::ObjectReference ref) {
    this->output_data_ = data;
    this->output_ref_ = std::move(ref);
    this->has_external_ = true;
  }

  /** Attach salt data — hashed before file content.  Caller must hold the
   *  ObjectReference to prevent GC until OnOK/OnError. */
  void set_salt(const uint8_t * data, size_t len, Napi::ObjectReference ref) {
    this->salt_data_ = data;
    this->salt_len_ = len;
    this->salt_ref_ = std::move(ref);
  }

  void Execute() override {
    fast_fs_hash::FileHandle fh(this->path_.c_str());
    if (!fh) [[unlikely]] {
      SetError("hashFile: cannot open file");
      return;
    }

    AlignedPtr<uint8_t> rbuf(64, fast_fs_hash::READ_BUFFER_SIZE);
    if (!rbuf) [[unlikely]] {
      SetError("hashFile: out of memory");
      return;
    }

    if (this->salt_len_ > 0) {
      // Salt present — must use streaming (salt bytes + file content).
      XXH3_state_t state;
      XXH3_128bits_reset_withSeed(&state, this->seed_);
      XXH3_128bits_update(&state, this->salt_data_, this->salt_len_);

      for (;;) {
        const int64_t n = fh.read(rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE);
        if (n <= 0) [[unlikely]] {
          if (n < 0) {
            SetError("hashFile: read error");
            return;
          }
          break;
        }
        XXH3_128bits_update(&state, rbuf.ptr, static_cast<size_t>(n));
      }

      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_digest(&state));
    } else {
      // No salt — try one-shot for small files.
      const int64_t n = fh.read(rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE);
      if (n < 0) [[unlikely]] {
        SetError("hashFile: read error");
        return;
      }

      const size_t bytes = static_cast<size_t>(n);
      if (bytes < fast_fs_hash::READ_BUFFER_SIZE) [[likely]] {
        // Entire file in one read — one-shot hash (fast path).
        XXH128_canonicalFromHash(
          reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_withSeed(rbuf.ptr, bytes, this->seed_));
      } else {
        // Large file — streaming.
        fh.hint_sequential();
        XXH3_state_t state;
        XXH3_128bits_reset_withSeed(&state, this->seed_);
        XXH3_128bits_update(&state, rbuf.ptr, bytes);

        for (;;) {
          const int64_t n2 = fh.read(rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE);
          if (n2 <= 0) [[unlikely]] {
            if (n2 < 0) {
              SetError("hashFile: read error");
              return;
            }
            break;
          }
          XXH3_128bits_update(&state, rbuf.ptr, static_cast<size_t>(n2));
        }

        XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_digest(&state));
      }
    }

    // Write to external output if provided.
    if (this->has_external_) {
      memcpy(this->output_data_, this->digest_, 16);
    }
  }

  void OnOK() override {
    auto env = Env();
    Napi::HandleScope scope(env);
    if (this->has_external_) {
      this->deferred_.Resolve(this->output_ref_.Value());
    } else {
      this->deferred_.Resolve(Napi::Buffer<uint8_t>::Copy(env, this->digest_, 16));
    }
  }

  void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::string path_;
  uint64_t seed_;

  const uint8_t * salt_data_ = nullptr;
  size_t salt_len_ = 0;
  Napi::ObjectReference salt_ref_;

  uint8_t * output_data_ = nullptr;
  Napi::ObjectReference output_ref_;
  bool has_external_ = false;

  uint8_t digest_[16] = {};
};

#endif
