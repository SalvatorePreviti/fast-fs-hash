#ifndef _FAST_FS_HASH_FILE_CACHE_BINDING_H
#define _FAST_FS_HASH_FILE_CACHE_BINDING_H

#include "CacheOpen.h"
#include "CacheWriter.h"
#include "../napi-helpers.h"

namespace fast_fs_hash {

  /**
   * cacheOpen(encodedPaths, fileCount, cachePath, rootPath, version, fingerprint, timeoutMs)
   *   → Promise<Buffer<dataBuf>>
   *
   * Acquires an exclusive lock on the cache file, then reads, validates
   * version/fingerprint/file list, and stat-matches entries.
   * Resolves with a single Buffer whose header (offset 76) holds the FfshFileHandle
   * in-memory (-1 before any disk write).
   * Runs on a dedicated detached thread so blocking on lock acquisition
   * never stalls the compute pool.
   */
  inline Napi::Value bindCacheOpen(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 7 || !info[0].IsTypedArray() || !info[2].IsString() || !info[3].IsString()) [[unlikely]] {
      auto buf = Napi::Buffer<uint8_t>::New(env, CacheHeader::SIZE);
      memset(buf.Data(), 0, CacheHeader::SIZE);
      auto * fallbackHdr = headerOf(buf.Data());
      fallbackHdr->status = static_cast<uint32_t>(CacheStatus::MISSING);
      fallbackHdr->fileHandle = FFSH_FILE_HANDLE_INVALID;
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

    int timeoutMs = -1;
    if (!info[6].IsNull() && !info[6].IsUndefined()) {
      napi_get_value_int32(env, info[6], &timeoutMs);
    }

    auto paths_ref = Napi::ObjectReference::New(pathsBuf, 1);

    auto * worker = new CacheOpen(
      env,
      deferred,
      pathsBuf.Data(),
      pathsBuf.ByteLength(),
      std::move(paths_ref),
      fileCount,
      std::move(cachePath),
      std::move(rootPath),
      version,
      fingerprint,
      timeoutMs);
    worker->Start();
    return deferred.Promise();
  }

  /**
   * cacheWrite(dataBuf, encodedPaths, fileCount, cachePath, rootPath, userData)
   *   → Promise<number>
   *
   * Hashes any unresolved entries, LZ4-compresses, and writes directly to the
   * locked cache fd (seek + write + truncate, no atomic rename).
   * The lock handle is read from dataBuf header offset 76.
   */
  inline Napi::Value bindCacheWrite(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 6 || !info[0].IsTypedArray()) [[unlikely]] {
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

    // Lock handle is read from dataBuf header at offset 76 (in-memory field, -1 on disk)
    auto * worker = new CacheWriter(
      env,
      deferred,
      dataBuf.Data(),
      dataBuf.ByteLength(),
      std::move(data_ref),
      encoded_paths,
      encoded_len,
      std::move(paths_ref),
      fileCount,
      std::move(cachePath),
      std::move(rootPath),
      std::move(ud));
    worker->Queue();
    return deferred.Promise();
  }

  /** cacheClose(handle: number) → void — handle is an int32 fd. */
  inline Napi::Value bindCacheClose(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) [[unlikely]] {
      Napi::TypeError::New(env, "cacheClose: expected number handle").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    int32_t handle = FFSH_FILE_HANDLE_INVALID;
    napi_get_value_int32(env, info[0], &handle);
    if (handle == FFSH_FILE_HANDLE_INVALID) [[unlikely]] {
      return env.Undefined();
    }
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      addon->closeHeldFileHandle(handle);
    }
    return env.Undefined();
  }

  /** cacheIsLocked(cachePath: string) → boolean */
  inline Napi::Value bindCacheIsLocked(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) [[unlikely]] {
      Napi::TypeError::New(env, "cacheIsLocked: expected (cachePath: string)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    char cachePath[FSH_MAX_PATH];
    size_t copied = 0;
    napi_get_value_string_utf8(env, info[0], cachePath, sizeof(cachePath), &copied);
    return Napi::Boolean::New(env, FfshFile::is_locked(cachePath));
  }

}  // namespace fast_fs_hash

#endif
