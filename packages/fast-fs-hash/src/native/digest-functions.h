#ifndef _FAST_FS_HASH_DIGEST_FUNCTIONS_H
#define _FAST_FS_HASH_DIGEST_FUNCTIONS_H

#include "napi-helpers.h"
#include "StaticHashFilesWorker.h"
#include "HashSequentialWorker.h"
#include "HashFileWorker.h"

/**
 * xxHash128 standalone digest functions.
 *
 * All functions are stateless — they hash input and write the 16-byte digest
 * to a caller-provided output buffer. No class, no instances.
 *
 * Seed is always 0. outOffset is optional (defaults to 0 if omitted).
 *
 * File-hashing functions (encodedPathsDigestFilesParallelTo, digestFileTo) are async (Promise).
 */
namespace digest_functions {

  /**
   * Check that outOffset + 16 fits in out_len. If not, throw RangeError and return false.
   */
  static FSH_FORCE_INLINE bool checkOutputBounds(napi_env env, size_t outOffset, size_t out_len, const char * func_name) {
    if (outOffset > out_len || out_len - outOffset < 16) [[unlikely]] {
      char msg[128];
      snprintf(msg, sizeof(msg), "%s: outOffset + 16 exceeds output buffer size", func_name);
      Napi::RangeError::New(env, msg).ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }

  /** digestBufferTo(buf, out, outOffset?) → out */
  static Napi::Value digestBufferTo(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    size_t buf_len = 0;
    void * buf_ptr = nullptr;
    napi_get_typedarray_info(env, info[0], nullptr, &buf_len, &buf_ptr, nullptr, nullptr);

    size_t out_len = 0;
    void * out_ptr = nullptr;
    napi_get_typedarray_info(env, info[1], nullptr, &out_len, &out_ptr, nullptr, nullptr);

    uint32_t outOffset = 0;
    if (info.Length() > 2) {
      napi_get_value_uint32(env, info[2], &outOffset);
    }

    if (!checkOutputBounds(env, outOffset, out_len, "digestBufferTo")) return Napi::Value(env, nullptr);

    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(static_cast<uint8_t *>(out_ptr) + outOffset), XXH3_128bits(buf_ptr, buf_len));
    return info[1];
  }

  /** digestBufferRangeTo(buf, offset, length, out, outOffset?) → out */
  static Napi::Value digestBufferRangeTo(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    size_t buf_len = 0;
    void * buf_ptr = nullptr;
    napi_get_typedarray_info(env, info[0], nullptr, &buf_len, &buf_ptr, nullptr, nullptr);

    uint32_t offset = 0;
    napi_get_value_uint32(env, info[1], &offset);
    uint32_t length = 0;
    napi_get_value_uint32(env, info[2], &length);

    size_t out_len = 0;
    void * out_ptr = nullptr;
    napi_get_typedarray_info(env, info[3], nullptr, &out_len, &out_ptr, nullptr, nullptr);

    uint32_t outOffset = 0;
    if (info.Length() > 4) {
      napi_get_value_uint32(env, info[4], &outOffset);
    }

    if (static_cast<size_t>(offset) + length > buf_len) [[unlikely]] {
      Napi::RangeError::New(env, "digestBufferRangeTo: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    if (!checkOutputBounds(env, outOffset, out_len, "digestBufferRangeTo")) return Napi::Value(env, nullptr);
    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(static_cast<uint8_t *>(out_ptr) + outOffset),
      XXH3_128bits(static_cast<const uint8_t *>(buf_ptr) + offset, length));
    return info[3];
  }

  /** digestStringTo(str, out, outOffset?) → out */
  static Napi::Value digestStringTo(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    size_t out_len = 0;
    void * out_ptr = nullptr;
    napi_get_typedarray_info(env, info[1], nullptr, &out_len, &out_ptr, nullptr, nullptr);

    uint32_t outOffset = 0;
    if (info.Length() > 2) {
      napi_get_value_uint32(env, info[2], &outOffset);
    }

    if (!checkOutputBounds(env, outOffset, out_len, "digestStringTo")) return Napi::Value(env, nullptr);

    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(static_cast<uint8_t *>(out_ptr) + outOffset),
      fast_hash_string(env, info[0], 0));
    return info[1];
  }

  /** digestFileTo(path, out, outOffset?, throwOnError?) → Promise<out> */
  static Napi::Value digestFileTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto out = info[1].As<Napi::Uint8Array>();

    uint32_t outOffset = 0;
    if (info.Length() > 2) {
      napi_get_value_uint32(env, info[2], &outOffset);
    }

    bool throw_on_error = true;
    if (info.Length() > 3) {
      napi_get_value_bool(env, info[3], &throw_on_error);
    }

    if (!checkOutputBounds(env, outOffset, out.ElementLength(), "digestFileTo")) return Napi::Value(env, nullptr);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashFileWorker(env, deferred, info[0].As<Napi::String>().Utf8Value(), throw_on_error);
    worker->setExternalOutput(out.Data() + outOffset, Napi::ObjectReference::New(out, 1));
    worker->Queue();
    return deferred.Promise();
  }

  /** encodedPathsDigestFilesParallelTo(pathsBuf, concurrency, output, outputOffset?, throwOnError?) → Promise */
  static Napi::Value encodedPathsDigestFilesParallelTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto paths = info[0].As<Napi::Uint8Array>();
    int concurrency = info[1].As<Napi::Number>().Int32Value();
    auto output = info[2].As<Napi::Uint8Array>();

    uint32_t outputOffset = 0;
    if (info.Length() > 3) {
      napi_get_value_uint32(env, info[3], &outputOffset);
    }

    bool throw_on_error = true;
    if (info.Length() > 4) {
      napi_get_value_bool(env, info[4], &throw_on_error);
    }

    if (static_cast<size_t>(outputOffset) > output.ElementLength()) [[unlikely]] {
      Napi::RangeError::New(env, "encodedPathsDigestFilesParallelTo: outputOffset exceeds output buffer size")
        .ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    size_t available = output.ElementLength() - static_cast<size_t>(outputOffset);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new StaticHashFilesWorker(env, deferred, concurrency, throw_on_error);
    worker->setPaths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->setExternalOutput(output.Data() + outputOffset, available, Napi::ObjectReference::New(output, 1));
    worker->Queue();
    return deferred.Promise();
  }

  /** encodedPathsDigestFilesSequentialTo(pathsBuf, output, outputOffset?, throwOnError?) → Promise<output> */
  static Napi::Value encodedPathsDigestFilesSequentialTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto paths = info[0].As<Napi::Uint8Array>();
    auto output = info[1].As<Napi::Uint8Array>();

    uint32_t outputOffset = 0;
    if (info.Length() > 2) {
      napi_get_value_uint32(env, info[2], &outputOffset);
    }

    bool throw_on_error = true;
    if (info.Length() > 3) {
      napi_get_value_bool(env, info[3], &throw_on_error);
    }

    if (static_cast<size_t>(outputOffset) > output.ElementLength()) [[unlikely]] {
      Napi::RangeError::New(env, "encodedPathsDigestFilesSequentialTo: outputOffset exceeds output buffer size")
        .ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    size_t available = output.ElementLength() - static_cast<size_t>(outputOffset);

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashSequentialWorker(env, deferred, throw_on_error);
    worker->setPaths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->setExternalOutput(output.Data() + outputOffset, available, Napi::ObjectReference::New(output, 1));
    worker->Queue();
    return deferred.Promise();
  }

}  // namespace digest_functions

#endif
