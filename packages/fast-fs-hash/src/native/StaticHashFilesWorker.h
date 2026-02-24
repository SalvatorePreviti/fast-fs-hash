/**
 * StaticHashFilesWorker — standalone async worker for static hashFilesBulk().
 *
 * Hashes all files in parallel AND computes the final xxHash3-128 aggregate
 * digest entirely in the worker thread — no JS instance needed, no main-thread
 * hashing overhead.
 *
 * Three output modes (identified by first charcode of the JS outputMode string):
 *  - DIGEST_ONLY ('d' = 100): 16 bytes — aggregate digest.
 *  - FILES_ONLY  ('f' = 102): N × 16 bytes — per-file hashes.
 *  - ALL         ('a' = 97):  16 + N × 16 bytes — aggregate first, then per-file.
 */

#ifndef _FAST_FS_HASH_STATIC_HASH_FILES_WORKER_H
#define _FAST_FS_HASH_STATIC_HASH_FILES_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"
#include "OutputBuffer.h"
#include "PathIndex.h"
#include "HashFilesWorker.h"

class StaticHashFilesWorker final : public Napi::AsyncWorker {
 public:
  enum class Mode : uint8_t {
    DIGEST_ONLY = 'd',  // 16-byte aggregate digest
    FILES_ONLY = 'f',  // N × 16-byte per-file hashes
    ALL = 'a'  // [16-byte aggregate | N × 16-byte per-file hashes]
  };

  StaticHashFilesWorker(Napi::Env env, Napi::Promise::Deferred deferred, int concurrency, uint64_t seed, Mode mode) :
    Napi::AsyncWorker(env), deferred_(deferred), concurrency_(concurrency), seed_(seed), mode_(mode) {}

  void set_paths(Napi::ObjectReference paths_ref, const uint8_t * data, size_t len) {
    this->paths_ref_ = std::move(paths_ref);
    this->paths_data_ = data;
    this->paths_len_ = len;
  }

  /**
   * Set an external output buffer — the worker writes directly here
   * instead of allocating its own buffer. The ObjectReference keeps
   * the JS buffer alive during async execution.
   */
  void set_external_output(uint8_t * ptr, size_t available, Napi::ObjectReference ref) {
    this->external_ptr_ = ptr;
    this->external_available_ = available;
    this->external_ref_ = std::move(ref);
  }

  void Execute() override {
    PathIndex paths(this->paths_data_, this->paths_len_);
    if (paths.oom()) [[unlikely]] {
      SetError("hashFilesBulk: out of memory");
      return;
    }
    const size_t file_count = paths.count;
    const uint64_t seed = this->seed_;

    if (file_count > 0) [[likely]] {
      const size_t per_file_bytes = file_count * 16;

      switch (this->mode_) {
        case Mode::ALL: {
          // Allocate [digest(16) | per-file hashes (N×16)]
          const size_t total = 16 + per_file_bytes;
          if (this->external_ptr_) {
            if (this->external_available_ < total) [[unlikely]] {
              SetError("hashFilesBulkTo: output buffer too small");
              return;
            }
            this->output_.set_external(this->external_ptr_, total);
          } else if (!this->output_.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, total)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          uint8_t * file_hashes = this->output_.data + 16;
          fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, file_hashes, paths.max_seg_len};
          if (!worker.run(this->concurrency_)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          // Aggregate digest at offset 0
          XXH128_canonicalFromHash(
            reinterpret_cast<XXH128_canonical_t *>(this->output_.data),
            XXH3_128bits_withSeed(file_hashes, per_file_bytes, seed));
          break;
        }

        case Mode::FILES_ONLY: {
          if (this->external_ptr_) {
            if (this->external_available_ < per_file_bytes) [[unlikely]] {
              SetError("hashFilesBulkTo: output buffer too small");
              return;
            }
            this->output_.set_external(this->external_ptr_, per_file_bytes);
          } else if (!this->output_.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, per_file_bytes)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, this->output_.data, paths.max_seg_len};
          if (!worker.run(this->concurrency_)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          break;
        }

        case Mode::DIGEST_ONLY: {
          // Temporary buffer for per-file hashes — freed after aggregate.
          AlignedPtr<uint8_t> tmp(fast_fs_hash::OUTPUT_ALIGNMENT, per_file_bytes);
          if (!tmp) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, tmp.ptr, paths.max_seg_len};
          if (!worker.run(this->concurrency_)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          // Write directly to external buffer or stack digest.
          if (this->external_ptr_) {
            if (this->external_available_ < 16) [[unlikely]] {
              SetError("hashFilesBulkTo: output buffer too small");
              return;
            }
            XXH128_canonicalFromHash(
              reinterpret_cast<XXH128_canonical_t *>(this->external_ptr_),
              XXH3_128bits_withSeed(tmp.ptr, per_file_bytes, seed));
          } else {
            XXH128_canonicalFromHash(
              reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_withSeed(tmp.ptr, per_file_bytes, seed));
          }
          break;
        }
      }
    } else {
      // Zero files -> hash of empty input with seed.
      const auto empty_hash = XXH3_128bits_withSeed(nullptr, 0, seed);

      switch (this->mode_) {
        case Mode::DIGEST_ONLY: {
          if (this->external_ptr_) {
            if (this->external_available_ < 16) [[unlikely]] {
              SetError("hashFilesBulkTo: output buffer too small");
              return;
            }
            XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->external_ptr_), empty_hash);
          } else {
            XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->digest_), empty_hash);
          }
          break;
        }
        case Mode::FILES_ONLY:
          // No file hashes to return — output_ stays null/empty.
          break;
        case Mode::ALL:
          // Return 16-byte digest only (no per-file hashes follow).
          if (this->external_ptr_) {
            if (this->external_available_ < 16) [[unlikely]] {
              SetError("hashFilesBulkTo: output buffer too small");
              return;
            }
            XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->external_ptr_), empty_hash);
          } else {
            if (!this->output_.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, 16)) [[unlikely]] {
              SetError("hashFilesBulk: out of memory");
              return;
            }
            XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->output_.data), empty_hash);
          }
          break;
      }
    }
  }

  void OnOK() override {
    auto env = Env();
    Napi::HandleScope scope(env);

    // External output — resolve with undefined (void).
    if (this->external_ptr_) {
      this->output_.free();
      this->deferred_.Resolve(env.Undefined());
      return;
    }

    if (this->mode_ == Mode::DIGEST_ONLY) {
      this->output_.free();
      this->deferred_.Resolve(Napi::Buffer<uint8_t>::Copy(env, this->digest_, 16));
    } else {
      // FILES_ONLY or ALL — return the contiguous output buffer.
      uint8_t * data = this->output_.data;
      size_t len = this->output_.len;
      if (data && len > 0) {
        this->output_.release();
        this->deferred_.Resolve(Napi::Buffer<uint8_t>::New(env, data, len, [](Napi::Env, uint8_t * p) {
          aligned_free(p);
        }));
      } else {
        this->deferred_.Resolve(Napi::Buffer<uint8_t>::New(env, 0));
      }
    }
  }

  void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference paths_ref_;
  const uint8_t * paths_data_ = nullptr;
  size_t paths_len_ = 0;
  int concurrency_ = 0;
  uint64_t seed_ = 0;
  Mode mode_;
  OutputBuffer output_;
  uint8_t digest_[16] = {};
  // External output support (hashFilesBulkTo)
  uint8_t * external_ptr_ = nullptr;
  size_t external_available_ = 0;
  Napi::ObjectReference external_ref_;
};

#endif
