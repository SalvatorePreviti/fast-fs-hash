#include "XXHash128Wrap.h"
#include "InstanceHashWorker_impl.h"
#include "UpdateFileWorker_impl.h"

// ── Module exports ───────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("XXHash128", XXHash128Wrap::Init(env));
  return exports;
}

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC visibility push(default)
#endif

NODE_API_MODULE(fast_fs_hash, Init)

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC visibility pop
#endif
