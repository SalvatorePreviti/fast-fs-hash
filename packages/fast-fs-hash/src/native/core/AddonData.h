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
#include <unordered_map>

namespace fast_fs_hash {

  class AddonWorker;

  struct AddonData {
    ThreadPool pool;
    uv_async_t * async;
    std::atomic<AddonWorker *> head{nullptr};
    std::atomic<int> pending{0};
    napi_async_cleanup_hook_handle cleanup_hook_ = nullptr;

    /** RAII file handles held by JS for this env — closed on cleanup or erase.
     *  All operations are JS-thread-only (register in OnOK, take/close in binding/close). */
    std::unordered_map<int32_t, FfshFile> heldFiles;

    /** Register a locked file, transferring ownership to this map. JS thread only.
     *  Returns the raw fd value (for embedding in the JS-side header). */
    int32_t registerHeldFile(FfshFile && f) noexcept {
      const int32_t key = static_cast<int32_t>(f.fd);
      if (key < 0) [[unlikely]] return FFSH_FILE_HANDLE_INVALID;
      this->heldFiles.emplace(key, std::move(f));
      return key;
    }

    /** Take ownership of a held file back from JS (e.g. before passing to CacheWriter).
     *  Returns the FfshFile (caller owns it). JS thread only. */
    FfshFile takeHeldFile(int32_t key) noexcept {
      FfshFile result;
      if (key == FFSH_FILE_HANDLE_INVALID) [[unlikely]] return result;
      auto it = this->heldFiles.find(key);
      if (it != this->heldFiles.end()) {
        result = std::move(it->second);
        this->heldFiles.erase(it);
      }
      return result;
    }

    /** Close and unregister a held file. JS thread only. */
    void closeHeldFile(int32_t key) noexcept {
      if (key == FFSH_FILE_HANDLE_INVALID) [[unlikely]] return;
      this->heldFiles.erase(key);  // FfshFile destructor closes the fd
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
