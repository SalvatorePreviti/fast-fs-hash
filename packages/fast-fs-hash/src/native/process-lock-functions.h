#ifndef _FAST_FS_HASH_PROCESS_LOCK_FUNCTIONS_H
#define _FAST_FS_HASH_PROCESS_LOCK_FUNCTIONS_H

#include "napi-helpers.h"
#include "workers/ProcessLockWorker.h"

namespace process_lock_functions {

  using namespace fast_fs_hash;

  /** processLockAsync(shmName: string, timeoutMs: number) → Promise<External<void>> */
  static Napi::Value processLockAsync(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 2 || !info[0].IsString()) [[unlikely]] {
      Napi::TypeError::New(env, "processLockAsync: expected (shmName: string, timeoutMs: number)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    char shmName[32];
    size_t copied = 0;
    napi_get_value_string_utf8(env, info[0], shmName, sizeof(shmName), &copied);
    const int timeoutMs = info[1].As<Napi::Number>().Int32Value();

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new ProcessLockWorker(env, deferred, shmName, timeoutMs);
    worker->Start();
    return deferred.Promise();
  }

  /** processLockRelease(handle: External<void>) → void */
  static Napi::Value processLockRelease(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsExternal()) [[unlikely]] {
      Napi::TypeError::New(env, "processLockRelease: expected External handle").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto * handle = info[0].As<Napi::External<ProcessLockHandle>>().Data();
    auto * addon = AddonData::get(env);
    if (addon) {
      addon->unregisterHeldLock(handle);
    }
    fast_fs_hash::processLockRelease(handle);
    return env.Undefined();
  }

  /** processLockIsLocked(shmName: string) → boolean */
  static Napi::Value processLockIsLockedFn(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) [[unlikely]] {
      Napi::TypeError::New(env, "processLockIsLocked: expected (shmName: string)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    char shmName[32];
    size_t copied = 0;
    napi_get_value_string_utf8(env, info[0], shmName, sizeof(shmName), &copied);

    const bool locked = processLockIsLocked(shmName);
    return Napi::Boolean::New(env, locked);
  }

  /** processLockHashName(name: string) → string (the 27-char shm name) */
  static Napi::Value processLockHashNameFn(const Napi::CallbackInfo & info) {
    const auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) [[unlikely]] {
      Napi::TypeError::New(env, "processLockHashName: expected (name: string)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    char shmName[32];
    const XXH128_hash_t h = fast_hash_string(env, info[0], 0);
    shmName[0] = '/';
    shmName[1] = 'L';
    encodeBase36(h.low64, shmName + 2, 13);
    encodeBase36(h.high64, shmName + 15, 12);
    shmName[27] = '\0';
    return Napi::String::New(env, shmName);
  }

}  // namespace process_lock_functions

#endif
