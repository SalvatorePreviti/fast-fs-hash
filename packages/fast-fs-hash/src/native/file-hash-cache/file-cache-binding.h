#ifndef _FAST_FS_HASH_FILE_CACHE_BINDING_H
#define _FAST_FS_HASH_FILE_CACHE_BINDING_H

#include "CacheOpen.h"
#include "CacheWriter.h"
#include "../napi-helpers.h"

namespace fast_fs_hash {

  /**
   * cacheOpen(encodedPaths, fileCount, cachePath, rootPath, version, fingerprint, timeoutMs)
   *   → Promise<[BigInt<lockHandle>, Buffer<dataBuf>]>
   *
   * Acquires an exclusive lock on the cache file, then reads, validates
   * version/fingerprint/file list, and stat-matches entries.
   * The resolved array index 0 is a BigInt encoding the CacheLockHandle.
   * Index 1 is the dataBuf containing the cache state.
   * Runs on a dedicated detached thread so blocking on lock acquisition
   * never stalls the compute pool.
   */
  inline Napi::Value bindCacheOpen(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 7 || !info[0].IsTypedArray() || !info[2].IsString() || !info[3].IsString()) [[unlikely]] {
      auto buf = Napi::Buffer<uint8_t>::New(env, CacheHeader::SIZE);
      memset(buf.Data(), 0, CacheHeader::SIZE);
      headerOf(buf.Data())->status = static_cast<uint32_t>(CacheStatus::MISSING);
      auto arr = Napi::Array::New(env, 2);
      arr.Set(0u, Napi::BigInt::New(env, static_cast<uint64_t>(0)));
      arr.Set(1u, buf);
      deferred.Resolve(arr);
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
   * cacheWrite(dataBuf, encodedPaths, fileCount, cachePath, rootPath, userData, lockHandle)
   *   → Promise<number>
   *
   * Hashes any unresolved entries, LZ4-compresses, and writes directly to the
   * locked cache fd (seek + write + truncate, no atomic rename).
   */
  inline Napi::Value bindCacheWrite(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 7 || !info[0].IsTypedArray()) [[unlikely]] {
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

    // Lock handle (BigInt) — required for writing to the locked fd
    CacheLockHandle lockHandle = CACHE_LOCK_INVALID;
    if (info.Length() > 6 && info[6].IsBigInt()) {
      bool lossless = false;
      lockHandle = info[6].As<Napi::BigInt>().Uint64Value(&lossless);
      if (!lossless) [[unlikely]] {
        lockHandle = CACHE_LOCK_INVALID;
      }
    }

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
      std::move(ud),
      lockHandle);
    worker->Queue();
    return deferred.Promise();
  }

  /** cacheLockRelease(handleBigInt: bigint) → void */
  inline Napi::Value bindCacheLockRelease(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsBigInt()) [[unlikely]] {
      Napi::TypeError::New(env, "cacheLockRelease: expected BigInt handle").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    bool lossless = false;
    const CacheLockHandle handle = info[0].As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless || handle == CACHE_LOCK_INVALID) [[unlikely]] {
      return env.Undefined();
    }
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      addon->unregisterHeldCacheLock(handle);
    }
    FfshFile::release_lock_handle(handle);
    return env.Undefined();
  }

  /** cacheLockIsLocked(cachePath: string) → boolean */
  inline Napi::Value bindCacheLockIsLocked(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) [[unlikely]] {
      Napi::TypeError::New(env, "cacheLockIsLocked: expected (cachePath: string)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    char cachePath[FSH_MAX_PATH];
    size_t copied = 0;
    napi_get_value_string_utf8(env, info[0], cachePath, sizeof(cachePath), &copied);
    return Napi::Boolean::New(env, FfshFile::is_locked(cachePath));
  }

}  // namespace fast_fs_hash

#endif
