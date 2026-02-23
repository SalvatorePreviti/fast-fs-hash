#include "XXHash128Wrap.h"
#include "InstanceHashWorker_impl.h"
#include "UpdateFileWorker_impl.h"
#include "CacheAsyncWorkers.h"

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("XXHash128", XXHash128Wrap::Init(env));
  exports.Set("libraryStatus", Napi::String::New(env, "native"));
  exports.Set("statAndMatch", Napi::Function::New(env, fast_fs_hash::CacheStatAndMatch));
  exports.Set("completeEntries", Napi::Function::New(env, fast_fs_hash::CacheCompleteEntries));
  exports.Set("remapOldEntries", Napi::Function::New(env, fast_fs_hash::CacheRemapOldEntries));
  return exports;
}

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC visibility push(default)
#endif

NODE_API_MODULE(fast_fs_hash, Init)

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC visibility pop
#endif
