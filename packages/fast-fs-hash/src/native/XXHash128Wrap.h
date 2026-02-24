#ifndef _FAST_FS_HASH_XXHASH128_WRAP_H
#define _FAST_FS_HASH_XXHASH128_WRAP_H

#include "InstanceHashWorker.h"
#include "UpdateFileWorker.h"
#include "HashFileWorker.h"
#include "StaticHashFilesWorker.h"

// ─── Helpers for fast N-API argument extraction ─────────────────────────
//
// The node-addon-api C++ wrappers (Napi::Buffer<T>) call
// napi_get_typedarray_info which extracts 5 fields (type, length, data,
// arraybuffer, byte_offset).  For our hot paths we only need data+length,
// so we call napi_get_buffer_info directly — it's ~30% lighter per call.
//
// We also use napi_get_value_uint32 directly (same as Napi::Number but
// without constructing intermediate Napi::Value/Number temporaries).

/** Extract data pointer + byte length from a Node.js Buffer napi_value. */
FSH_FORCE_INLINE void fast_get_buffer(napi_env env, napi_value val, const uint8_t *& data, size_t & len) {
  void * d;
  napi_get_buffer_info(env, val, &d, &len);
  data = static_cast<const uint8_t *>(d);
}

/** Extract a uint32 from a napi_value Number. */
FSH_FORCE_INLINE uint32_t fast_get_u32(napi_env env, napi_value val) {
  uint32_t v;
  napi_get_value_uint32(env, val, &v);
  return v;
}

/** Reconstruct a uint64 seed from two napi_value uint32s. */
FSH_FORCE_INLINE uint64_t fast_get_seed(napi_env env, napi_value lo_val, napi_value hi_val) {
  uint32_t lo, hi;
  napi_get_value_uint32(env, lo_val, &lo);
  napi_get_value_uint32(env, hi_val, &hi);
  return (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);
}

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
        InstanceMethod<&XXHash128Wrap::InstanceHashFile>("hashFile"),
        StaticMethod<&XXHash128Wrap::Hash>("staticHash"),
        StaticMethod<&XXHash128Wrap::HashTo>("staticHashTo"),
        StaticMethod<&XXHash128Wrap::HashFilesBulk>("staticHashFilesBulk"),
        StaticMethod<&XXHash128Wrap::HashFilesBulkTo>("staticHashFilesBulkTo"),
        StaticMethod<&XXHash128Wrap::StaticHashFile>("staticHashFile"),
      });
  }

  XXHash128Wrap(const Napi::CallbackInfo & info) : Napi::ObjectWrap<XXHash128Wrap>(info), seed_(0) {
    if (info.Length() >= 2) {
      this->seed_ = fast_get_seed(info.Env(), info[0], info[1]);
    }
    XXH3_128bits_reset_withSeed(&this->state, this->seed_);
  }

 private:
  // ─── Hot-path synchronous methods ──────────────────────────────────────

  /** update(buf, offset, length) — feed data into streaming state. */
  Napi::Value Update(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();
    const uint8_t * buf_data;
    size_t buf_len;
    fast_get_buffer(env, info[0], buf_data, buf_len);
    uint32_t offset = fast_get_u32(env, info[1]);
    uint32_t length = fast_get_u32(env, info[2]);

    if (static_cast<size_t>(offset) + length > buf_len) [[unlikely]] {
      Napi::RangeError::New(env, "update: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    XXH3_128bits_update(&this->state, buf_data + offset, length);
    return Napi::Env(env).Undefined();
  }

  /** digest() — finalize and return a new 16-byte Buffer. */
  Napi::Value Digest(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    // Allocate a 16-byte Buffer and write the canonical hash directly into it.
    // napi_create_buffer gives us the raw pointer — avoids the copy that
    // napi_create_buffer_copy would do through a temp canonical struct.
    void * result_data;
    napi_value result;
    napi_create_buffer(env, 16, &result_data, &result);
    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(result_data), XXH3_128bits_digest(&this->state));
    return Napi::Value(env, result);
  }

  /** digestTo(buf, offset) — finalize into caller-provided buffer. */
  Napi::Value DigestTo(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();
    const uint8_t * buf_data;
    size_t buf_len;
    fast_get_buffer(env, info[0], buf_data, buf_len);
    uint32_t offset = fast_get_u32(env, info[1]);

    if (static_cast<size_t>(offset) + 16 > buf_len) [[unlikely]] {
      Napi::RangeError::New(env, "digestTo: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    // Write canonical hash directly into the output buffer — no intermediate copy.
    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(const_cast<uint8_t *>(buf_data) + offset),
      XXH3_128bits_digest(&this->state));
    return Napi::Env(env).Undefined();
  }

  Napi::Value Reset(const Napi::CallbackInfo & info) {
    XXH3_128bits_reset_withSeed(&this->state, this->seed_);
    return info.Env().Undefined();
  }

  /** staticHash(buf, offset, length, seedLo, seedHi) → new 16-byte Buffer.
   *  5 args — fits in CallbackInfo's 6-slot stack buffer. */
  static Napi::Value Hash(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();
    const uint8_t * buf_data;
    size_t buf_len;
    fast_get_buffer(env, info[0], buf_data, buf_len);
    uint32_t offset = fast_get_u32(env, info[1]);
    uint32_t length = fast_get_u32(env, info[2]);

    if (static_cast<size_t>(offset) + length > buf_len) [[unlikely]] {
      Napi::RangeError::New(env, "hash: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    uint64_t seed = 0;
    if (info.Length() >= 5) {
      seed = fast_get_seed(env, info[3], info[4]);
    }

    XXH128_hash_t h = XXH3_128bits_withSeed(buf_data + offset, length, seed);

    // Allocate 16-byte Buffer and write hash directly — avoids intermediate canonical.
    void * result_data;
    napi_value result;
    napi_create_buffer(env, 16, &result_data, &result);
    XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(result_data), h);
    return Napi::Value(env, result);
  }

  /** staticHashTo(buf, length, out, outOffset, seedLo, seedHi) → void.
   *
   *  Writes the 16-byte digest into a caller-provided output buffer.
   *  The fastest possible path for small inputs:
   *  - 6 args (not 7) → fits in CallbackInfo's stack buffer (avoids heap alloc)
   *  - No Napi::Buffer::Copy → no V8 heap allocation for result
   *  - Input offset removed (always 0 from TS — toBuffer handles subviews)
   *  - Raw N-API buffer info extraction */
  static Napi::Value HashTo(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    const uint8_t * buf_data;
    size_t buf_len;
    fast_get_buffer(env, info[0], buf_data, buf_len);
    uint32_t length = fast_get_u32(env, info[1]);

    const uint8_t * out_data;
    size_t out_len;
    fast_get_buffer(env, info[2], out_data, out_len);
    uint32_t outOffset = fast_get_u32(env, info[3]);

    if (length > buf_len) [[unlikely]] {
      Napi::RangeError::New(env, "hashTo: length exceeds input buffer size").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    if (static_cast<size_t>(outOffset) + 16 > out_len) [[unlikely]] {
      Napi::RangeError::New(env, "hashTo: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    uint64_t seed = 0;
    if (info.Length() >= 6) {
      seed = fast_get_seed(env, info[4], info[5]);
    }

    XXH128_hash_t h = XXH3_128bits_withSeed(buf_data, length, seed);
    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(const_cast<uint8_t *>(out_data) + outOffset), h);
    return Napi::Env(env).Undefined();
  }

  // ─── Async file-hashing methods (I/O-bound, wrapper overhead irrelevant) ─

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
      if (err) [[unlikely]] {
        delete worker;
        Napi::RangeError::New(env, err).ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }

    worker->Queue();

    return deferred.Promise();
  }

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

  Napi::Value UpdateFile(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new UpdateFileWorker(
      env, deferred, Napi::ObjectReference::New(info.This().As<Napi::Object>(), 1), info[0].As<Napi::String>().Utf8Value());
    worker->Queue();
    return deferred.Promise();
  }

  static Napi::Value HashFilesBulk(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto paths = info[0].As<Napi::Uint8Array>();
    int concurrency = info[1].As<Napi::Number>().Int32Value();
    uint32_t seedLo = info[2].As<Napi::Number>().Uint32Value();
    uint32_t seedHi = info[3].As<Napi::Number>().Uint32Value();
    int mode_raw = info[4].As<Napi::Number>().Int32Value();

    uint64_t seed = (static_cast<uint64_t>(seedHi) << 32) | static_cast<uint64_t>(seedLo);
    auto mode = mode_raw == 'f' ? StaticHashFilesWorker::Mode::FILES_ONLY
      : mode_raw == 'a'         ? StaticHashFilesWorker::Mode::ALL
                                : StaticHashFilesWorker::Mode::DIGEST_ONLY;

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new StaticHashFilesWorker(env, deferred, concurrency, seed, mode);
    worker->set_paths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->Queue();
    return deferred.Promise();
  }

  static Napi::Value HashFilesBulkTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto paths = info[0].As<Napi::Uint8Array>();
    int concurrency = info[1].As<Napi::Number>().Int32Value();
    uint32_t seedLo = info[2].As<Napi::Number>().Uint32Value();
    uint32_t seedHi = info[3].As<Napi::Number>().Uint32Value();
    int mode_raw = info[4].As<Napi::Number>().Int32Value();
    auto output = info[5].As<Napi::Uint8Array>();
    uint32_t outputOffset = info[6].As<Napi::Number>().Uint32Value();

    uint64_t seed = (static_cast<uint64_t>(seedHi) << 32) | static_cast<uint64_t>(seedLo);
    auto mode = mode_raw == 'f' ? StaticHashFilesWorker::Mode::FILES_ONLY
      : mode_raw == 'a'         ? StaticHashFilesWorker::Mode::ALL
                                : StaticHashFilesWorker::Mode::DIGEST_ONLY;

    size_t available = output.ElementLength() - static_cast<size_t>(outputOffset);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new StaticHashFilesWorker(env, deferred, concurrency, seed, mode);
    worker->set_paths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->set_external_output(output.Data() + outputOffset, available, Napi::ObjectReference::New(output, 1));
    worker->Queue();
    return deferred.Promise();
  }

  Napi::Value InstanceHashFile(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashFileWorker(env, deferred, info[0].As<Napi::String>().Utf8Value(), this->seed_);

    if (info.Length() >= 2 && info[1].IsTypedArray()) {
      auto out = info[1].As<Napi::Uint8Array>();
      uint32_t offset = info.Length() >= 3 ? info[2].As<Napi::Number>().Uint32Value() : 0;
      if (static_cast<size_t>(offset) + 16 > out.ElementLength()) [[unlikely]] {
        delete worker;
        Napi::RangeError::New(env, "hashFile: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      worker->set_external_output(out.Data() + offset, Napi::ObjectReference::New(out, 1));
    }

    worker->Queue();
    return deferred.Promise();
  }

  static Napi::Value StaticHashFile(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    uint32_t seedLo = info.Length() >= 4 ? info[3].As<Napi::Number>().Uint32Value() : 0;
    uint32_t seedHi = info.Length() >= 5 ? info[4].As<Napi::Number>().Uint32Value() : 0;
    uint64_t seed = (static_cast<uint64_t>(seedHi) << 32) | static_cast<uint64_t>(seedLo);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashFileWorker(env, deferred, info[0].As<Napi::String>().Utf8Value(), seed);

    if (info.Length() >= 2 && info[1].IsTypedArray()) {
      auto out = info[1].As<Napi::Uint8Array>();
      uint32_t offset = info.Length() >= 3 ? info[2].As<Napi::Number>().Uint32Value() : 0;
      if (static_cast<size_t>(offset) + 16 > out.ElementLength()) [[unlikely]] {
        delete worker;
        Napi::RangeError::New(env, "hashFile: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      worker->set_external_output(out.Data() + offset, Napi::ObjectReference::New(out, 1));
    }

    if (info.Length() >= 6 && info[5].IsTypedArray()) {
      auto salt = info[5].As<Napi::Uint8Array>();
      if (salt.ElementLength() > 0) {
        worker->set_salt(salt.Data(), salt.ElementLength(), Napi::ObjectReference::New(salt, 1));
      }
    }

    worker->Queue();
    return deferred.Promise();
  }

 public:
  XXH3_state_t state;

 private:
  uint64_t seed_;
};

#endif
