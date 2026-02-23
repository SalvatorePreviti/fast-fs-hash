#ifndef _FAST_FS_HASH_PROCESS_LOCK_WORKER_H
#define _FAST_FS_HASH_PROCESS_LOCK_WORKER_H

#include "../io/ProcessLock.h"
#include "../core/AddonWorker.h"

namespace fast_fs_hash {

  /** Async lock worker — runs on a dedicated detached thread via QueueDetached. */
  class ProcessLockWorker final : public AddonWorker {
   public:
    inline ProcessLockWorker(
      napi_env env, Napi::Promise::Deferred deferred, const char * shmName, int timeoutMs
    ) : AddonWorker(env, deferred), timeoutMs_(timeoutMs) {
      memcpy(this->shmName_, shmName, sizeof(this->shmName_));
    }

    inline void Start() {
      this->QueueDetached(PROCESS_LOCK_STACK_SIZE);
    }

   protected:
    inline void Execute() override {
      const char * error = nullptr;
      this->handle_ = processLockAcquire(this->shmName_, this->timeoutMs_, error);
      if (error) {
        this->signal(error);
      } else {
        this->signal();
      }
    }

    inline void OnOK() override {
      Napi::HandleScope scope(this->env);
      this->addon->registerHeldLock(this->handle_);
      auto ext = Napi::External<ProcessLockHandle>::New(this->env, this->handle_);
      this->deferred.Resolve(ext);
    }

   private:
    char shmName_[28];
    int timeoutMs_;
    ProcessLockHandle * handle_ = nullptr;
  };

}  // namespace fast_fs_hash

#endif
