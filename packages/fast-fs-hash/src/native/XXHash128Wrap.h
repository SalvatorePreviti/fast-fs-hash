#ifndef _FAST_FS_HASH_XXHASH128_WRAP_H
#define _FAST_FS_HASH_XXHASH128_WRAP_H

#include "InstanceHashWorker.h"
#include "UpdateFileWorker.h"
#include "StaticHashFilesWorker.h"

// ── XXHash128 ObjectWrap ─────────────────────────────────────────────────

class XXHash128Wrap final : public Napi::ObjectWrap<XXHash128Wrap> {
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
        InstanceMethod<&XXHash128Wrap::HashFilesUpdate>("updateFilesBulk"),
        InstanceMethod<&XXHash128Wrap::HashFilesAggregate>("updateFilesBulkAggregate"),
        InstanceMethod<&XXHash128Wrap::UpdateFile>("updateFile"),
        StaticMethod<&XXHash128Wrap::Hash>("hash"),
        StaticMethod<&XXHash128Wrap::HashFilesBulk>("hashFilesBulk"),
      });
  }

  XXHash128Wrap(const Napi::CallbackInfo & info) : Napi::ObjectWrap<XXHash128Wrap>(info), seed_(0) {
    if (info.Length() >= 2) {
      uint32_t lo = info[0].As<Napi::Number>().Uint32Value();
      uint32_t hi = info[1].As<Napi::Number>().Uint32Value();
      this->seed_ = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);
    }
    XXH3_128bits_reset_withSeed(&this->state, this->seed_);
  }

 private:
  // ── update(data: Buffer, offset: number, length: number) ────────────

  Napi::Value Update(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();
    uint32_t length = info[2].As<Napi::Number>().Uint32Value();

    if (FSH_UNLIKELY(static_cast<size_t>(offset) + length > buf.Length())) {
      Napi::RangeError::New(env, "update: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    XXH3_128bits_update(&this->state, buf.Data() + offset, length);
    return env.Undefined();
  }

  // ── digest() → Buffer (16 bytes) ───────────────────────────────────

  Napi::Value Digest(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, XXH3_128bits_digest(&this->state));
    return Napi::Buffer<uint8_t>::Copy(env, canonical.digest, 16);
  }

  // ── digestTo(output: Buffer, offset: number) ───────────────────────

  Napi::Value DigestTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();

    if (FSH_UNLIKELY(static_cast<size_t>(offset) + 16 > buf.Length())) {
      Napi::RangeError::New(env, "digestTo: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, XXH3_128bits_digest(&this->state));
    memcpy(buf.Data() + offset, canonical.digest, 16);
    return env.Undefined();
  }

  // ── reset() ────────────────────────────────────────────────────────

  Napi::Value Reset(const Napi::CallbackInfo & info) {
    XXH3_128bits_reset_withSeed(&this->state, this->seed_);
    return info.Env().Undefined();
  }

  // ── static hash(data: Buffer, offset: number, length: number, seedLow?, seedHigh?) → Buffer

  static Napi::Value Hash(const Napi::CallbackInfo & info) {
    auto env = info.Env();
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

  // ── hashFilesUpdate(pathsBuf, concurrency[, outputBuf, outputOffset]) → Promise<Buffer | null>

  Napi::Value HashFilesUpdate(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto paths = info[0].As<Napi::Uint8Array>();
    const uint8_t * paths_data = paths.Data();
    size_t paths_len = paths.ElementLength();
    int concurrency = info[1].As<Napi::Number>().Int32Value();

    auto instance_ref = Napi::ObjectReference::New(info.This().As<Napi::Object>(), 1);
    auto deferred = Napi::Promise::Deferred::New(env);

    auto * worker =
      new InstanceHashWorker(env, deferred, std::move(instance_ref), concurrency, InstanceHashWorker::Mode::RESOLVE_BUFFER);
    worker->set_paths(Napi::ObjectReference::New(paths, 1), paths_data, paths_len);

    if (info.Length() >= 3 && info[2].IsTypedArray()) {
      size_t output_offset = info.Length() >= 4 ? info[3].As<Napi::Number>().Uint32Value() : 0;
      const char * err = worker->set_external_output(info[2].As<Napi::Uint8Array>(), output_offset);
      if (FSH_UNLIKELY(err)) {
        delete worker;
        Napi::RangeError::New(env, err).ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }

    worker->Queue();

    return deferred.Promise();
  }

  // ── hashFilesAggregate(pathsBuf, concurrency) → Promise<null>

  Napi::Value HashFilesAggregate(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto paths = info[0].As<Napi::Uint8Array>();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new InstanceHashWorker(
      env,
      deferred,
      Napi::ObjectReference::New(info.This().As<Napi::Object>(), 1),
      info[1].As<Napi::Number>().Int32Value(),
      InstanceHashWorker::Mode::RESOLVE_NULL);
    worker->set_paths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->Queue();

    return deferred.Promise();
  }

  // ── updateFile(path: string) → Promise<undefined>

  Napi::Value UpdateFile(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new UpdateFileWorker(
      env, deferred, Napi::ObjectReference::New(info.This().As<Napi::Object>(), 1), info[0].As<Napi::String>().Utf8Value());
    worker->Queue();
    return deferred.Promise();
  }

  // ── static hashFilesBulk(pathsBuf, concurrency, seedLo, seedHi, mode) → Promise<Buffer>
  //    Hashes all files + computes aggregate entirely in the worker thread.
  //    mode: charcode of JS outputMode string — 'd' = DIGEST_ONLY, 'f' = FILES_ONLY, 'a' = ALL

  static Napi::Value HashFilesBulk(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto paths = info[0].As<Napi::Uint8Array>();
    int concurrency = info[1].As<Napi::Number>().Int32Value();
    uint32_t seedLo = info[2].As<Napi::Number>().Uint32Value();
    uint32_t seedHi = info[3].As<Napi::Number>().Uint32Value();
    int mode_raw = info[4].As<Napi::Number>().Int32Value();

    uint64_t seed = (static_cast<uint64_t>(seedHi) << 32) | static_cast<uint64_t>(seedLo);
    auto mode = mode_raw == 'f' ? StaticHashFilesWorker::Mode::FILES_ONLY
              : mode_raw == 'a' ? StaticHashFilesWorker::Mode::ALL
              : StaticHashFilesWorker::Mode::DIGEST_ONLY;

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new StaticHashFilesWorker(env, deferred, concurrency, seed, mode);
    worker->set_paths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->Queue();
    return deferred.Promise();
  }

 public:
  XXH3_state_t state;

 private:
  uint64_t seed_;
};

#endif
