#ifndef _FAST_FS_HASH_FORK_JOB_H
#define _FAST_FS_HASH_FORK_JOB_H

#include "AddonTask.h"

namespace fast_fs_hash {

  /**
   * CRTP fork-join job for the ThreadPool.
   *
   * Derive and implement:
   *   void forkWork() noexcept  — called by each forked thread
   *   void forkDone() noexcept  — called once when all threads complete
   *
   * MaxTasks sizes the internal task array — must accommodate both the initial
   * submit() count and any expand() calls. No virtual dispatch for forkWork/
   * forkDone — resolved at compile time via CRTP.
   *
   * Example:
   *   struct MyJob : ForkJob<MyJob, 8> {
   *     void forkWork() noexcept { ... }   // each thread
   *     void forkDone() noexcept { ... }   // last thread
   *   };
   */
  template <typename Derived, int MaxTasks>
  struct ForkJob {

    /** Per-slot task that dispatches to Derived::forkWork() via CRTP.
     *  The last thread to decrement remaining triggers Derived::forkDone(). */
    struct ForkTask : AddonTask {
      Derived * job;
      void run() noexcept override {
        Derived * j = this->job;
        j->forkWork();
        if (j->remaining.fetch_sub(1, std::memory_order_acq_rel) == 1) [[unlikely]] {
          j->forkDone();
        }
      }
    };

    static constexpr int MAX_TASKS = MaxTasks;

    /** Number of threads still running. When it reaches 0, forkDone() fires. */
    alignas(64) std::atomic<int> remaining{0};

    /** Next task slot for expand(). Equal to initial count after submit(). */
    std::atomic<int> nextSlot{0};

    /** Task slots — indexed [0..MaxTasks). Each slot is used by exactly one thread. */
    alignas(64) ForkTask tasks[MaxTasks];
  };

}  // namespace fast_fs_hash

#endif
