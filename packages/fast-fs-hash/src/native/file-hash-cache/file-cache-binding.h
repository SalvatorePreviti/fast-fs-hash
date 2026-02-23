#ifndef _FAST_FS_HASH_FILE_CACHE_BINDING_H
#define _FAST_FS_HASH_FILE_CACHE_BINDING_H

#include "CacheOpen.h"
#include "CacheWriter.h"

namespace fast_fs_hash {

  inline Napi::Value bindCacheOpen(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 6 || !info[0].IsTypedArray() || !info[2].IsString() || !info[3].IsString()) {
      auto buf = Napi::Buffer<uint8_t>::New(env, CacheHeader::SIZE);
      memset(buf.Data(), 0, CacheHeader::SIZE);
      auto * hdr = headerOf(buf.Data());
      hdr->status = static_cast<uint32_t>(CacheStatus::MISSING);
      deferred.Resolve(buf);
      return deferred.Promise();
    }

    auto pathsBuf = info[0].As<Napi::Uint8Array>();

    uint32_t fileCount = 0;
    napi_get_value_uint32(env, info[1], &fileCount);

    std::string cachePath = info[2].As<Napi::String>().Utf8Value();
    std::string rootPath = info[3].As<Napi::String>().Utf8Value();

    uint32_t version = 0;
    napi_get_value_uint32(env, info[4], &version);

    const uint8_t * fingerprint = nullptr;
    if (!info[5].IsNull() && !info[5].IsUndefined() && info[5].IsTypedArray()) {
      auto fp = info[5].As<Napi::Uint8Array>();
      if (fp.ByteLength() >= 16) {
        fingerprint = fp.Data();
      }
    }

    auto paths_ref = Napi::ObjectReference::New(pathsBuf, 1);

    auto * worker = new CacheOpen(
      env, deferred,
      pathsBuf.Data(), pathsBuf.ByteLength(), std::move(paths_ref),
      fileCount, std::move(cachePath), std::move(rootPath),
      version, fingerprint);
    worker->Queue();
    return deferred.Promise();
  }

  inline Napi::Value bindCacheWrite(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 6 || !info[0].IsTypedArray()) {
      deferred.Resolve(Napi::Number::New(env, -1));
      return deferred.Promise();
    }

    auto dataBuf = info[0].As<Napi::Uint8Array>();
    auto data_ref = Napi::ObjectReference::New(dataBuf, 1);

    const uint8_t * encoded_paths = nullptr;
    size_t encoded_len = 0;
    Napi::ObjectReference paths_ref;
    if (!info[1].IsNull() && !info[1].IsUndefined() && info[1].IsTypedArray()) {
      auto pathsBuf = info[1].As<Napi::Uint8Array>();
      encoded_paths = pathsBuf.Data();
      encoded_len = pathsBuf.ByteLength();
      paths_ref = Napi::ObjectReference::New(pathsBuf, 1);
    }

    uint32_t fileCount = 0;
    napi_get_value_uint32(env, info[2], &fileCount);

    std::string cachePath = info[3].IsString() ? info[3].As<Napi::String>().Utf8Value() : std::string();
    std::string rootPath = info[4].IsString() ? info[4].As<Napi::String>().Utf8Value() : std::string();

    ParsedUserData ud(info, 5);
    if (ud.has_error) {
      return env.Undefined();
    }

    auto * worker = new CacheWriter(
      env, deferred,
      dataBuf.Data(), dataBuf.ByteLength(), std::move(data_ref),
      encoded_paths, encoded_len, std::move(paths_ref),
      fileCount, std::move(cachePath), std::move(rootPath),
      std::move(ud));
    worker->Queue();
    return deferred.Promise();
  }

}  // namespace fast_fs_hash

#endif
