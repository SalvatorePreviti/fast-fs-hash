#ifndef _FAST_FS_HASH_ADDON_TASK_H
#define _FAST_FS_HASH_ADDON_TASK_H

#include "../includes.h"

namespace fast_fs_hash {

  /** Base class for tasks queued on the ThreadPool.
   *  Provides an intrusive next_ pointer for the spinlock-guarded FIFO queue
   *  and a virtual run() method called by the worker thread. */
  struct AddonTask {
    AddonTask * next_ = nullptr;

    /** Execute this task on a worker thread. Must not throw. */
    virtual void run() noexcept = 0;
    virtual ~AddonTask() = default;
  };

}  // namespace fast_fs_hash

#endif
