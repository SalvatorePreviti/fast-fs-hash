#include "digest-functions.h"
#include "stream-functions.h"
#include "lz4-functions.h"
#include "InstanceHashWorker_impl.h"
#include "file-cache-binding.h"
#include "AddonData_impl.h"

static Napi::Value getCpuFeatures(const Napi::CallbackInfo & info) {
  auto env = info.Env();
  auto obj = Napi::Object::New(env);
  bool hasAvx2 = false;
  bool hasAvx512 = false;

#if defined(__x86_64__) || defined(_M_X64)
#  if defined(__GNUC__) || defined(__clang__)
  __builtin_cpu_init();
  hasAvx2 = __builtin_cpu_supports("avx2");
  hasAvx512 = __builtin_cpu_supports("avx512f");
#  elif defined(_MSC_VER)
  int cpuInfo[4] = {};
  __cpuidex(cpuInfo, 7, 0);
  hasAvx2 = (cpuInfo[1] & (1 << 5)) != 0;
  hasAvx512 = (cpuInfo[1] & (1 << 16)) != 0;
#  endif
#endif

  obj.Set("avx2", Napi::Boolean::New(env, hasAvx2));
  obj.Set("avx512", Napi::Boolean::New(env, hasAvx512));
  return obj;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  fast_fs_hash::AddonData::init(env);

  // CPU feature detection (used by init-native.ts to pick the right ISA variant)
  exports.Set("getCpuFeatures", Napi::Function::New(env, getCpuFeatures));

  // Digest functions (seed=0, optional outOffset)
  exports.Set("digestBufferTo", Napi::Function::New(env, digest_functions::digestBufferTo));
  exports.Set("digestBufferRangeTo", Napi::Function::New(env, digest_functions::digestBufferRangeTo));
  exports.Set("digestStringTo", Napi::Function::New(env, digest_functions::digestStringTo));

  // File-hashing functions (standalone)
  exports.Set(
    "encodedPathsDigestFilesParallelTo", Napi::Function::New(env, digest_functions::encodedPathsDigestFilesParallelTo));
  exports.Set(
    "encodedPathsDigestFilesSequentialTo", Napi::Function::New(env, digest_functions::encodedPathsDigestFilesSequentialTo));
  exports.Set("digestFileTo", Napi::Function::New(env, digest_functions::digestFileTo));

  // Stream functions (state-buffer based, no ObjectWrap)
  exports.Set("streamAllocState", Napi::Function::New(env, stream_functions::streamAllocState));
  exports.Set("streamReset", Napi::Function::New(env, stream_functions::streamReset));
  exports.Set("streamAddBuffer", Napi::Function::New(env, stream_functions::streamAddBuffer));
  exports.Set("streamAddString", Napi::Function::New(env, stream_functions::streamAddString));
  exports.Set("streamDigestTo", Napi::Function::New(env, stream_functions::streamDigestTo));
  exports.Set("streamAddFile", Napi::Function::New(env, stream_functions::streamAddFile));
  exports.Set("streamAddFilesParallel", Napi::Function::New(env, stream_functions::streamAddFilesParallel));
  exports.Set("streamAddFilesSequential", Napi::Function::New(env, stream_functions::streamAddFilesSequential));
  exports.Set("streamClone", Napi::Function::New(env, stream_functions::streamClone));

  // Cache functions (always-locking: open acquires lock, write uses locked fd)
  exports.Set("cacheOpen", Napi::Function::New(env, fast_fs_hash::bindCacheOpen));
  exports.Set("cacheWrite", Napi::Function::New(env, fast_fs_hash::bindCacheWrite));
  exports.Set("cacheWriteNew", Napi::Function::New(env, fast_fs_hash::bindCacheWriteNew));

  // Cache close / query (handle is an int32 fd in dataBuf header)
  exports.Set("cacheClose", Napi::Function::New(env, fast_fs_hash::bindCacheClose));
  exports.Set("cacheIsLocked", Napi::Function::New(env, fast_fs_hash::bindCacheIsLocked));

  // LZ4 block compression
  exports.Set("lz4CompressBlock", Napi::Function::New(env, lz4_functions::lz4CompressBlock));
  exports.Set("lz4CompressBlockTo", Napi::Function::New(env, lz4_functions::lz4CompressBlockTo));
  exports.Set("lz4CompressBlockAsync", Napi::Function::New(env, lz4_functions::lz4CompressBlockAsync));
  exports.Set("lz4DecompressBlock", Napi::Function::New(env, lz4_functions::lz4DecompressBlock));
  exports.Set("lz4DecompressBlockTo", Napi::Function::New(env, lz4_functions::lz4DecompressBlockTo));
  exports.Set("lz4DecompressBlockAsync", Napi::Function::New(env, lz4_functions::lz4DecompressBlockAsync));
  exports.Set("lz4CompressBound", Napi::Function::New(env, lz4_functions::lz4CompressBound));

  return exports;
}

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC visibility push(default)
#endif

NODE_API_MODULE(fast_fs_hash, Init)

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC visibility pop
#endif
