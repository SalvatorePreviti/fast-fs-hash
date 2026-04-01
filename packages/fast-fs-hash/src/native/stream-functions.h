#ifndef _FAST_FS_HASH_STREAM_FUNCTIONS_H
#define _FAST_FS_HASH_STREAM_FUNCTIONS_H

#include "napi-helpers.h"
#include "InstanceHashWorker.h"
#include "HashSequentialWorker.h"
#include "UpdateFileWorker.h"

/**
 * xxHash128 streaming functions — stateless, take an opaque External
 * as the first argument instead of using ObjectWrap.
 *
 * The state is allocated with 64-byte alignment by streamAllocState() and
 * wrapped in a Napi::External. JS holds the External, C++ extracts the raw
 * pointer with napi_get_value_external (much cheaper than napi_get_typedarray_info).
 *
 * A magic tag is stored before the XXH3_state_t to validate the pointer on
 * every call, preventing crashes from wrong/forged External values.
 */
namespace stream_functions {

  static constexpr size_t STATE_ALIGNMENT = 64;

  /** Magic tag placed before XXH3_state_t to validate the pointer. */
  static constexpr uint64_t STATE_MAGIC = 0x5858'4833'7374'6174ULL;  // "XXH3stat"

  /**
   * Tagged state layout (64-byte aligned):
   *   [0..7]   magic tag (STATE_MAGIC)
   *   [64..]   XXH3_state_t (starts at next 64-byte boundary)
   *
   * Total allocation: 64 + round_up(sizeof(XXH3_state_t), 64)
   */
  struct TaggedState {
    uint64_t magic;
    // Padding to next 64-byte boundary is implicit in the allocation size.
    // XXH3_state_t lives at (this + STATE_ALIGNMENT).
  };

  static FSH_FORCE_INLINE XXH3_state_t * stateFromTag(TaggedState * tag) {
    return reinterpret_cast<XXH3_state_t *>(reinterpret_cast<uint8_t *>(tag) + STATE_ALIGNMENT);
  }

  static void freeTaggedState(Napi::Env, TaggedState * p) { aligned_free(p); }

  /** Rounded-up state size and total allocation for tagged state. */
  static constexpr size_t ALIGNED_STATE_SIZE = (sizeof(XXH3_state_t) + STATE_ALIGNMENT - 1) & ~(STATE_ALIGNMENT - 1);
  static constexpr size_t TOTAL_STATE_ALLOC = STATE_ALIGNMENT + ALIGNED_STATE_SIZE;

  /**
   * Extract and validate XXH3_state_t* from a napi_value (expected External).
   * Throws TypeError and returns nullptr if the value is not a valid stream state.
   */
  static FSH_FORCE_INLINE XXH3_state_t * getState(napi_env env, napi_value val) {
    void * ptr = nullptr;
    if (napi_get_value_external(env, val, &ptr) != napi_ok || !ptr ||
        reinterpret_cast<TaggedState *>(ptr)->magic != STATE_MAGIC) [[unlikely]] {
      Napi::TypeError::New(env, "Invalid stream state: expected object from streamAllocState()")
        .ThrowAsJavaScriptException();
      return nullptr;
    }
    return stateFromTag(reinterpret_cast<TaggedState *>(ptr));
  }

  /**
   * Extract and validate raw uint8_t* pointer to the XXH3 state.
   * Used by async workers that need the raw pointer, not the XXH3_state_t*.
   * Throws TypeError and returns nullptr on invalid state.
   */
  static FSH_FORCE_INLINE uint8_t * getStateRawPtr(napi_env env, napi_value val) {
    void * ptr = nullptr;
    if (napi_get_value_external(env, val, &ptr) != napi_ok || !ptr ||
        reinterpret_cast<TaggedState *>(ptr)->magic != STATE_MAGIC) [[unlikely]] {
      Napi::TypeError::New(env, "Invalid stream state: expected object from streamAllocState()")
        .ThrowAsJavaScriptException();
      return nullptr;
    }
    return reinterpret_cast<uint8_t *>(stateFromTag(reinterpret_cast<TaggedState *>(ptr)));
  }

  /** streamAllocState(seedLow, seedHigh) → External (tagged, 64-byte aligned) */
  static Napi::Value streamAllocState(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto * tag = reinterpret_cast<TaggedState *>(aligned_malloc(STATE_ALIGNMENT, TOTAL_STATE_ALLOC));
    if (!tag) [[unlikely]] {
      Napi::Error::New(env, "streamAllocState: out of memory").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    tag->magic = STATE_MAGIC;
    auto * state = stateFromTag(tag);

    uint32_t lo = 0, hi = 0;
    napi_get_value_uint32(env, info[0], &lo);
    napi_get_value_uint32(env, info[1], &hi);
    uint64_t seed = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);

    XXH3_128bits_reset_withSeed(state, seed);

    return Napi::External<TaggedState>::New(env, tag, freeTaggedState);
  }

  /** streamReset(state, seedLow, seedHigh) → void */
  static Napi::Value streamReset(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    auto * state = getState(env, info[0]);
    if (!state) [[unlikely]] return Napi::Value(env, nullptr);

    uint32_t lo = 0, hi = 0;
    napi_get_value_uint32(env, info[1], &lo);
    napi_get_value_uint32(env, info[2], &hi);
    uint64_t seed = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);

    XXH3_128bits_reset_withSeed(state, seed);
    return Napi::Env(env).Undefined();
  }

  /** streamAddBuffer(state, input, offset?, length?) → void */
  static Napi::Value streamAddBuffer(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    auto * state = getState(env, info[0]);
    if (!state) [[unlikely]] return Napi::Value(env, nullptr);

    void * buf_ptr = nullptr;
    size_t buf_len = 0;
    napi_get_typedarray_info(env, info[1], nullptr, &buf_len, &buf_ptr, nullptr, nullptr);

    // Fast path: no offset/length args — hash entire buffer
    if (info.Length() <= 2) [[likely]] {
      XXH3_128bits_update(state, buf_ptr, buf_len);
      return Napi::Env(env).Undefined();
    }

    // Slow path: offset and optional length
    uint32_t offset = 0;
    napi_get_value_uint32(env, info[2], &offset);

    uint32_t len32 = 0;
    size_t length;
    if (info.Length() > 3 && napi_get_value_uint32(env, info[3], &len32) == napi_ok) {
      length = len32;
    } else {
      if (static_cast<size_t>(offset) > buf_len) [[unlikely]] {
        Napi::RangeError::New(env, "streamAddBuffer: offset exceeds buffer size").ThrowAsJavaScriptException();
        return Napi::Value(env, nullptr);
      }
      length = buf_len - static_cast<size_t>(offset);
    }

    if (length > buf_len || static_cast<size_t>(offset) > buf_len - length) [[unlikely]] {
      Napi::RangeError::New(env, "streamAddBuffer: offset + length exceeds buffer size").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    XXH3_128bits_update(state, static_cast<const uint8_t *>(buf_ptr) + offset, length);
    return Napi::Env(env).Undefined();
  }

  /** streamAddString(state, str) → void */
  static Napi::Value streamAddString(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();
    auto * state = getState(env, info[0]);
    if (!state) [[unlikely]] return Napi::Value(env, nullptr);
    char small_buf[STRING_SMALL_BUF];
    char large_buf[STRING_LARGE_BUF];
    const char * data;
    const size_t len = fast_encode_string(env, info[1], small_buf, large_buf, data);
    if (len > 0) {
      XXH3_128bits_update(state, reinterpret_cast<const uint8_t *>(data), len);
    }
    cleanup_string_buf(data, small_buf, large_buf);
    return Napi::Env(env).Undefined();
  }

  /** streamDigestTo(state, out, offset?) → out */
  static Napi::Value streamDigestTo(const Napi::CallbackInfo & info) {
    napi_env env = info.Env();

    auto * state = getState(env, info[0]);
    if (!state) [[unlikely]] return Napi::Value(env, nullptr);

    void * out_ptr = nullptr;
    size_t out_len = 0;
    napi_get_typedarray_info(env, info[1], nullptr, &out_len, &out_ptr, nullptr, nullptr);

    uint32_t offset = 0;
    if (info.Length() > 2) {
      napi_get_value_uint32(env, info[2], &offset);
    }

    if (static_cast<size_t>(offset) > out_len || out_len - static_cast<size_t>(offset) < 16) [[unlikely]] {
      Napi::RangeError::New(env, "streamDigestTo: offset + 16 exceeds output buffer size")
        .ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    XXH128_canonicalFromHash(
      reinterpret_cast<XXH128_canonical_t *>(static_cast<uint8_t *>(out_ptr) + offset),
      XXH3_128bits_digest(state));
    return info[1];
  }

  /** streamAddFile(state, path, throwOnError?) → Promise<void> */
  static Napi::Value streamAddFile(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto * state_ptr = getStateRawPtr(env, info[0]);
    if (!state_ptr) [[unlikely]] return Napi::Value(env, nullptr);

    bool throw_on_error = true;
    if (info.Length() > 2) {
      napi_get_value_bool(env, info[2], &throw_on_error);
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new UpdateFileWorker(
      env, deferred, Napi::ObjectReference::New(info[0].As<Napi::Object>(), 1),
      state_ptr, info[1].As<Napi::String>().Utf8Value(), throw_on_error);
    worker->Queue();
    return deferred.Promise();
  }

  /** streamAddFilesParallel(state, pathsBuf, concurrency, throwOnError?) → Promise<null> */
  static Napi::Value streamAddFilesParallel(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto * state_ptr = getStateRawPtr(env, info[0]);
    if (!state_ptr) [[unlikely]] return Napi::Value(env, nullptr);

    bool throw_on_error = true;
    if (info.Length() > 3) {
      napi_get_value_bool(env, info[3], &throw_on_error);
    }

    auto paths = info[1].As<Napi::Uint8Array>();
    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new InstanceHashWorker(
      env, deferred, Napi::ObjectReference::New(info[0].As<Napi::Object>(), 1),
      state_ptr, info[2].As<Napi::Number>().Int32Value(), throw_on_error);
    worker->setPaths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->Queue();
    return deferred.Promise();
  }

  /** streamAddFilesSequential(state, pathsBuf, throwOnError) → Promise<null> */
  static Napi::Value streamAddFilesSequential(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto * state_ptr = getStateRawPtr(env, info[0]);
    if (!state_ptr) [[unlikely]] return Napi::Value(env, nullptr);

    auto paths = info[1].As<Napi::Uint8Array>();

    bool throw_on_error = true;
    if (info.Length() > 2) {
      napi_value val = info[2];
      napi_get_value_bool(env, val, &throw_on_error);
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new HashSequentialWorker(env, deferred, throw_on_error);
    worker->setState(Napi::ObjectReference::New(info[0].As<Napi::Object>(), 1), state_ptr);
    worker->setPaths(Napi::ObjectReference::New(paths, 1), paths.Data(), paths.ElementLength());
    worker->Queue();
    return deferred.Promise();
  }

  /** streamClone(dst, src) → void — copies src hash state into dst (both must be allocated states) */
  static Napi::Value streamClone(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    auto * dst_state = getState(env, info[0]);
    if (!dst_state) [[unlikely]] return Napi::Value(env, nullptr);

    auto * src_state = getState(env, info[1]);
    if (!src_state) [[unlikely]] return Napi::Value(env, nullptr);

    XXH3_copyState(dst_state, src_state);
    return Napi::Env(env).Undefined();
  }

}  // namespace stream_functions

#endif
