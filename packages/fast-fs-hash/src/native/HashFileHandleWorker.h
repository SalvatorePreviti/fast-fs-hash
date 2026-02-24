/**
 * Async worker that hashes a file given an already-open file descriptor.
 *
 * Similar to HashFileWorker but takes an fd (int / HANDLE) instead of a
 * path, avoiding the cost of opening the file again.  The caller is
 * responsible for keeping the fd valid until the worker completes and
 * for closing it afterwards.
 *
 * Supports:
 *  - Optional external output buffer (writes 16-byte digest at offset)
 *  - One-shot fast path for small files (< 128 KiB)
 *
 * No salt support — this worker is designed for the fast-path cache
 * invalidation use case where salt is not needed.
 */

#ifndef _FAST_FS_HASH_HASH_FILE_HANDLE_WORKER_H
#define _FAST_FS_HASH_HASH_FILE_HANDLE_WORKER_H

#include "includes.h"
#include "AlignedPtr.h"

class HashFileHandleWorker final : public Napi::AsyncWorker {
 public:
#ifndef _WIN32
  using NativeFd = int;
  static constexpr NativeFd INVALID_FD = -1;
#else
  using NativeFd = HANDLE;
  static constexpr NativeFd INVALID_FD = INVALID_HANDLE_VALUE;
#endif

  HashFileHandleWorker(Napi::Env env, Napi::Promise::Deferred deferred, NativeFd fd, uint64_t seed) :
    Napi::AsyncWorker(env), deferred_(deferred), fd_(fd), seed_(seed) {}

  /** Hold a reference to the JS FileHandle object to prevent GC
   *  from closing the fd while async work is in progress. */
  void set_fh_ref(Napi::ObjectReference ref) { this->fh_ref_ = std::move(ref); }

  /** Attach an externally-owned output buffer — digest written at `data`. */
  void set_external_output(uint8_t * data, Napi::ObjectReference ref) {
    this->output_data_ = data;
    this->output_ref_ = std::move(ref);
    this->has_external_ = true;
  }

  void Execute() override {
    if (this->fd_ == INVALID_FD) [[unlikely]] {
      SetError("hashFileHandle: invalid file descriptor");
      return;
    }

    AlignedPtr<uint8_t> rbuf(64, fast_fs_hash::READ_BUFFER_SIZE);
    if (!rbuf) [[unlikely]] {
      SetError("hashFileHandle: out of memory");
      return;
    }

    // Try one-shot read (fast path for small files).
    const int64_t n = do_read(this->fd_, rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE, 0);
    if (n < 0) [[unlikely]] {
      SetError("hashFileHandle: read error");
      return;
    }

    const size_t bytes = static_cast<size_t>(n);
    if (bytes < fast_fs_hash::READ_BUFFER_SIZE) [[likely]] {
      // Entire file in one read — one-shot hash (fast path).
      XXH128_canonicalFromHash(
        reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_withSeed(rbuf.ptr, bytes, this->seed_));
    } else {
      // Large file — streaming with positional reads.
      XXH3_state_t state;
      XXH3_128bits_reset_withSeed(&state, this->seed_);
      XXH3_128bits_update(&state, rbuf.ptr, bytes);

      int64_t file_offset = static_cast<int64_t>(bytes);
      for (;;) {
        const int64_t n2 = do_read(this->fd_, rbuf.ptr, fast_fs_hash::READ_BUFFER_SIZE, file_offset);
        if (n2 <= 0) [[unlikely]] {
          if (n2 < 0) {
            SetError("hashFileHandle: read error");
            return;
          }
          break;
        }
        XXH3_128bits_update(&state, rbuf.ptr, static_cast<size_t>(n2));
        file_offset += n2;
      }

      XXH128_canonicalFromHash(reinterpret_cast<XXH128_canonical_t *>(this->digest_), XXH3_128bits_digest(&state));
    }

    // Write to external output if provided.
    if (this->has_external_) {
      memcpy(this->output_data_, this->digest_, 16);
    }
  }

  void OnOK() override {
    auto env = Env();
    Napi::HandleScope scope(env);
    if (this->has_external_) {
      this->deferred_.Resolve(this->output_ref_.Value());
    } else {
      this->deferred_.Resolve(Napi::Buffer<uint8_t>::Copy(env, this->digest_, 16));
    }
  }

  void OnError(const Napi::Error & error) override { this->deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  NativeFd fd_;
  uint64_t seed_;

  Napi::ObjectReference fh_ref_;  // prevents GC of the JS FileHandle
  uint8_t * output_data_ = nullptr;
  Napi::ObjectReference output_ref_;
  bool has_external_ = false;

  uint8_t digest_[16] = {};

  // Positional read wrapper — returns bytes read, or -1 on error.
#ifndef _WIN32
  static int64_t do_read(NativeFd fd, void * buf, size_t len, int64_t offset) {
    for (;;) {
      ssize_t n = ::pread(fd, buf, len, static_cast<off_t>(offset));
      if (n >= 0) [[likely]]
        return static_cast<int64_t>(n);
      if (errno == EINTR) [[likely]]
        continue;
      return -1;
    }
  }
#else
  static int64_t do_read(NativeFd fd, void * buf, size_t len, int64_t offset) {
    OVERLAPPED ov = {};
    ov.Offset = static_cast<DWORD>(static_cast<uint64_t>(offset));
    ov.OffsetHigh = static_cast<DWORD>(static_cast<uint64_t>(offset) >> 32);
    DWORD to_read = len > 0x7FFFFFFFu ? 0x7FFFFFFFu : static_cast<DWORD>(len);
    DWORD bytes_read = 0;
    if (!ReadFile(fd, buf, to_read, &bytes_read, &ov)) [[unlikely]] {
      if (GetLastError() == ERROR_HANDLE_EOF) return 0;
      return -1;
    }
    return static_cast<int64_t>(bytes_read);
  }
#endif
};

#endif
