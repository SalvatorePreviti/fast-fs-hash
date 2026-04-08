#ifndef _FAST_FS_HASH_CACHE_WAIT_UNLOCKED_H
#define _FAST_FS_HASH_CACHE_WAIT_UNLOCKED_H

#include "AddonWorker.h"

namespace fast_fs_hash {

  /**
   * Blocks a pool thread until the cache file is no longer exclusively locked.
   *
   * POSIX: blocking flock(LOCK_SH) (kernel blocks, zero CPU) without cancel; poll_lock_ with cancel.
   * Win32: LockFileEx shared lock with overlapped I/O + CancelIoEx for cancel.
   * Resolves true if unlocked, false on timeout or shutdown.
   */
  class CacheWaitUnlocked final : public AddonWorker {
   public:
    CacheWaitUnlocked(
      Napi::Env env,
      Napi::Promise::Deferred deferred,
      const char * cachePath,
      int timeoutMs,
      const volatile uint8_t * cancelByte = nullptr,
      Napi::ObjectReference && cancelRef = {}) :
      AddonWorker(env, deferred),
      timeoutMs_(timeoutMs),
      cachePath_(cachePath),
      cancelRef_(std::move(cancelRef)) {
      this->cancel_.cancelByte_ = cancelByte;
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.add(&this->cancel_);
      }
    }

    ~CacheWaitUnlocked() override {
      AddonData * d = this->addon;
      if (d) {
        d->active_cancels.remove(&this->cancel_);
      }
      this->cancel_.fire();
    }

    void Execute() override {
      if (this->cancel_.is_fired() || this->addon->pool.is_shutdown()) [[unlikely]] {
        this->signal();
        return;
      }
      this->result_ = FfshFile::wait_unlocked(this->cachePath_, this->timeoutMs_, &this->cancel_);
      this->signal();
    }

    void OnOK() override {
      this->deferred.Resolve(Napi::Boolean::New(Napi::Env(this->env), this->result_));
    }

   private:
    // ── Pool-thread fields ──────────────────────────────────────────────
    int timeoutMs_;
    bool result_ = false;
    const char * cachePath_;  // Points into stateBuf (pinned by cancelRef_)
    FfshFile::LockCancel cancel_;

    // ── JS-thread-only fields ───────────────────────────────────────────
    Napi::ObjectReference cancelRef_;
  };

}  // namespace fast_fs_hash

#endif
