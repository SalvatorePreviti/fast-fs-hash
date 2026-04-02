#ifndef _FAST_FS_HASH_FILES_EQUAL_BINDING_H
#define _FAST_FS_HASH_FILES_EQUAL_BINDING_H

#include "FilesEqualWorker.h"

namespace fast_fs_hash {

  /** filesEqual(pathA, pathB) → Promise<boolean> */
  static Napi::Value bindFilesEqual(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new FilesEqualWorker(
      env, deferred, info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value());
    worker->Queue();
    return deferred.Promise();
  }

}  // namespace fast_fs_hash

#endif
