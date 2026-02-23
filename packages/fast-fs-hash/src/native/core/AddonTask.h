#ifndef _FAST_FS_HASH_ADDON_TASK_H
#define _FAST_FS_HASH_ADDON_TASK_H

#include "../includes.h"

namespace fast_fs_hash {

  /** Base class for tasks that can be queued on the ThreadPool or linked via CAS. */
  struct AddonTask {
    AddonTask * next_ = nullptr;
    virtual void run() noexcept = 0;
    virtual ~AddonTask() = default;
  };

}  // namespace fast_fs_hash

#endif
