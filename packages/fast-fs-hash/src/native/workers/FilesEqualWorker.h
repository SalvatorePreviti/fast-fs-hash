/**
 * FilesEqualWorker: async worker that compares two files for byte-equality.
 *
 * Opens both files on the pool thread, compares sizes via fstat, then reads
 * both files in lockstep chunks and memcmps. Returns false if either file
 * cannot be opened/read or if sizes differ.
 *
 * Uses two half-buffers (64 KiB each) from the stack-allocated read buffer
 * to avoid any heap allocation on the hot path.
 */

#ifndef _FAST_FS_HASH_FILES_EQUAL_WORKER_H
#define _FAST_FS_HASH_FILES_EQUAL_WORKER_H

#include "includes.h"
#include "FfshFile.h"
#include "AddonWorker.h"

namespace fast_fs_hash {

  class FilesEqualWorker final : public AddonWorker {
   public:
    FilesEqualWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::string pathA, std::string pathB) :
      AddonWorker(env, deferred), pathA_(std::move(pathA)), pathB_(std::move(pathB)) {}

    static_assert(
      READ_BUFFER_SIZE <= ThreadPool::THREAD_STACK_SIZE - 64 * 1024,
      "read buffer exceeds pool thread usable stack");

    void Execute() override {
      // Open both files
      FfshFile fa(this->pathA_.c_str());
      if (!fa) [[unlikely]] {
        this->signal();
        return;
      }
      FfshFile fb(this->pathB_.c_str());
      if (!fb) [[unlikely]] {
        this->signal();
        return;
      }

      // Compare sizes via fstat
      const int64_t sizeA = fa.fsize();
      const int64_t sizeB = fb.fsize();
      if (sizeA < 0 || sizeB < 0 || sizeA != sizeB) [[unlikely]] {
        this->signal();
        return;
      }

      // Both empty → equal
      if (sizeA == 0) [[unlikely]] {
        this->result_ = true;
        this->signal();
        return;
      }

      // Split the stack buffer into two halves for interleaved reading
      alignas(64) uint8_t buf[READ_BUFFER_SIZE];
      static constexpr size_t HALF = READ_BUFFER_SIZE / 2;
      uint8_t * bufA = buf;
      uint8_t * bufB = buf + HALF;

      int64_t remaining = sizeA;
      while (remaining > 0) {
        const size_t toRead = remaining < static_cast<int64_t>(HALF) ? static_cast<size_t>(remaining) : HALF;

        const int64_t nA = fa.read_at_most(bufA, toRead);
        if (nA <= 0) [[unlikely]] {
          this->signal();
          return;
        }

        const int64_t nB = fb.read_at_most(bufB, static_cast<size_t>(nA));
        if (nB != nA) [[unlikely]] {
          this->signal();
          return;
        }

        if (memcmp(bufA, bufB, static_cast<size_t>(nA)) != 0) {
          this->signal();
          return;
        }

        remaining -= nA;
      }

      this->result_ = true;
      this->signal();
    }

    void OnOK() override { this->deferred.Resolve(Napi::Boolean::New(Napi::Env(this->env), this->result_)); }

   private:
    std::string pathA_;
    std::string pathB_;
    bool result_ = false;
  };

}  // namespace fast_fs_hash

#endif
