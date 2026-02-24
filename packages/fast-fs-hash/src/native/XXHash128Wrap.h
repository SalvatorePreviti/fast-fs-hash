#ifndef _FAST_FS_HASH_XXHASH128_WRAP_H
#define _FAST_FS_HASH_XXHASH128_WRAP_H

#include "InstanceHashWorker.h"
#include "UpdateFileWorker.h"
#include "HashFileWorker.h"
#include "HashFileHandleWorker.h"
#include "StaticHashFilesWorker.h"

#ifdef _WIN32
#include <io.h>
#endif

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
        InstanceMethod<&XXHash128Wrap::InstanceHashFileHandle>("hashFileHandle"),
        StaticMethod<&XXHash128Wrap::Hash>("staticHash"),
        StaticMethod<&XXHash128Wrap::HashFilesBulk>("staticHashFilesBulk"),
        StaticMethod<&XXHash128Wrap::HashFilesBulkTo>("staticHashFilesBulkTo"),
        StaticMethod<&XXHash128Wrap::StaticHashFile>("staticHashFile"),
        StaticMethod<&XXHash128Wrap::StaticHashFileHandle>("staticHashFileHandle"),
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
  Napi::Value Update(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();
    uint32_t length = info[2].As<Napi::Number>().Uint32Value();

    if (static_cast<size_t>(offset) + length > buf.Length()) [[unlikely]] {
      Napi::RangeError::New(env, "update: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    XXH3_128bits_update(&this->state, buf.Data() + offset, length);
    return env.Undefined();
  }

  Napi::Value Digest(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, XXH3_128bits_digest(&this->state));
    return Napi::Buffer<uint8_t>::Copy(env, canonical.digest, 16);
  }

  Napi::Value DigestTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();

    if (static_cast<size_t>(offset) + 16 > buf.Length()) [[unlikely]] {
      Napi::RangeError::New(env, "digestTo: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    XXH128_canonical_t canonical;
    XXH128_canonicalFromHash(&canonical, XXH3_128bits_digest(&this->state));
    memcpy(buf.Data() + offset, canonical.digest, 16);
    return env.Undefined();
  }

  Napi::Value Reset(const Napi::CallbackInfo & info) {
    XXH3_128bits_reset_withSeed(&this->state, this->seed_);
    return info.Env().Undefined();
  }

  static Napi::Value Hash(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto buf = info[0].As<Napi::Buffer<uint8_t>>();
    uint32_t offset = info[1].As<Napi::Number>().Uint32Value();
    uint32_t length = info[2].As<Napi::Number>().Uint32Value();

    if (static_cast<size_t>(offset) + length > buf.Length()) [[unlikely]] {
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

  Napi::Value InstanceHashFileHandle(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    int fd_int = info[0].As<Napi::Number>().Int32Value();

#ifndef _WIN32
    auto fd = static_cast<HashFileHandleWorker::NativeFd>(fd_int);
#else
    // On Windows, Node.js exposes CRT file descriptors.  Convert to Win32 HANDLE.
    auto fd = reinterpret_cast<HANDLE>(_get_osfhandle(fd_int));
#endif

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashFileHandleWorker(env, deferred, fd, this->seed_);

    // Hold the JS FileHandle alive to prevent GC from closing the fd.
    if (info.Length() >= 4 && info[3].IsObject()) {
      worker->set_fh_ref(Napi::ObjectReference::New(info[3].As<Napi::Object>(), 1));
    }

    if (info.Length() >= 2 && info[1].IsTypedArray()) {
      auto out = info[1].As<Napi::Uint8Array>();
      uint32_t offset = info.Length() >= 3 ? info[2].As<Napi::Number>().Uint32Value() : 0;
      if (static_cast<size_t>(offset) + 16 > out.ElementLength()) [[unlikely]] {
        delete worker;
        Napi::RangeError::New(env, "hashFileHandle: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      worker->set_external_output(out.Data() + offset, Napi::ObjectReference::New(out, 1));
    }

    worker->Queue();
    return deferred.Promise();
  }

  static Napi::Value StaticHashFileHandle(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    int fd_int = info[0].As<Napi::Number>().Int32Value();

#ifndef _WIN32
    auto fd = static_cast<HashFileHandleWorker::NativeFd>(fd_int);
#else
    auto fd = reinterpret_cast<HANDLE>(_get_osfhandle(fd_int));
#endif

    uint32_t seedLo = info.Length() >= 4 ? info[3].As<Napi::Number>().Uint32Value() : 0;
    uint32_t seedHi = info.Length() >= 5 ? info[4].As<Napi::Number>().Uint32Value() : 0;
    uint64_t seed = (static_cast<uint64_t>(seedHi) << 32) | static_cast<uint64_t>(seedLo);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashFileHandleWorker(env, deferred, fd, seed);

    // Hold the JS FileHandle alive to prevent GC from closing the fd.
    if (info.Length() >= 6 && info[5].IsObject()) {
      worker->set_fh_ref(Napi::ObjectReference::New(info[5].As<Napi::Object>(), 1));
    }

    if (info.Length() >= 2 && info[1].IsTypedArray()) {
      auto out = info[1].As<Napi::Uint8Array>();
      uint32_t offset = info.Length() >= 3 ? info[2].As<Napi::Number>().Uint32Value() : 0;
      if (static_cast<size_t>(offset) + 16 > out.ElementLength()) [[unlikely]] {
        delete worker;
        Napi::RangeError::New(env, "hashFileHandle: output buffer too small (need 16 bytes)").ThrowAsJavaScriptException();
        return env.Undefined();
      }
      worker->set_external_output(out.Data() + offset, Napi::ObjectReference::New(out, 1));
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
