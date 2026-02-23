/**
 * AddonData: per-addon-instance state. One per napi_env.
 *
 * Uses a raw uv_async_t for pool→JS completion signaling.
 * The handle is ref'd while AddonWorkers are in-flight so the
 * event loop stays alive until all results are delivered.
 */

#ifndef _FAST_FS_HASH_ADDON_DATA_H
#define _FAST_FS_HASH_ADDON_DATA_H

#include "ThreadPool.h"
#include <uv.h>
#include <mutex>
#include <vector>

namespace fast_fs_hash {

  class AddonWorker;
  struct ProcessLockHandle;

  struct AddonData {
    ThreadPool pool;
    uv_async_t * async;
    std::atomic<AddonWorker *> head{nullptr};
    std::atomic<int> pending{0};
    napi_async_cleanup_hook_handle cleanup_hook_ = nullptr;

    /** Held process locks for this env — released on cleanup. Protected by heldLocksMutex. */
    std::mutex heldLocksMutex;
    std::vector<ProcessLockHandle *> heldLocks;

    /** Register a held lock for cleanup on env teardown. */
    void registerHeldLock(ProcessLockHandle * h) noexcept {
      std::lock_guard<std::mutex> guard(this->heldLocksMutex);
      this->heldLocks.push_back(h);
    }

    /** Unregister a held lock (called on explicit release). */
    void unregisterHeldLock(ProcessLockHandle * h) noexcept {
      std::lock_guard<std::mutex> guard(this->heldLocksMutex);
      auto & v = this->heldLocks;
      for (size_t i = 0; i < v.size(); ++i) {
        if (v[i] == h) {
          v[i] = v.back();
          v.pop_back();
          return;
        }
      }
    }

    static FSH_FORCE_INLINE AddonData * get(napi_env env) noexcept {
      void * data = nullptr;
      napi_get_instance_data(env, &data);
      return static_cast<AddonData *>(data);
    }

    static void init(napi_env env);

    FSH_FORCE_INLINE void ref_pending() noexcept {
      if (this->pending.fetch_add(1, std::memory_order_relaxed) == 0) {
        uv_ref(reinterpret_cast<uv_handle_t *>(this->async));
      }
    }

    FSH_FORCE_INLINE void unref_pending() noexcept {
      if (this->pending.fetch_sub(1, std::memory_order_relaxed) == 1) {
        uv_unref(reinterpret_cast<uv_handle_t *>(this->async));
      }
    }

   private:
    static void drain_cb_(uv_async_t * handle);
    static void async_cleanup_hook_(napi_async_cleanup_hook_handle hook, void * data);
    static void on_async_close_(uv_handle_t * handle);
  };

}  // namespace fast_fs_hash

#endif
