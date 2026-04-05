#ifndef _FAST_FS_HASH_FILE_CACHE_BINDING_H
#define _FAST_FS_HASH_FILE_CACHE_BINDING_H

#include "CacheOpen.h"
#include "CacheWriter.h"
#include "CacheWriteNew.h"
#include "CacheWaitUnlocked.h"
#include "../napi-helpers.h"

namespace fast_fs_hash {

  // ── Helper: parse stateBuf from arg[0] ──────────────────────────────

  inline CacheStateBuf * parseStateBuf(const Napi::CallbackInfo & info, Napi::ObjectReference & outRef) {
    if (info.Length() < 1 || !info[0].IsTypedArray()) [[unlikely]] {
      return nullptr;
    }
    auto buf = info[0].As<Napi::Uint8Array>();
    if (buf.ByteLength() < CacheStateBuf::HEADER_SIZE) [[unlikely]] {
      return nullptr;
    }
    outRef = Napi::ObjectReference::New(buf, 1);
    return stateOf(buf.Data());
  }

  /**
   * cacheOpen(stateBuf, encodedPaths, rootPath, dirtyBuf?, dirtyCount?)
   *   → Promise<Buffer<dataBuf>>
   *
   * Reads version, fingerprint, lockTimeoutMs, fileCount, cachePath from stateBuf.
   * Writes status, fileHandle, cacheFileStat0/1 to stateBuf on completion.
   */
  inline Napi::Value bindCacheOpen(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    Napi::ObjectReference stateRef;
    CacheStateBuf * state = parseStateBuf(info, stateRef);

    if (!state || info.Length() < 3 || !info[1].IsTypedArray() || !info[2].IsString()) [[unlikely]] {
      auto buf = Napi::Buffer<uint8_t>::New(env, CacheHeader::SIZE);
      memset(buf.Data(), 0, CacheHeader::SIZE);
      if (state) {
        state->status = static_cast<uint32_t>(CacheStatus::MISSING);
        state->fileHandle = FFSH_FILE_HANDLE_INVALID;
      }
      deferred.Resolve(buf);
      return deferred.Promise();
    }

    auto pathsBuf = info[1].As<Napi::Uint8Array>();
    std::string rootPath = info[2].As<Napi::String>().Utf8Value();

    // Read config from stateBuf (JS thread — safe)
    const uint32_t version = state->version;
    const uint8_t * fingerprint = state->hasFingerprint() ? state->fingerprint.bytes : nullptr;
    const int timeoutMs = state->lockTimeoutMs;
    const uint32_t fileCount = state->fileCount;
    const char * cachePath = state->cachePath();

    // Optional dirty paths buffer (arg 3) and dirty count (arg 4)
    const uint8_t * dirtyPaths = nullptr;
    size_t dirtyLen = 0;
    uint32_t dirtyCount = 0;
    bool hasDirtyHint = false;
    Napi::ObjectReference dirtyRef;
    if (info.Length() > 3 && !info[3].IsNull() && !info[3].IsUndefined() && info[3].IsTypedArray()) {
      auto dirtyBuf = info[3].As<Napi::Uint8Array>();
      dirtyPaths = dirtyBuf.Data();
      dirtyLen = dirtyBuf.ByteLength();
      hasDirtyHint = true;
      dirtyRef = Napi::ObjectReference::New(dirtyBuf, 1);
      if (info.Length() > 4) {
        napi_get_value_uint32(env, info[4], &dirtyCount);
      }
    }

    auto paths_ref = Napi::ObjectReference::New(pathsBuf, 1);

    auto * worker = new CacheOpen(
      env, deferred, state, std::move(stateRef),
      pathsBuf.Data(), pathsBuf.ByteLength(), std::move(paths_ref),
      fileCount, cachePath, std::move(rootPath),
      version, fingerprint, timeoutMs,
      dirtyPaths, dirtyLen, dirtyCount, hasDirtyHint, std::move(dirtyRef));
    worker->Start();
    return deferred.Promise();
  }

  /**
   * cacheWrite(stateBuf, dataBuf, encodedPaths, rootPath, userData)
   *   → Promise<number>
   *
   * Reads fileHandle, fileCount, cachePath from stateBuf.
   * Writes cacheFileStat0/1 to stateBuf on success.
   */
  inline Napi::Value bindCacheWrite(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    Napi::ObjectReference stateRef;
    CacheStateBuf * state = parseStateBuf(info, stateRef);

    if (!state || info.Length() < 5 || !info[1].IsTypedArray()) [[unlikely]] {
      deferred.Resolve(Napi::Number::New(env, -1));
      return deferred.Promise();
    }

    auto dataBuf = info[1].As<Napi::Uint8Array>();
    auto data_ref = Napi::ObjectReference::New(dataBuf, 1);
    uint8_t * dataPtr = dataBuf.Data();
    const size_t dataLen = dataBuf.ByteLength();

    const uint8_t * encoded_paths = nullptr;
    size_t encoded_len = 0;
    Napi::ObjectReference paths_ref;
    if (!info[2].IsNull() && !info[2].IsUndefined() && info[2].IsTypedArray()) {
      auto pathsBuf = info[2].As<Napi::Uint8Array>();
      encoded_paths = pathsBuf.Data();
      encoded_len = pathsBuf.ByteLength();
      paths_ref = Napi::ObjectReference::New(pathsBuf, 1);
    }

    std::string rootPath = info[3].IsString() ? info[3].As<Napi::String>().Utf8Value() : std::string();

    ParsedUserData ud(info, 4);
    if (ud.has_error) {
      return env.Undefined();
    }

    const uint32_t fileCount = state->fileCount;

    // Extract file handle from stateBuf and invalidate it
    const int32_t fileHandle = state->fileHandle;
    state->fileHandle = FFSH_FILE_HANDLE_INVALID;
    FfshFile lockedFile;
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      lockedFile = addon->takeHeldFile(fileHandle);
    }

    auto * worker = new CacheWriter(
      env, deferred, state, std::move(stateRef),
      dataPtr, dataLen, std::move(data_ref),
      encoded_paths, encoded_len, std::move(paths_ref),
      fileCount, std::move(rootPath),
      std::move(ud), std::move(lockedFile));
    worker->Queue();
    return deferred.Promise();
  }

  /**
   * cacheWriteNew(stateBuf, encodedPaths, rootPath, userData)
   *   → Promise<number>
   *
   * Reads version, fingerprint, lockTimeoutMs, fileCount, userValue0-3, cachePath from stateBuf.
   * Writes cacheFileStat0/1 to stateBuf on success.
   */
  inline Napi::Value bindCacheWriteNew(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    Napi::ObjectReference stateRef;
    CacheStateBuf * state = parseStateBuf(info, stateRef);

    if (!state || info.Length() < 4 || !info[1].IsTypedArray() || !info[2].IsString()) [[unlikely]] {
      deferred.Resolve(Napi::Number::New(env, -1));
      return deferred.Promise();
    }

    auto pathsBuf = info[1].As<Napi::Uint8Array>();
    auto paths_ref = Napi::ObjectReference::New(pathsBuf, 1);
    std::string rootPath = info[2].As<Napi::String>().Utf8Value();

    ParsedUserData ud(info, 3);
    if (ud.has_error) {
      return env.Undefined();
    }

    // Read all config from stateBuf
    const uint32_t fileCount = state->fileCount;
    const uint32_t version = state->version;
    const uint8_t * fingerprint = state->hasFingerprint() ? state->fingerprint.bytes : nullptr;
    const int timeoutMs = state->lockTimeoutMs;
    const char * cachePath = state->cachePath();

    auto * worker = new CacheWriteNew(
      env, deferred, state, std::move(stateRef),
      pathsBuf.Data(), pathsBuf.ByteLength(), std::move(paths_ref),
      fileCount, cachePath, std::move(rootPath),
      version, fingerprint,
      state->userValue0, state->userValue1, state->userValue2, state->userValue3,
      std::move(ud), timeoutMs);
    worker->Start();
    return deferred.Promise();
  }

  /**
   * cacheClose(stateBuf) → boolean
   *
   * Reads fileHandle from stateBuf, writes -1, closes the fd. Returns true if closed.
   */
  inline Napi::Value bindCacheClose(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) [[unlikely]] {
      return Napi::Boolean::New(env, false);
    }
    auto buf = info[0].As<Napi::Uint8Array>();
    if (buf.ByteLength() < CacheStateBuf::HEADER_SIZE) [[unlikely]] {
      return Napi::Boolean::New(env, false);
    }
    auto * state = stateOf(buf.Data());
    const int32_t handle = state->fileHandle;
    if (handle == FFSH_FILE_HANDLE_INVALID) [[unlikely]] {
      return Napi::Boolean::New(env, false);
    }
    state->fileHandle = FFSH_FILE_HANDLE_INVALID;
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      addon->closeHeldFile(handle);
    }
    return Napi::Boolean::New(env, true);
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

  /**
   * cacheWaitUnlocked(stateBuf, lockTimeoutMs) → Promise<boolean>
   *
   * Reads cachePath and cancelFlag from stateBuf.
   */
  inline Napi::Value bindCacheWaitUnlocked(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    Napi::ObjectReference stateRef;
    CacheStateBuf * state = parseStateBuf(info, stateRef);

    if (!state) [[unlikely]] {
      deferred.Resolve(Napi::Boolean::New(env, false));
      return deferred.Promise();
    }

    int timeoutMs = -1;
    if (info.Length() >= 2 && !info[1].IsNull() && !info[1].IsUndefined()) {
      napi_get_value_int32(env, info[1], &timeoutMs);
    }

    auto * worker = new CacheWaitUnlocked(
      env, deferred, state->cachePath(), timeoutMs,
      state->cancelByte(), std::move(stateRef));
    worker->Queue();
    return deferred.Promise();
  }

  /**
   * cacheStatHash(stateBuf) → boolean
   *
   * Reads cachePath from stateBuf, stats the file, hashes stat fields,
   * compares with cacheFileStat0/1 from stateBuf.
   * Returns true if different (cache file changed) or on error.
   */
  inline Napi::Value bindCacheStatHash(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) [[unlikely]] {
      return Napi::Boolean::New(env, true);
    }
    auto buf = info[0].As<Napi::Uint8Array>();
    if (buf.ByteLength() < CacheStateBuf::HEADER_SIZE) [[unlikely]] {
      return Napi::Boolean::New(env, true);
    }
    const auto * state = stateOf(buf.Data());

    const int fd = FfshFile::open_rd(state->cachePath());
    if (fd < 0) [[unlikely]] {
      return Napi::Boolean::New(env, true);
    }

    CacheEntry tmp{};
    const bool statOk = FfshFile::fstat_into(fd, tmp);
    FfshFile::close_fd(fd);
    if (!statOk) [[unlikely]] {
      return Napi::Boolean::New(env, true);
    }

    uint64_t fields[4] = {tmp.ino & INO_VALUE_MASK, tmp.ctimeNs, tmp.mtimeNs, tmp.size};
    Hash128 h;
    h.from_xxh128(XXH3_128bits(fields, sizeof(fields)));
    double newStat0, newStat1;
    memcpy(&newStat0, &h.bytes[0], 8);
    memcpy(&newStat1, &h.bytes[8], 8);

    return Napi::Boolean::New(env, newStat0 != state->cacheFileStat0 || newStat1 != state->cacheFileStat1);
  }

  /**
   * cacheFileStatGet(stateBuf) → void
   *
   * Reads cachePath from stateBuf, stats the cache file, writes stat hash to stateBuf.
   * On error, writes [0, 0].
   */
  inline Napi::Value bindCacheFileStatGet(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) [[unlikely]] {
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Uint8Array>();
    if (buf.ByteLength() < CacheStateBuf::HEADER_SIZE) [[unlikely]] {
      return env.Undefined();
    }
    auto * state = stateOf(buf.Data());

    const int fd = FfshFile::open_rd(state->cachePath());
    if (fd < 0) [[unlikely]] {
      state->cacheFileStat0 = 0;
      state->cacheFileStat1 = 0;
      return env.Undefined();
    }

    stampCacheFileStat(&state->cacheFileStat0, fd);
    FfshFile::close_fd(fd);
    return env.Undefined();
  }

  /**
   * cacheFireCancel(stateBuf) → void
   *
   * Called from JS when an AbortSignal fires. Writes 1 to cancelFlag,
   * then finds the active LockCancel whose cancelByte_ points to
   * &state->cancelFlag and calls fire() (CancelIoEx on Windows).
   */
  inline Napi::Value bindCacheFireCancel(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsTypedArray()) [[unlikely]] {
      return env.Undefined();
    }
    auto buf = info[0].As<Napi::Uint8Array>();
    if (buf.ByteLength() < CacheStateBuf::HEADER_SIZE) [[unlikely]] {
      return env.Undefined();
    }
    auto * state = stateOf(buf.Data());
    state->cancelFlag = 1;
    auto * addon = AddonData::get(env);
    if (addon) [[likely]] {
      addon->active_cancels.fire_by_cancel_byte(state->cancelByte());
    }
    return env.Undefined();
  }

}  // namespace fast_fs_hash

#endif
