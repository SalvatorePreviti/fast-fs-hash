/**
 * AddonWorker: async work with completion signaled back to the JS thread.
 *
 * Subclasses implement:
 *   Execute() — runs on a worker thread, must call signal() when complete.
 *   OnOK() — runs on the JS thread after successful completion.
 *
 * IMPORTANT: After signal(), `this` may be deleted by the JS thread
 * at any time. Do not access any member after calling it.
 *
 * Two ways to run:
 *   Queue()            — on the compute ThreadPool (for CPU-bound work).
 *   QueueDetached(sz)  — on a dedicated thread with custom stack size
 *                         (for blocking I/O or lock waits — does not
 *                         consume a pool thread).
 */

#ifndef _FAST_FS_HASH_ADDON_WORKER_H
#define _FAST_FS_HASH_ADDON_WORKER_H

#include "AddonData.h"
#include "spawn-thread.h"

namespace fast_fs_hash {

  class AddonWorker : public AddonTask {
   public:
    AddonWorker(Napi::Env pEnv, Napi::Promise::Deferred pDeferred) noexcept
      : deferred(pDeferred), addon(AddonData::get(pEnv)), env(pEnv) {}

    /** Queue on the compute thread pool. */
    void Queue() {
      auto * d = this->addon;
      if (!d) [[unlikely]] {
        delete this;
        return;
      }
      d->ref_pending();
      d->pool.enqueue(*this);
    }

    /** Spawn a dedicated detached thread with the given stack size. */
    void QueueDetached(size_t stackSize) {
      auto * d = this->addon;
      if (!d) [[unlikely]] {
        delete this;
        return;
      }
      d->ref_pending();
      if (spawnDetachedThread(detachedEntry_, this, stackSize)) [[likely]] {
        return;
      }
      // Thread creation failed — signal error instead of blocking the JS thread
      this->signal("QueueDetached: failed to spawn thread");
    }

    void run() noexcept override {
      this->Execute();
    }

   protected:
    Napi::Promise::Deferred deferred;
    AddonData * addon;
    napi_env env;

    virtual void Execute() = 0;
    virtual void OnOK() = 0;

    /** Signal successful completion. `this` may be deleted after this call. */
    void signal() {
      auto * d = this->addon;
      if (!d) [[unlikely]] {
        delete this;
        return;
      }

      AddonWorker * head = d->head.load(std::memory_order_relaxed);
      for (;;) {
        this->next_ = head;
        if (d->head.compare_exchange_weak(head, this,
            std::memory_order_release, std::memory_order_relaxed)) [[likely]] {
          break;
        }
        cpu_pause();
      }

      uv_async_send(d->async);
    }

    /** Signal error + completion. `this` may be deleted after this call. */
    void signal(const char * error) {
      this->error_ = error;
      this->signal();
    }

   private:
    friend struct AddonData;

    const char * error_ = nullptr;

    void OnError(const Napi::Error & e) {
      this->deferred.Reject(e.Value());
    }

    static
#ifdef _WIN32
    unsigned __stdcall
#else
    void *
#endif
    detachedEntry_(void * arg) {
      static_cast<AddonWorker *>(arg)->Execute();
#ifdef _WIN32
      return 0;
#else
      return nullptr;
#endif
    }
  };

}  // namespace fast_fs_hash

#endif
