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
#include "../io/FfshFile.h"
#include <uv.h>
#include <mutex>
#include <unordered_set>

namespace fast_fs_hash {

  class AddonWorker;

  struct AddonData {
    ThreadPool pool;
    uv_async_t * async;
    std::atomic<AddonWorker *> head{nullptr};
    std::atomic<int> pending{0};
    napi_async_cleanup_hook_handle cleanup_hook_ = nullptr;

    /** Held file handles for this env — released on cleanup. Protected by heldFileHandlesMutex. */
    std::mutex heldFileHandlesMutex;
    std::unordered_set<FfshFileHandle> heldFileHandles;

    /** Register a held file handle for cleanup on env teardown. */
    void registerHeldFileHandle(FfshFileHandle h) noexcept {
      std::lock_guard<std::mutex> guard(this->heldFileHandlesMutex);
      this->heldFileHandles.insert(h);
    }

    /** Unregister a held file handle (called on explicit close). */
    void unregisterHeldFileHandle(FfshFileHandle h) noexcept {
      std::lock_guard<std::mutex> guard(this->heldFileHandlesMutex);
      this->heldFileHandles.erase(h);
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
