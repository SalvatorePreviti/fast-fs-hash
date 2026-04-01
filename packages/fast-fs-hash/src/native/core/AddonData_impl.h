/**
 * AddonData implementation. Include after AddonWorker.h.
 */

#ifndef _FAST_FS_HASH_ADDON_DATA_IMPL_H
#define _FAST_FS_HASH_ADDON_DATA_IMPL_H

#include "AddonWorker.h"

namespace fast_fs_hash {

  inline void AddonData::init(napi_env env) {
    auto * d = new (std::nothrow) AddonData();
    if (!d) [[unlikely]] {
      return;
    }

    auto * handle = new (std::nothrow) uv_async_t();
    if (!handle) [[unlikely]] {
      delete d;
      return;
    }

    uv_loop_t * loop;
    napi_get_uv_event_loop(env, &loop);
    handle->data = d;
    d->async = handle;
    uv_async_init(loop, handle, drain_cb_);
    uv_unref(reinterpret_cast<uv_handle_t *>(handle));

    napi_set_instance_data(env, d, nullptr, nullptr);
    napi_add_async_cleanup_hook(env, async_cleanup_hook_, d, nullptr);
  }

  inline void AddonData::drain_cb_(uv_async_t * handle) {
    auto * d = static_cast<AddonData *>(handle->data);

    AddonWorker * head = d->head.exchange(nullptr, std::memory_order_acquire);
    while (head) {
      auto * next = static_cast<AddonWorker *>(head->next_);
      Napi::Env env(head->env);
      Napi::HandleScope scope(env);
      if (head->error_) {
        head->OnError(Napi::Error::New(env, head->error_));
      } else {
        head->OnOK();
      }
      d->unref_pending();
      delete head;
      head = next;
    }
  }

  inline void AddonData::async_cleanup_hook_(napi_async_cleanup_hook_handle hook, void * data) {
    auto * d = static_cast<AddonData *>(data);

    d->pool.shutdown();

    AddonWorker * head = d->head.exchange(nullptr, std::memory_order_acquire);
    while (head) {
      auto * next = static_cast<AddonWorker *>(head->next_);
      delete head;
      head = next;
    }

    // Release any cache locks still held by this env (e.g., worker thread terminated)
    {
      std::lock_guard<std::mutex> guard(d->heldCacheLocksMutex);
      for (CacheLockHandle h : d->heldCacheLocks) {
        FfshFile::release_lock_handle(h);
      }
      d->heldCacheLocks.clear();
    }

    d->cleanup_hook_ = hook;
    uv_close(reinterpret_cast<uv_handle_t *>(d->async), on_async_close_);
  }

  inline void AddonData::on_async_close_(uv_handle_t * handle) {
    auto * d = static_cast<AddonData *>(handle->data);
    delete reinterpret_cast<uv_async_t *>(handle);
    auto hook = d->cleanup_hook_;
    delete d;
    napi_remove_async_cleanup_hook(hook);
  }

}  // namespace fast_fs_hash

#endif
