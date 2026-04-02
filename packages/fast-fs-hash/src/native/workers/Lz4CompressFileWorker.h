/**
 * Lz4CompressFileWorker: reads a file and LZ4-block-compresses it on the pool
 * thread. Returns the compressed data as a Buffer.
 *
 * Strategy: read the entire file into memory, then compress in one shot.
 * LZ4 block compression is extremely fast and handles files up to
 * LZ4_MAX_INPUT_SIZE (~1.9 GiB). We cap at 512 MiB to keep memory usage
 * reasonable for a single operation.
 *
 * For the read phase, we use fstat to learn the file size, allocate once,
 * then read_at_most. This avoids realloc loops for typical files.
 */

#ifndef _FAST_FS_HASH_LZ4_COMPRESS_FILE_WORKER_H
#define _FAST_FS_HASH_LZ4_COMPRESS_FILE_WORKER_H

#include "includes.h"
#include "FfshFile.h"
#include "AddonWorker.h"
#include <lz4.h>

namespace fast_fs_hash {

  class Lz4CompressFileWorker final : public AddonWorker {
   public:
    Lz4CompressFileWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::string path) :
      AddonWorker(env, deferred), path_(std::move(path)) {}

    ~Lz4CompressFileWorker() override {
      if (this->outBuf_) {
        free(this->outBuf_);
      }
      if (this->fileBuf_) {
        free(this->fileBuf_);
      }
    }

    static constexpr size_t MAX_FILE_SIZE = 512u * 1024 * 1024;

    void Execute() override {
      FfshFile fh(this->path_.c_str());
      if (!fh) [[unlikely]] {
        this->signal("lz4ReadAndCompress: cannot open file");
        return;
      }

      const int64_t fileSize = fh.fsize();
      if (fileSize < 0) [[unlikely]] {
        this->signal("lz4ReadAndCompress: cannot stat file");
        return;
      }
      if (fileSize == 0) {
        // Empty file → empty compressed output
        this->outLen_ = 0;
        this->fileSize_ = 0;
        this->signal();
        return;
      }
      if (static_cast<uint64_t>(fileSize) > MAX_FILE_SIZE) [[unlikely]] {
        this->signal("lz4ReadAndCompress: file exceeds 512 MiB limit");
        return;
      }

      const size_t fsize = static_cast<size_t>(fileSize);
      this->fileSize_ = fsize;

      // Allocate file read buffer
      this->fileBuf_ = static_cast<uint8_t *>(malloc(fsize));
      if (!this->fileBuf_) [[unlikely]] {
        this->signal("lz4ReadAndCompress: out of memory (file buffer)");
        return;
      }

      // Read entire file
      const int64_t nread = fh.read_at_most(this->fileBuf_, fsize);
      if (nread < 0 || static_cast<size_t>(nread) != fsize) [[unlikely]] {
        this->signal("lz4ReadAndCompress: read error");
        return;
      }

      // Compress
      const int srcSize = static_cast<int>(fsize);
      const int maxDst = LZ4_compressBound(srcSize);
      this->outBuf_ = static_cast<uint8_t *>(malloc(static_cast<size_t>(maxDst)));
      if (!this->outBuf_) [[unlikely]] {
        this->signal("lz4ReadAndCompress: out of memory (output buffer)");
        return;
      }

      this->outLen_ = LZ4_compress_default(
        reinterpret_cast<const char *>(this->fileBuf_), reinterpret_cast<char *>(this->outBuf_), srcSize, maxDst);

      // Free file buffer immediately — we only need the compressed output now
      free(this->fileBuf_);
      this->fileBuf_ = nullptr;

      if (this->outLen_ <= 0) [[unlikely]] {
        this->signal("lz4ReadAndCompress: compression failed");
        return;
      }

      this->signal();
    }

    void OnOK() override {
      auto env = Napi::Env(this->env);
      Napi::HandleScope scope(env);

      if (this->outBuf_ && this->outLen_ > 0) {
        // Transfer ownership of outBuf_ to the JS Buffer
        uint8_t * buf = this->outBuf_;
        this->outBuf_ = nullptr;
        auto result = Napi::Buffer<uint8_t>::New(env, buf, static_cast<size_t>(this->outLen_), [](Napi::Env, uint8_t * p) {
          free(p);
        });

        // Create result object: { data: Buffer, uncompressedSize: number }
        auto obj = Napi::Object::New(env);
        obj.Set("data", result);
        obj.Set("uncompressedSize", Napi::Number::New(env, static_cast<double>(this->fileSize_)));
        this->deferred.Resolve(obj);
      } else {
        // Empty file
        auto obj = Napi::Object::New(env);
        obj.Set("data", Napi::Buffer<uint8_t>::New(env, 0));
        obj.Set("uncompressedSize", Napi::Number::New(env, 0));
        this->deferred.Resolve(obj);
      }
    }

   private:
    std::string path_;
    uint8_t * fileBuf_ = nullptr;
    uint8_t * outBuf_ = nullptr;
    int outLen_ = 0;
    size_t fileSize_ = 0;
  };

}  // namespace fast_fs_hash

#endif
