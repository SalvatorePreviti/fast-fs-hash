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
#include "OutputBuffer.h"
#include "PathIndex.h"
#include "HashFilesWorker.h"

class StaticHashFilesWorker final : public Napi::AsyncWorker {
 public:
  enum class Mode : uint8_t {
    DIGEST_ONLY = 'd',  // 16-byte aggregate digest
    FILES_ONLY = 'f',   // N × 16-byte per-file hashes
    ALL = 'a'           // [16-byte aggregate | N × 16-byte per-file hashes]
  };

  StaticHashFilesWorker(Napi::Env env, Napi::Promise::Deferred deferred, int concurrency, uint64_t seed, Mode mode) :
    Napi::AsyncWorker(env), deferred_(deferred), concurrency_(concurrency), seed_(seed), mode_(mode) {}

  void set_paths(Napi::ObjectReference paths_ref, const uint8_t * data, size_t len) {
    this->paths_ref_ = std::move(paths_ref);
    this->paths_data_ = data;
    this->paths_len_ = len;
  }

  void Execute() override {
    PathIndex paths(this->paths_data_, this->paths_len_);
    const size_t file_count = paths.count;
    const uint64_t seed = this->seed_;

    if (file_count > 0) [[likely]] {
      const size_t per_file_bytes = file_count * 16;

      switch (this->mode_) {
        case Mode::ALL: {
          // Allocate [digest(16) | per-file hashes (N×16)]
          const size_t total = 16 + per_file_bytes;
          if (!this->output_.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, total)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          uint8_t * file_hashes = this->output_.data + 16;
          fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, file_hashes};
          worker.run(this->concurrency_);
          // Aggregate digest at offset 0
          XXH128_canonicalFromHash(
            reinterpret_cast<XXH128_canonical_t *>(this->output_.data),
            XXH3_128bits_withSeed(file_hashes, per_file_bytes, seed));
          break;
        }

        case Mode::FILES_ONLY: {
          if (!this->output_.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, per_file_bytes)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, this->output_.data};
          worker.run(this->concurrency_);
          break;
        }

        case Mode::DIGEST_ONLY: {
          // Temporary buffer for per-file hashes — freed after aggregate.
          uint8_t * tmp = static_cast<uint8_t *>(aligned_malloc(fast_fs_hash::OUTPUT_ALIGNMENT, per_file_bytes));
          if (!tmp) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, tmp};
          worker.run(this->concurrency_);
          XXH128_canonicalFromHash(
            reinterpret_cast<XXH128_canonical_t *>(this->digest_),
            XXH3_128bits_withSeed(tmp, per_file_bytes, seed));
          aligned_free(tmp);
          break;
        }
      }
    } else {
      // Zero files → hash of empty input with seed.
      const auto empty_hash = XXH3_128bits_withSeed(nullptr, 0, seed);

      switch (this->mode_) {
        case Mode::DIGEST_ONLY:
          XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->digest_), empty_hash);
          break;
        case Mode::FILES_ONLY:
          // No file hashes to return — output_ stays null/empty.
          break;
        case Mode::ALL:
          // Return 16-byte digest only (no per-file hashes follow).
          if (!this->output_.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, 16)) [[unlikely]] {
            SetError("hashFilesBulk: out of memory");
            return;
          }
          XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->output_.data), empty_hash);
          break;
      }
    }
  }

  void OnOK() override {
    auto env = Env();
    Napi::HandleScope scope(env);

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
};

#endif
