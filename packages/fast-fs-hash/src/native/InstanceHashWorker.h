#ifndef _FAST_FS_HASH_INSTANCE_HASH_WORKER_H
#define _FAST_FS_HASH_INSTANCE_HASH_WORKER_H

#include "includes.h"
#include "OutputBuffer.h"

class XXHash128Wrap;

/**
 * Unified async worker for all instance methods that hash files in parallel
 * and feed per-file hashes into a XXHash128Wrap instance's streaming state.
 *
 * Each file is hashed individually (XXH3-128, seed 0) producing a 16-byte
 * per-file hash. All per-file hashes are then fed as one contiguous block
 * into the instance's streaming state. This two-level approach enables
 * parallel file hashing while keeping the aggregate deterministic.
 *
 * Parameterised by Mode (what the promise resolves with):
 *   RESOLVE_BUFFER — feed + return per-file hash buffer (zero-copy transfer)
 *   RESOLVE_NULL   — feed + resolve null (aggregate / external)
 */
class InstanceHashWorker final : public Napi::AsyncWorker {
 public:
  enum class Mode : uint8_t { RESOLVE_BUFFER, RESOLVE_NULL };

  InstanceHashWorker(
    Napi::Env env, Napi::Promise::Deferred deferred, Napi::ObjectReference instance_ref, int concurrency, Mode mode) :
    Napi::AsyncWorker(env),
    deferred_(deferred),
    instance_ref_(std::move(instance_ref)),
    concurrency_(concurrency),
    mode(mode) {}

  /** Set paths from a JS typed array (caller must ref the buffer). */
  void set_paths(Napi::ObjectReference paths_ref, const uint8_t * data, size_t len) {
    this->paths_ref_ = std::move(paths_ref);
    this->paths_data_ = data;
    this->paths_len_ = len;
  }

  /**
   * Configure EXTERNAL output mode: validate offset/size, attach buffer.
   * Returns nullptr on success, or an error message string on failure.
   */
  const char * set_external_output(Napi::Uint8Array output_arr, size_t offset) {
    uint8_t * data = output_arr.Data();
    size_t len = output_arr.ElementLength();

    if (offset > len) [[unlikely]] {
      return "updateFilesBulk: outputOffset out of range";
    }
    data += offset;
    len -= offset;

    // Count files (null terminators) and validate output buffer size.
    size_t file_count = 0;
    for (size_t i = 0; i < this->paths_len_; ++i) {
      if (this->paths_data_[i] == 0) ++file_count;
    }
    if (file_count * 16 > len) [[unlikely]] {
      return "updateFilesBulk: output buffer too small";
    }

    this->mode = Mode::RESOLVE_NULL;
    this->output_ref = Napi::ObjectReference::New(output_arr, 1);
    this->output.set_external(data, len);
    return nullptr;
  }

  void Execute() override;

  // Defined in InstanceHashWorker.cpp (needs complete XXHash128Wrap definition)
  void OnOK() override;

  void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

  Mode mode;
  Napi::ObjectReference output_ref;
  OutputBuffer output;

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference instance_ref_;
  Napi::ObjectReference paths_ref_;
  const uint8_t * paths_data_ = nullptr;
  size_t paths_len_ = 0;
  int concurrency_;
};

#endif
