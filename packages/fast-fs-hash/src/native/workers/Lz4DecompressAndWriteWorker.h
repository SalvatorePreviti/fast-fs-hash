/**
 * Lz4DecompressAndWriteWorker: decompresses LZ4 data and writes to a file on
 * the pool thread. The inverse of Lz4CompressFileWorker / lz4ReadAndCompress.
 *
 * Takes compressed data + uncompressedSize, decompresses, writes to path.
 * Creates parent directories if needed. Resolves true on success, throws on error.
 *
 * Cross-platform: uses FfshFile open_locked machinery for mkdir-p, then
 * truncate + write_all + close.
 */

#ifndef _FAST_FS_HASH_LZ4_DECOMPRESS_AND_WRITE_WORKER_H
#define _FAST_FS_HASH_LZ4_DECOMPRESS_AND_WRITE_WORKER_H

#include "includes.h"
#include "FfshFile.h"
#include "AddonWorker.h"
#include <lz4.h>

namespace fast_fs_hash {

  class Lz4DecompressAndWriteWorker final : public AddonWorker {
   public:
    Lz4DecompressAndWriteWorker(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      std::string path,
      const uint8_t * compData,
      size_t compLen,
      uint32_t uncompSize,
      Napi::ObjectReference && inputRef) :
      AddonWorker(env, deferred),
      path_(std::move(path)),
      compData_(compData),
      compLen_(compLen),
      uncompSize_(uncompSize),
      inputRef_(std::move(inputRef)) {}

    void Execute() override {
      // Decompress first (before touching the file)
      uint8_t * outBuf = nullptr;
      if (this->uncompSize_ > 0) {
        // LZ4_decompress_safe takes int — reject sizes that would overflow.
        if (this->uncompSize_ > static_cast<uint32_t>(INT_MAX) ||
            this->compLen_ > static_cast<size_t>(INT_MAX)) [[unlikely]] {
          this->signal("lz4DecompressAndWrite: size exceeds INT_MAX");
          return;
        }

        outBuf = static_cast<uint8_t *>(malloc(this->uncompSize_));
        if (!outBuf) [[unlikely]] {
          this->signal("lz4DecompressAndWrite: out of memory");
          return;
        }

        const int result = LZ4_decompress_safe(
          reinterpret_cast<const char *>(this->compData_),
          reinterpret_cast<char *>(outBuf),
          static_cast<int>(this->compLen_),
          static_cast<int>(this->uncompSize_));

        if (result < 0 || static_cast<uint32_t>(result) != this->uncompSize_) [[unlikely]] {
          free(outBuf);
          this->signal("lz4DecompressAndWrite: decompression failed");
          return;
        }
      }

      FfshFile fh = FfshFile::open_rw(this->path_.c_str());
      if (!fh) [[unlikely]] {
        free(outBuf);
        this->signal("lz4DecompressAndWrite: failed to open file for writing");
        return;
      }

      // Truncate and seek to beginning
      if (!fh.truncate(0) || !fh.seek(0)) [[unlikely]] {
        free(outBuf);
        this->signal("lz4DecompressAndWrite: failed to truncate file");
        return;
      }

      // Write decompressed data
      if (this->uncompSize_ > 0 && outBuf) {
        if (!fh.write_all(outBuf, this->uncompSize_)) [[unlikely]] {
          free(outBuf);
          this->signal("lz4DecompressAndWrite: write error");
          return;
        }
      }
      free(outBuf);

      this->signal();
    }

    void OnOK() override { this->deferred.Resolve(Napi::Boolean::New(Napi::Env(this->env), true)); }

   private:
    std::string path_;
    const uint8_t * compData_;
    size_t compLen_;
    uint32_t uncompSize_;
    Napi::ObjectReference inputRef_;
  };

}  // namespace fast_fs_hash

#endif
