/**
 * find-project-root-binding.h — napi bindings for findProjectRoot{,Sync}.
 *
 * Exposes two entry points:
 *   findProjectRootSync(startPath: string) → ProjectRoot      (blocking)
 *   findProjectRoot(startPath: string)    → Promise<ProjectRoot>  (pool)
 *
 * The sync path builds the result object directly via the napi C API
 * (napi_create_object + napi_set_named_property) to avoid per-key overhead
 * from Napi::Object::Set — the walk itself typically completes in tens of
 * microseconds, so object construction cost is non-negligible at this scale.
 */

#ifndef _FAST_FS_HASH_FIND_PROJECT_ROOT_BINDING_H
#define _FAST_FS_HASH_FIND_PROJECT_ROOT_BINDING_H

#include "workers/FindProjectRootWorker.h"

namespace fast_fs_hash {

  /** Extract an optional string argument at position `i`. Empty if missing/invalid. */
  inline std::string extractStringArg(const Napi::CallbackInfo & info, size_t i) {
    if (info.Length() > i && info[i].IsString()) {
      return info[i].As<Napi::String>().Utf8Value();
    }
    return {};
  }

  /** findProjectRootSync(startPath, homePath?, stopPath?) → ProjectRoot */
  static Napi::Value bindFindProjectRootSync(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "findProjectRootSync: startPath must be a string").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string startPath = info[0].As<Napi::String>().Utf8Value();
    std::string homePath = extractStringArg(info, 1);
    std::string stopPath = extractStringArg(info, 2);

    ProjectRootResult result;
    walkProjectRoot(startPath.c_str(), homePath.c_str(), stopPath.c_str(), result);
    if (result.error) {
      Napi::Error::New(env, result.error).ThrowAsJavaScriptException();
      return env.Undefined();
    }

    napi_value obj = buildProjectRootObject(env, result);
    if (!obj) {
      Napi::Error::New(env, "findProjectRoot: failed to build result object").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return Napi::Value(env, obj);
  }

  /** findProjectRoot(startPath, homePath?, stopPath?) → Promise<ProjectRoot> */
  static Napi::Value bindFindProjectRoot(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    if (info.Length() < 1 || !info[0].IsString()) {
      deferred.Reject(Napi::TypeError::New(env, "findProjectRoot: startPath must be a string").Value());
      return deferred.Promise();
    }
    auto * worker = new FindProjectRootWorker(
      env, deferred,
      info[0].As<Napi::String>().Utf8Value(),
      extractStringArg(info, 1),
      extractStringArg(info, 2));
    worker->Queue();
    return deferred.Promise();
  }

}  // namespace fast_fs_hash

#endif
