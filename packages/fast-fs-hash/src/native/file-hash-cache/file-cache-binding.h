#ifndef _FAST_FS_HASH_FILE_CACHE_BINDING_H
#define _FAST_FS_HASH_FILE_CACHE_BINDING_H

#include "CacheOpen.h"
#include "CacheWriter.h"
#include "CacheWriteNew.h"
#include "CacheWaitUnlocked.h"
#include "../napi-helpers.h"

namespace fast_fs_hash {

  /**
   * cacheOpen(encodedPaths, fileCount, cachePath, rootPath, version, fingerprint, lockTimeoutMs)
   *   → Promise<Buffer<dataBuf>>
   *
   * Acquires an exclusive lock on the cache file, then reads, validates
   * version/fingerprint/file list, and stat-matches entries.
   * Resolves with a single Buffer whose header (offset 76) holds the FfshFileHandle
   * in-memory (-1 before any disk write).
   * Runs on a pool thread. Lock acquisition is bounded by lockTimeoutMs.
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
    if (!info[5].IsNull() && !info[5].IsUndefined()) {
      if (!info[5].IsTypedArray() || info[5].As<Napi::Uint8Array>().ByteLength() != 16) {
        Napi::TypeError::New(env, "FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      fingerprint = info[5].As<Napi::Uint8Array>().Data();
    }

    int timeoutMs = -1;
    if (!info[6].IsNull() && !info[6].IsUndefined()) {
      napi_get_value_int32(env, info[6], &timeoutMs);
    }

    const volatile uint8_t * cancelByte = nullptr;
    Napi::ObjectReference cancelRef;
    if (info.Length() > 7 && info[7].IsTypedArray()) {
      auto cbBuf = info[7].As<Napi::Uint8Array>();
      if (cbBuf.ByteLength() >= 1) {
        cancelByte = cbBuf.Data();
        cancelRef = Napi::ObjectReference::New(cbBuf, 1);
      }
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
      timeoutMs,
      cancelByte,
      std::move(cancelRef));
    worker->Start();
    return deferred.Promise();
  }

  /**
   * cacheWrite(dataBuf, encodedPaths, fileCount, cachePath, rootPath, userData)
   *   → Promise<number>
   *
   * Hashes any unresolved entries, LZ4-compresses, and writes directly to the
   * locked cache fd (seek + write + truncate, no atomic rename).
   * The lock handle is extracted from dataBuf header (offset 76) and invalidated
   * in the buffer before queuing — this makes close()/dispose() safe during await.
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
    uint8_t * dataPtr = dataBuf.Data();
    const size_t dataLen = dataBuf.ByteLength();

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

    const volatile uint8_t * cancelByte = nullptr;
    Napi::ObjectReference cancelRef;
    if (info.Length() > 6 && info[6].IsTypedArray()) {
      auto cbBuf = info[6].As<Napi::Uint8Array>();
      if (cbBuf.ByteLength() >= 1) {
        cancelByte = cbBuf.Data();
        cancelRef = Napi::ObjectReference::New(cbBuf, 1);
      }
    }

    // Extract file handle from dataBuf header and invalidate it — close() becomes a no-op.
    // Take the FfshFile from AddonData: JS no longer owns this fd, CacheWriter does.
    auto * hdr = reinterpret_cast<CacheHeader *>(dataPtr);
    const int32_t fileHandle = hdr->getFileHandle();
    hdr->setFileHandle(FFSH_FILE_HANDLE_INVALID);
    FfshFile lockedFile;
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      lockedFile = addon->takeHeldFile(fileHandle);
    }

    auto * worker = new CacheWriter(
      env,
      deferred,
      dataPtr,
      dataLen,
      std::move(data_ref),
      encoded_paths,
      encoded_len,
      std::move(paths_ref),
      fileCount,
      std::move(cachePath),
      std::move(rootPath),
      std::move(ud),
      std::move(lockedFile),
      cancelByte,
      std::move(cancelRef));
    worker->Queue();
    return deferred.Promise();
  }

  /**
   * cacheWriteNew(encodedPaths, fileCount, cachePath, rootPath, version, fingerprint,
   *               userValue0, userValue1, userValue2, userValue3, userData, lockTimeoutMs)
   *   → Promise<number>
   *
   * Static write: acquires an exclusive lock, hashes all files, LZ4-compresses,
   * and writes a brand-new cache file without reading the old one.
   */
  inline Napi::Value bindCacheWriteNew(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 12 || !info[0].IsTypedArray() || !info[2].IsString() || !info[3].IsString()) [[unlikely]] {
      deferred.Resolve(Napi::Number::New(env, -1));
      return deferred.Promise();
    }

    auto pathsBuf = info[0].As<Napi::Uint8Array>();
    auto paths_ref = Napi::ObjectReference::New(pathsBuf, 1);

    uint32_t fileCount = 0;
    napi_get_value_uint32(env, info[1], &fileCount);

    std::string cachePath = info[2].As<Napi::String>().Utf8Value();
    std::string rootPath = info[3].As<Napi::String>().Utf8Value();

    uint32_t version = 0;
    napi_get_value_uint32(env, info[4], &version);

    const uint8_t * fingerprint = nullptr;
    if (!info[5].IsNull() && !info[5].IsUndefined()) {
      if (!info[5].IsTypedArray() || info[5].As<Napi::Uint8Array>().ByteLength() != 16) {
        Napi::TypeError::New(env, "FileHashCache: fingerprint must be a Uint8Array of exactly 16 bytes")
          .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      fingerprint = info[5].As<Napi::Uint8Array>().Data();
    }

    double uv0 = 0, uv1 = 0, uv2 = 0, uv3 = 0;
    napi_get_value_double(env, info[6], &uv0);
    napi_get_value_double(env, info[7], &uv1);
    napi_get_value_double(env, info[8], &uv2);
    napi_get_value_double(env, info[9], &uv3);

    ParsedUserData ud(info, 10);
    if (ud.has_error) {
      return env.Undefined();
    }

    int timeoutMs = -1;
    if (!info[11].IsNull() && !info[11].IsUndefined()) {
      napi_get_value_int32(env, info[11], &timeoutMs);
    }

    const volatile uint8_t * cancelByte = nullptr;
    Napi::ObjectReference cancelRef;
    if (info.Length() > 12 && info[12].IsTypedArray()) {
      auto cbBuf = info[12].As<Napi::Uint8Array>();
      if (cbBuf.ByteLength() >= 1) {
        cancelByte = cbBuf.Data();
        cancelRef = Napi::ObjectReference::New(cbBuf, 1);
      }
    }

    auto * worker = new CacheWriteNew(
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
      uv0, uv1, uv2, uv3,
      std::move(ud),
      timeoutMs,
      cancelByte,
      std::move(cancelRef));
    worker->Start();
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
      addon->closeHeldFile(handle);
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

  inline Napi::Value bindCacheWaitUnlocked(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 1 || !info[0].IsString()) [[unlikely]] {
      Napi::TypeError::New(env, "cacheWaitUnlocked: expected (cachePath: string)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::string cachePath = info[0].As<Napi::String>().Utf8Value();

    int timeoutMs = -1;
    if (info.Length() >= 2 && !info[1].IsNull() && !info[1].IsUndefined()) {
      napi_get_value_int32(env, info[1], &timeoutMs);
    }

    const volatile uint8_t * cancelByte = nullptr;
    Napi::ObjectReference cancelRef;
    if (info.Length() > 2 && info[2].IsTypedArray()) {
      auto cbBuf = info[2].As<Napi::Uint8Array>();
      if (cbBuf.ByteLength() >= 1) {
        cancelByte = cbBuf.Data();
        cancelRef = Napi::ObjectReference::New(cbBuf, 1);
      }
    }

    auto * worker = new CacheWaitUnlocked(env, deferred, std::move(cachePath), timeoutMs, cancelByte, std::move(cancelRef));
    worker->Queue();
    return deferred.Promise();
  }

  /**
   * cacheFireCancel(cancelBuf: Uint8Array) → void
   *
   * Called from JS when an AbortSignal fires. Finds the active LockCancel
   * whose cancelByte_ points into the given buffer and calls fire() on it,
   * which triggers CancelIoEx (Windows) or sets fired_ (POSIX, checked by poll_lock_).
   */
  inline Napi::Value bindCacheFireCancel(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) [[unlikely]] {
      return env.Undefined();
    }
    auto cbBuf = info[0].As<Napi::Uint8Array>();
    if (cbBuf.ByteLength() < 1) [[unlikely]] {
      return env.Undefined();
    }
    volatile uint8_t * cancelByte = cbBuf.Data();
    // Write the byte so is_fired() returns true even if the cancel
    // has not yet been registered (race: signal fires before worker starts).
    *cancelByte = 1;
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      addon->active_cancels.fire_by_cancel_byte(cancelByte);
    }
    return env.Undefined();
  }

}  // namespace fast_fs_hash

#endif
