/**
 * N-API binding for fast-fs-hash.
 *
 * Exposes XXHash128 — synchronous streaming xxHash3-128 ObjectWrap class
 * with a static hashFiles() for async parallel file hashing and an
 * instance hashFilesUpdate() that also merges per-file hashes into the
 * streaming state.
 */

#include <napi.h>
#include <cstring>
#include "hasher.h"

// xxHash — header-only, inlined into this compilation unit.
#define XXH_INLINE_ALL
#include "xxhash.h"

// Forward declaration
class XXHash128Wrap;

// ── HashFilesWorker ──────────────────────────────────────────────────────

/**
 * Async worker that hashes files in parallel using the C++ engine.
 * Returns per-file hashes only (N × 16 bytes).
 */
class HashFilesWorker : public Napi::AsyncWorker {
 public:
  HashFilesWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::vector<uint8_t> file_paths_buf, int concurrency) :
    Napi::AsyncWorker(env), deferred_(deferred), file_paths_buf_(std::move(file_paths_buf)), concurrency_(concurrency) {}

  /** Runs on a background thread — no V8 access allowed. */
  void Execute() override {
    int rc = fast_fs_hash::hash_files(file_paths_buf_.data(), file_paths_buf_.size(), concurrency_, output_, error_message_);
    if (FSH_UNLIKELY(rc != 0)) {
      SetError(error_message_);
    }
  }

  /** Runs on the main thread after Execute() completes successfully. */
  void OnOK() override {
    auto env = Env();
    Napi::HandleScope scope(env);
    auto buf = Napi::Buffer<uint8_t>::Copy(env, output_.data(), output_.size());
    deferred_.Resolve(buf);
  }

  /** Runs on the main thread if Execute() set an error. */
  void OnError(const Napi::Error & error) override { deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<uint8_t> file_paths_buf_;
  int concurrency_;

  std::vector<uint8_t> output_;
  std::string error_message_;
};

// ── HashFilesUpdateWorker ────────────────────────────────────────────────

/**
 * Async worker that hashes files in parallel AND merges the per-file
 * hashes into a specific XXHash128Wrap instance's streaming state.
 *
 * Execute() runs on background threads (file hashing).
 * OnOK() runs on the main V8 thread:
 *   1. Feeds all per-file hashes into the instance's XXH3 state.
 *   2. Resolves the promise with the per-file hash buffer.
 *
 * The instance is prevented from GC by holding an ObjectReference.
 */
class HashFilesUpdateWorker : public Napi::AsyncWorker {
 public:
  HashFilesUpdateWorker(
    Napi::Env env,
    Napi::Promise::Deferred deferred,
    Napi::ObjectReference instance_ref,
    std::vector<uint8_t> file_paths_buf,
    int concurrency) :
    Napi::AsyncWorker(env),
    deferred_(deferred),
    instance_ref_(std::move(instance_ref)),
    file_paths_buf_(std::move(file_paths_buf)),
    concurrency_(concurrency) {}

  void Execute() override {
    int rc = fast_fs_hash::hash_files(file_paths_buf_.data(), file_paths_buf_.size(), concurrency_, output_, error_message_);
    if (FSH_UNLIKELY(rc != 0)) {
      SetError(error_message_);
    }
  }

  // Defined after XXHash128Wrap (needs access to state_)
  void OnOK() override;

  void OnError(const Napi::Error & error) override {
    deferred_.Reject(error.Value());
    instance_ref_.Reset();
  }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference instance_ref_;
  std::vector<uint8_t> file_paths_buf_;
  int concurrency_;

  std::vector<uint8_t> output_;
  std::string error_message_;
};

// ── UpdateFileWorker ─────────────────────────────────────────────────────

/**
 * Async worker that reads files in parallel and feeds their raw contents
 * into a specific XXHash128Wrap instance's streaming state.
 *
 * Execute() runs on background threads (parallel file reading).
 * OnOK() runs on the main V8 thread:
 *   1. Feeds each file's raw contents into the instance's XXH3 state in order.
 *   2. Resolves the promise with the count of successfully read files.
 *
 * The instance is prevented from GC by holding an ObjectReference.
 */
class UpdateFileWorker : public Napi::AsyncWorker {
 public:
  UpdateFileWorker(
    Napi::Env env,
    Napi::Promise::Deferred deferred,
    Napi::ObjectReference instance_ref,
    std::vector<uint8_t> file_paths_buf,
    int concurrency) :
    Napi::AsyncWorker(env),
    deferred_(deferred),
    instance_ref_(std::move(instance_ref)),
    file_paths_buf_(std::move(file_paths_buf)),
    concurrency_(concurrency) {}

  void Execute() override {
    int rc = fast_fs_hash::read_files(file_paths_buf_.data(), file_paths_buf_.size(), concurrency_, results_, error_message_);
    if (FSH_UNLIKELY(rc != 0)) {
      SetError(error_message_);
    }
  }

  // Defined after XXHash128Wrap (needs access to state_)
  void OnOK() override;

  void OnError(const Napi::Error & error) override {
    deferred_.Reject(error.Value());
    instance_ref_.Reset();
  }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference instance_ref_;
  std::vector<uint8_t> file_paths_buf_;
  int concurrency_;

  std::vector<fast_fs_hash::FileReadResult> results_;
  std::string error_message_;
};

// ── XXHash128 ObjectWrap ─────────────────────────────────────────────────

class XXHash128Wrap : public Napi::ObjectWrap<XXHash128Wrap> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
      env,
      "XXHash128",
      {
        InstanceMethod<&XXHash128Wrap::Update>("update"),
        InstanceMethod<&XXHash128Wrap::Digest>("digest"),
        InstanceMethod<&XXHash128Wrap::DigestTo>("digestTo"),
        InstanceMethod<&XXHash128Wrap::Reset>("reset"),
        InstanceMethod<&XXHash128Wrap::HashFilesUpdate>("hashFilesUpdate"),
        InstanceMethod<&XXHash128Wrap::UpdateFile>("updateFile"),
        StaticMethod<&XXHash128Wrap::Hash>("hash"),
        StaticMethod<&XXHash128Wrap::HashFiles>("hashFiles"),
      });
  }

  XXHash128Wrap(const Napi::CallbackInfo & info) : Napi::ObjectWrap<XXHash128Wrap>(info), seed_(0) {
    auto env = info.Env();
    if (info.Length() >= 2) {
      uint32_t lo = info[0].As<Napi::Number>().Uint32Value();
      uint32_t hi = info[1].As<Napi::Number>().Uint32Value();
      seed_ = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);
    }
    XXH3_128bits_reset_withSeed(&state_, seed_);
  }

 private:
  // ── update(data: Buffer, offset: number, length: number) ────────────

  Napi::Value Update(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    if (FSH_UNLIKELY(info.Length() < 3)) {
      Napi::TypeError::New(env, "update: expected (data, offset, length)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();
    uint32_t length = info[2].As<Napi::Number>().Uint32Value();

    if (FSH_UNLIKELY(static_cast<size_t>(offset) + length > buf.Length())) {
      Napi::RangeError::New(env, "update: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    XXH3_128bits_update(&state_, buf.Data() + offset, length);
    return env.Undefined();
  }

  // ── digest() → Buffer (16 bytes) ───────────────────────────────────

  Napi::Value Digest(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, XXH3_128bits_digest(&state_));
    return Napi::Buffer<uint8_t>::Copy(env, canonical.digest, 16);
  }

  // ── digestTo(output: Buffer, offset: number) ───────────────────────

  Napi::Value DigestTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    if (FSH_UNLIKELY(info.Length() < 2)) {
      Napi::TypeError::New(env, "digestTo: expected (output, offset)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();

    if (FSH_UNLIKELY(static_cast<size_t>(offset) + 16 > buf.Length())) {
      Napi::RangeError::New(env, "digestTo: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, XXH3_128bits_digest(&state_));
    memcpy(buf.Data() + offset, canonical.digest, 16);
    return env.Undefined();
  }

  // ── reset() ────────────────────────────────────────────────────────

  Napi::Value Reset(const Napi::CallbackInfo & info) {
    XXH3_128bits_reset_withSeed(&state_, seed_);
    return info.Env().Undefined();
  }

  // ── static hash(data: Buffer, offset: number, length: number, seedLow?: number, seedHigh?: number) → Buffer

  static Napi::Value Hash(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    if (FSH_UNLIKELY(info.Length() < 3)) {
      Napi::TypeError::New(env, "hash: expected (data, offset, length[, seedLow, seedHigh])").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();
    uint32_t length = info[2].As<Napi::Number>().Uint32Value();

    if (FSH_UNLIKELY(static_cast<size_t>(offset) + length > buf.Length())) {
      Napi::RangeError::New(env, "hash: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    uint64_t seed = 0;
    if (info.Length() >= 5) {
      uint32_t lo = info[3].As<Napi::Number>().Uint32Value();
      uint32_t hi = info[4].As<Napi::Number>().Uint32Value();
      seed = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);
    }

    XXH128_hash_t h = XXH3_128bits_withSeed(buf.Data() + offset, length, seed);
    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, h);
    return Napi::Buffer<uint8_t>::Copy(env, canonical.digest, 16);
  }

  // ── static hashFiles(pathsBuf: Buffer, concurrency: number) → Promise<Buffer>

  static Napi::Value HashFiles(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    if (FSH_UNLIKELY(info.Length() < 2)) {
      Napi::TypeError::New(env, "hashFiles: expected (pathsBuf, concurrency)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    auto paths_arg = info[0].As<Napi::Buffer<uint8_t>>();
    std::vector<uint8_t> file_paths_buf(paths_arg.Data(), paths_arg.Data() + paths_arg.Length());
    int concurrency = info[1].As<Napi::Number>().Int32Value();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashFilesWorker(env, deferred, std::move(file_paths_buf), concurrency);
    worker->Queue();

    return deferred.Promise();
  }

  // ── hashFilesUpdate(pathsBuf: Buffer, concurrency: number) → Promise<Buffer>
  //    Instance method: hashes files, then feeds per-file hashes into this
  //    instance's streaming state on the main thread.

  Napi::Value HashFilesUpdate(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    if (FSH_UNLIKELY(info.Length() < 2)) {
      Napi::TypeError::New(env, "hashFilesUpdate: expected (pathsBuf, concurrency)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    auto paths_arg = info[0].As<Napi::Buffer<uint8_t>>();
    std::vector<uint8_t> file_paths_buf(paths_arg.Data(), paths_arg.Data() + paths_arg.Length());
    int concurrency = info[1].As<Napi::Number>().Int32Value();

    // Hold a reference to this JS object to prevent GC while the worker runs
    auto instance_ref = Napi::ObjectReference::New(info.This().As<Napi::Object>(), 1);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker =
      new HashFilesUpdateWorker(env, deferred, std::move(instance_ref), std::move(file_paths_buf), concurrency);
    worker->Queue();

    return deferred.Promise();
  }

  // ── updateFile(pathsBuf: Buffer, concurrency: number) → Promise<number>
  //    Instance method: reads files in parallel, feeds raw contents into
  //    this instance's streaming state in order, returns count of files read.

  Napi::Value UpdateFile(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    if (FSH_UNLIKELY(info.Length() < 2)) {
      Napi::TypeError::New(env, "updateFile: expected (pathsBuf, concurrency)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    auto paths_arg = info[0].As<Napi::Buffer<uint8_t>>();
    std::vector<uint8_t> file_paths_buf(paths_arg.Data(), paths_arg.Data() + paths_arg.Length());
    int concurrency = info[1].As<Napi::Number>().Int32Value();

    // Hold a reference to this JS object to prevent GC while the worker runs
    auto instance_ref = Napi::ObjectReference::New(info.This().As<Napi::Object>(), 1);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker =
      new UpdateFileWorker(env, deferred, std::move(instance_ref), std::move(file_paths_buf), concurrency);
    worker->Queue();

    return deferred.Promise();
  }

  XXH3_state_t state_;
  uint64_t seed_;

  friend class HashFilesUpdateWorker;
  friend class UpdateFileWorker;
};

// ── HashFilesUpdateWorker::OnOK (defined here — needs XXHash128Wrap) ─────

void HashFilesUpdateWorker::OnOK() {
  auto env = Env();
  Napi::HandleScope scope(env);

  // Unwrap the instance and feed all per-file hashes into its streaming state.
  auto * wrap = Napi::ObjectWrap<XXHash128Wrap>::Unwrap(instance_ref_.Value().As<Napi::Object>());
  if (!output_.empty()) {
    XXH3_128bits_update(&wrap->state_, output_.data(), output_.size());
  }

  auto buf = Napi::Buffer<uint8_t>::Copy(env, output_.data(), output_.size());
  deferred_.Resolve(buf);
  instance_ref_.Reset();
}

// ── UpdateFileWorker::OnOK (defined here — needs XXHash128Wrap) ──────────

void UpdateFileWorker::OnOK() {
  auto env = Env();
  Napi::HandleScope scope(env);

  // Unwrap the instance and feed each file's raw contents in order.
  auto * wrap = Napi::ObjectWrap<XXHash128Wrap>::Unwrap(instance_ref_.Value().As<Napi::Object>());
  int count = 0;
  for (const auto & result : results_) {
    if (result.success) {
      if (!result.data.empty()) {
        XXH3_128bits_update(&wrap->state_, result.data.data(), result.data.size());
      }
      count++;
    }
  }

  deferred_.Resolve(Napi::Number::New(env, count));
  instance_ref_.Reset();
}

// ── Module exports ───────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("XXHash128", XXHash128Wrap::Init(env));
  return exports;
}

NODE_API_MODULE(fast_fs_hash, Init)
