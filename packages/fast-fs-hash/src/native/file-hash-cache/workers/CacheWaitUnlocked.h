/**
 * CacheWaitUnlocked — blocks a pool thread until the cache file is no longer
 * exclusively locked.
 *
 * POSIX: uses F_SETLKW (kernel blocks, zero CPU) — cancelled via fd-close (EBADF).
 * Win32: uses LockFileEx shared lock with overlapped I/O.
 * Resolves true if unlocked, false on timeout or shutdown.
 */

#ifndef _FAST_FS_HASH_CACHE_WAIT_UNLOCKED_H
#define _FAST_FS_HASH_CACHE_WAIT_UNLOCKED_H

#include "AddonWorker.h"

namespace fast_fs_hash {

  class CacheWaitUnlocked final : public AddonWorker {
   public:
    CacheWaitUnlocked(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      std::string cachePath,
      int timeoutMs,
      const volatile uint8_t * cancelByte = nullptr,
      Napi::ObjectReference && cancelRef = {}) :
      AddonWorker(env, deferred),
      timeoutMs_(timeoutMs),
      cachePath_(std::move(cachePath)),
      cancelRef_(std::move(cancelRef)) {
      this->cancel_.cancelByte_ = cancelByte;
    }

    ~CacheWaitUnlocked() override { this->cancel_.fire(); }

    void Execute() override {
      this->result_ = FfshFile::wait_unlocked(this->cachePath_.c_str(), this->timeoutMs_, &this->cancel_);
      this->signal();
    }

    void OnOK() override { this->deferred.Resolve(Napi::Boolean::New(Napi::Env(this->env), this->result_)); }

   private:
    // ── Pool-thread fields ──────────────────────────────────────────────
    int timeoutMs_;
    bool result_ = false;
    std::string cachePath_;
    FfshFile::LockCancel cancel_;

    // ── JS-thread-only fields ───────────────────────────────────────────
    Napi::ObjectReference cancelRef_;
  };

}  // namespace fast_fs_hash

#endif
