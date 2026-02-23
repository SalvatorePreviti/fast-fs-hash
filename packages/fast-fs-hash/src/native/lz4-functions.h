#ifndef _FAST_FS_HASH_LZ4_FUNCTIONS_H
#define _FAST_FS_HASH_LZ4_FUNCTIONS_H

#include "includes.h"
#include "AddonWorker.h"
#include <lz4.h>

/**
 * LZ4 block compression/decompression for Node.js buffers.
 *
 * All functions validate buffer bounds before calling LZ4.
 * Sync functions run on the JS thread. Async functions run on the pool thread.
 */
namespace lz4_functions {

  static constexpr size_t LZ4_MAX_DECOMPRESS = 256u * 1024 * 1024;

  /** Extract (ptr, len) from a typed array arg, applying optional offset+length range. */
  static FSH_FORCE_INLINE bool resolveRange(
    napi_env env, const Napi::CallbackInfo & info, int argIdx, int offArg, int lenArg, const uint8_t *& ptr, size_t & len) {
    size_t bufLen = 0;
    void * bufPtr = nullptr;
    napi_get_typedarray_info(env, info[argIdx], nullptr, &bufLen, &bufPtr, nullptr, nullptr);

    uint32_t offset = 0;
    if (offArg >= 0 && info.Length() > static_cast<size_t>(offArg)) {
      napi_get_value_uint32(env, info[offArg], &offset);
    }

    uint32_t length = 0;
    bool hasLength = false;
    if (lenArg >= 0 && info.Length() > static_cast<size_t>(lenArg)) {
      if (!info[lenArg].IsUndefined()) {
        napi_get_value_uint32(env, info[lenArg], &length);
        hasLength = true;
      }
    }

    if (static_cast<size_t>(offset) > bufLen) [[unlikely]] {
      Napi::RangeError::New(env, "offset exceeds buffer length").ThrowAsJavaScriptException();
      return false;
    }

    if (hasLength) {
      if (static_cast<size_t>(offset) + length > bufLen) [[unlikely]] {
        Napi::RangeError::New(env, "offset + length exceeds buffer length").ThrowAsJavaScriptException();
        return false;
      }
      len = length;
    } else {
      len = bufLen - static_cast<size_t>(offset);
    }

    ptr = static_cast<const uint8_t *>(bufPtr) + offset;
    return true;
  }

  /** Resolve output (ptr, available) from typed array + offset arg. */
  static FSH_FORCE_INLINE bool resolveOutput(
    napi_env env, const Napi::CallbackInfo & info, int argIdx, int offArg, uint8_t *& ptr, size_t & available) {
    size_t bufLen = 0;
    void * bufPtr = nullptr;
    napi_get_typedarray_info(env, info[argIdx], nullptr, &bufLen, &bufPtr, nullptr, nullptr);

    uint32_t offset = 0;
    if (offArg >= 0 && info.Length() > static_cast<size_t>(offArg)) {
      napi_get_value_uint32(env, info[offArg], &offset);
    }

    if (static_cast<size_t>(offset) > bufLen) [[unlikely]] {
      Napi::RangeError::New(env, "outputOffset exceeds output buffer").ThrowAsJavaScriptException();
      return false;
    }

    ptr = static_cast<uint8_t *>(bufPtr) + offset;
    available = bufLen - static_cast<size_t>(offset);
    return true;
  }

  /** lz4CompressBlock(input, offset?, length?) → Buffer */
  static Napi::Value lz4CompressBlock(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    const uint8_t * src;
    size_t srcLen;
    if (!resolveRange(env, info, 0, 1, 2, src, srcLen)) {
      return Napi::Value(env, nullptr);
    }

    if (srcLen == 0) {
      return Napi::Buffer<uint8_t>::New(env, 0);
    }
    if (srcLen > static_cast<size_t>(LZ4_MAX_INPUT_SIZE)) [[unlikely]] {
      Napi::RangeError::New(env, "lz4CompressBlock: input exceeds LZ4_MAX_INPUT_SIZE").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    const int srcSize = static_cast<int>(srcLen);
    const int maxDst = LZ4_compressBound(srcSize);
    auto * tmp = static_cast<uint8_t *>(malloc(static_cast<size_t>(maxDst)));
    if (!tmp) [[unlikely]] {
      Napi::Error::New(env, "lz4CompressBlock: out of memory").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    const int compressedSize =
      LZ4_compress_default(reinterpret_cast<const char *>(src), reinterpret_cast<char *>(tmp), srcSize, maxDst);

    if (compressedSize <= 0) [[unlikely]] {
      free(tmp);
      Napi::Error::New(env, "lz4CompressBlock: compression failed").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    auto result = Napi::Buffer<uint8_t>::New(env, tmp, static_cast<size_t>(compressedSize), [](Napi::Env, uint8_t * p) {
      free(p);
    });
    return result;
  }

  /** lz4CompressBlockTo(input, output, outputOffset?, inputOffset?, inputLength?) → bytes written */
  static Napi::Value lz4CompressBlockTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    const uint8_t * src;
    size_t srcLen;
    if (!resolveRange(env, info, 0, 3, 4, src, srcLen)) {
      return Napi::Value(env, nullptr);
    }

    uint8_t * dst;
    size_t dstAvail;
    if (!resolveOutput(env, info, 1, 2, dst, dstAvail)) {
      return Napi::Value(env, nullptr);
    }

    if (srcLen == 0) {
      return Napi::Number::New(env, 0);
    }
    if (srcLen > static_cast<size_t>(LZ4_MAX_INPUT_SIZE)) [[unlikely]] {
      Napi::RangeError::New(env, "lz4CompressBlockTo: input exceeds LZ4_MAX_INPUT_SIZE").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    const int compressedSize = LZ4_compress_default(
      reinterpret_cast<const char *>(src),
      reinterpret_cast<char *>(dst),
      static_cast<int>(srcLen),
      static_cast<int>(dstAvail));

    if (compressedSize <= 0) [[unlikely]] {
      Napi::Error::New(env, "lz4CompressBlockTo: output buffer too small or compression failed")
        .ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    return Napi::Number::New(env, compressedSize);
  }

  /** lz4DecompressBlock(input, uncompressedSize, inputOffset?, inputLength?) → Buffer */
  static Napi::Value lz4DecompressBlock(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    uint32_t uncompSize = 0;
    napi_get_value_uint32(env, info[1], &uncompSize);

    const uint8_t * src;
    size_t srcLen;
    if (!resolveRange(env, info, 0, 2, 3, src, srcLen)) {
      return Napi::Value(env, nullptr);
    }

    if (uncompSize == 0) {
      return Napi::Buffer<uint8_t>::New(env, 0);
    }
    if (uncompSize > LZ4_MAX_DECOMPRESS) [[unlikely]] {
      Napi::RangeError::New(env, "lz4DecompressBlock: size exceeds 256 MiB").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    if (srcLen > static_cast<size_t>(INT32_MAX)) [[unlikely]] {
      Napi::RangeError::New(env, "lz4DecompressBlock: input exceeds 2 GiB").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    auto outBuf = Napi::Buffer<uint8_t>::New(env, uncompSize);

    const int decompressed = LZ4_decompress_safe(
      reinterpret_cast<const char *>(src),
      reinterpret_cast<char *>(outBuf.Data()),
      static_cast<int>(srcLen),
      static_cast<int>(uncompSize));

    if (decompressed < 0 || static_cast<uint32_t>(decompressed) != uncompSize) [[unlikely]] {
      Napi::Error::New(env, "lz4DecompressBlock: decompression failed").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    return outBuf;
  }

  /** lz4DecompressBlockTo(input, uncompressedSize, output, outputOffset?, inputOffset?, inputLength?) → bytes written */
  static Napi::Value lz4DecompressBlockTo(const Napi::CallbackInfo & info) {
    auto env = info.Env();

    uint32_t uncompSize = 0;
    napi_get_value_uint32(env, info[1], &uncompSize);

    const uint8_t * src;
    size_t srcLen;
    if (!resolveRange(env, info, 0, 4, 5, src, srcLen)) {
      return Napi::Value(env, nullptr);
    }

    uint8_t * dst;
    size_t dstAvail;
    if (!resolveOutput(env, info, 2, 3, dst, dstAvail)) {
      return Napi::Value(env, nullptr);
    }

    if (uncompSize == 0) {
      return Napi::Number::New(env, 0);
    }
    if (static_cast<size_t>(uncompSize) > dstAvail) [[unlikely]] {
      Napi::RangeError::New(env, "lz4DecompressBlockTo: uncompressedSize exceeds output space").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }
    if (srcLen > static_cast<size_t>(INT32_MAX)) [[unlikely]] {
      Napi::RangeError::New(env, "lz4DecompressBlockTo: input exceeds 2 GiB").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    const int decompressed = LZ4_decompress_safe(
      reinterpret_cast<const char *>(src),
      reinterpret_cast<char *>(dst),
      static_cast<int>(srcLen),
      static_cast<int>(uncompSize));

    if (decompressed < 0 || static_cast<uint32_t>(decompressed) != uncompSize) [[unlikely]] {
      Napi::Error::New(env, "lz4DecompressBlockTo: decompression failed").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    return Napi::Number::New(env, decompressed);
  }

  /** lz4CompressBound(inputSize) → max compressed size */
  static Napi::Value lz4CompressBound(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    uint32_t inputSize = 0;
    napi_get_value_uint32(env, info[0], &inputSize);
    if (inputSize > static_cast<uint32_t>(LZ4_MAX_INPUT_SIZE)) [[unlikely]] {
      return Napi::Number::New(env, 0);
    }
    return Napi::Number::New(env, LZ4_compressBound(static_cast<int>(inputSize)));
  }

  class Lz4CompressWorker final : public fast_fs_hash::AddonWorker {
   public:
    Lz4CompressWorker(
      Napi::Env env, Napi::Promise::Deferred deferred, Napi::ObjectReference inputRef, const uint8_t * data, size_t len) :
      AddonWorker(env, deferred), inputRef_(std::move(inputRef)), data_(data), len_(len) {}

    void Execute() override {
      if (this->len_ == 0) {
        this->signal();
        return;
      }
      if (this->len_ > static_cast<size_t>(LZ4_MAX_INPUT_SIZE)) {
        this->signal("lz4CompressBlockAsync: input exceeds LZ4_MAX_INPUT_SIZE");
        return;
      }
      const int srcSize = static_cast<int>(this->len_);
      const int maxDst = LZ4_compressBound(srcSize);
      this->outBuf_ = static_cast<uint8_t *>(malloc(static_cast<size_t>(maxDst)));
      if (!this->outBuf_) [[unlikely]] {
        this->signal("lz4CompressBlockAsync: out of memory");
        return;
      }
      this->outLen_ = LZ4_compress_default(
        reinterpret_cast<const char *>(this->data_), reinterpret_cast<char *>(this->outBuf_), srcSize, maxDst);
      if (this->outLen_ <= 0) [[unlikely]] {
        free(this->outBuf_);
        this->outBuf_ = nullptr;
        this->signal("lz4CompressBlockAsync: compression failed");
        return;
      }
      this->signal();
    }

    void OnOK() override {
      auto env = Napi::Env(this->env);
      Napi::HandleScope scope(env);
      if (this->outBuf_ && this->outLen_ > 0) {
        this->deferred.Resolve(
          Napi::Buffer<uint8_t>::New(env, this->outBuf_, static_cast<size_t>(this->outLen_), [](Napi::Env, uint8_t * p) {
            free(p);
          }));
      } else {
        this->deferred.Resolve(Napi::Buffer<uint8_t>::New(env, 0));
      }
    }

   private:
    Napi::ObjectReference inputRef_;
    const uint8_t * data_;
    size_t len_;
    uint8_t * outBuf_ = nullptr;
    int outLen_ = 0;
  };

  class Lz4DecompressWorker final : public fast_fs_hash::AddonWorker {
   public:
    Lz4DecompressWorker(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      Napi::ObjectReference inputRef,
      const uint8_t * data,
      size_t len,
      uint32_t uncompSize) :
      AddonWorker(env, deferred), inputRef_(std::move(inputRef)), data_(data), len_(len), uncompSize_(uncompSize) {}

    void Execute() override {
      if (this->uncompSize_ == 0) {
        this->signal();
        return;
      }
      this->outBuf_ = static_cast<uint8_t *>(malloc(this->uncompSize_));
      if (!this->outBuf_) [[unlikely]] {
        this->signal("lz4DecompressBlockAsync: out of memory");
        return;
      }
      const int result = LZ4_decompress_safe(
        reinterpret_cast<const char *>(this->data_),
        reinterpret_cast<char *>(this->outBuf_),
        static_cast<int>(this->len_),
        static_cast<int>(this->uncompSize_));
      if (result < 0 || static_cast<uint32_t>(result) != this->uncompSize_) [[unlikely]] {
        free(this->outBuf_);
        this->outBuf_ = nullptr;
        this->signal("lz4DecompressBlockAsync: decompression failed");
        return;
      }
      this->signal();
    }

    void OnOK() override {
      auto env = Napi::Env(this->env);
      Napi::HandleScope scope(env);
      if (this->outBuf_) {
        this->deferred.Resolve(Napi::Buffer<uint8_t>::New(env, this->outBuf_, this->uncompSize_, [](Napi::Env, uint8_t * p) {
          free(p);
        }));
      } else {
        this->deferred.Resolve(Napi::Buffer<uint8_t>::New(env, 0));
      }
    }

   private:
    Napi::ObjectReference inputRef_;
    const uint8_t * data_;
    size_t len_;
    uint32_t uncompSize_;
    uint8_t * outBuf_ = nullptr;
  };

  /** lz4CompressBlockAsync(input, offset?, length?) → Promise<Buffer> */
  static Napi::Value lz4CompressBlockAsync(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto input = info[0].As<Napi::Uint8Array>();

    const uint8_t * src;
    size_t srcLen;
    if (!resolveRange(env, info, 0, 1, 2, src, srcLen)) {
      return Napi::Value(env, nullptr);
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new Lz4CompressWorker(env, deferred, Napi::ObjectReference::New(input, 1), src, srcLen);
    worker->Queue();
    return deferred.Promise();
  }

  /** lz4DecompressBlockAsync(input, uncompressedSize, offset?, length?) → Promise<Buffer> */
  static Napi::Value lz4DecompressBlockAsync(const Napi::CallbackInfo & info) {
    auto env = info.Env();
    auto input = info[0].As<Napi::Uint8Array>();

    uint32_t uncompSize = 0;
    napi_get_value_uint32(env, info[1], &uncompSize);

    const uint8_t * src;
    size_t srcLen;
    if (!resolveRange(env, info, 0, 2, 3, src, srcLen)) {
      return Napi::Value(env, nullptr);
    }

    if (uncompSize > LZ4_MAX_DECOMPRESS) [[unlikely]] {
      Napi::RangeError::New(env, "lz4DecompressBlockAsync: size exceeds 256 MiB").ThrowAsJavaScriptException();
      return Napi::Value(env, nullptr);
    }

    auto deferred = Napi::Promise::Deferred::New(env);
    auto * worker = new Lz4DecompressWorker(env, deferred, Napi::ObjectReference::New(input, 1), src, srcLen, uncompSize);
    worker->Queue();
    return deferred.Promise();
  }

}  // namespace lz4_functions

#endif
