/**
 * find-nearest-project-files-binding.h — napi bindings for findNearestProjectFiles{,Sync}.
 *
 * Trimmed-down sibling of findProjectRoot{,Sync} that only finds the nearest
 * package.json / tsconfig.json / node_modules and stops as soon as all three
 * are filled. Faster than findProjectRoot when callers don't need the gitRoot
 * boundary or root* fields.
 */

#ifndef _FAST_FS_HASH_FIND_NEAREST_PROJECT_FILES_BINDING_H
#define _FAST_FS_HASH_FIND_NEAREST_PROJECT_FILES_BINDING_H

#include "find-project-root-binding.h"  // for extractStringArg
#include "workers/FindNearestProjectFilesWorker.h"

namespace fast_fs_hash {

  /** findNearestProjectFilesSync(startPath, homePath?, stopPath?) → NearestProjectFiles */
  static Napi::Value bindFindNearestProjectFilesSync(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(
        env, "findNearestProjectFilesSync: startPath must be a string").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string startPath = info[0].As<Napi::String>().Utf8Value();
    std::string homePath = extractStringArg(info, 1);
    std::string stopPath = extractStringArg(info, 2);

    NearestProjectFilesResult result;
    walkNearestProjectFiles(startPath.c_str(), homePath.c_str(), stopPath.c_str(), result);
    if (result.error) {
      Napi::Error::New(env, result.error).ThrowAsJavaScriptException();
      return env.Undefined();
    }

    napi_value obj = buildNearestProjectFilesObject(env, result);
    if (!obj) {
      Napi::Error::New(
        env, "findNearestProjectFiles: failed to build result object").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return Napi::Value(env, obj);
  }

  /** findNearestProjectFiles(startPath, homePath?, stopPath?) → Promise<NearestProjectFiles> */
  static Napi::Value bindFindNearestProjectFiles(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    if (info.Length() < 1 || !info[0].IsString()) {
      deferred.Reject(Napi::TypeError::New(
        env, "findNearestProjectFiles: startPath must be a string").Value());
      return deferred.Promise();
    }
    auto * worker = new FindNearestProjectFilesWorker(
      env, deferred,
      info[0].As<Napi::String>().Utf8Value(),
      extractStringArg(info, 1),
      extractStringArg(info, 2));
    worker->Queue();
    return deferred.Promise();
  }

}  // namespace fast_fs_hash

#endif
