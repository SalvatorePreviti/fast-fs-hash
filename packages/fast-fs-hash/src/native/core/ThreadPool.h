/**
 * ThreadPool: per-addon-instance thread pool.
 *
 * Threads spawn on demand and stay alive until shutdown().
 * shutdown() sets the flag, wakes all, joins all.
 *
 * APIs:
 *   enqueue(Task&) — run a single Task on a pool thread.
 *   submit(n, fn, arg, on_done, done_arg) — fork n threads calling fn(arg),
 *     then call on_done(done_arg) when all n complete. Returns a Job handle.
 *   expand(job, n) — add n more threads to a running job (thread-safe).
 */

#ifndef _FAST_FS_HASH_THREAD_POOL_H
#define _FAST_FS_HASH_THREAD_POOL_H

#include "AddonTask.h"
#include "FshSemaphore.h"

#ifdef _WIN32
#  include <process.h>
#else
#  include <pthread.h>
#endif

#include <mutex>

namespace fast_fs_hash {

  class ThreadPool : NonCopyable {
   public:
    static constexpr int MAX_WORKERS = 32;
    static constexpr size_t THREAD_STACK_SIZE = 256 * 1024;
    static constexpr int IDLE_TIMEOUT_MS = 15000;

    using Task = AddonTask;

    /** Opaque handle to a running fork job. Used with expand(). */
    struct Job;

    ThreadPool() = default;
    ~ThreadPool() { this->shutdown(); }

    static FSH_FORCE_INLINE unsigned hardware_concurrency() noexcept {
      static const unsigned hw = [] {
#ifdef _WIN32
        SYSTEM_INFO si;
        GetSystemInfo(&si);
        return static_cast<unsigned>(si.dwNumberOfProcessors);
#else
        long n = sysconf(_SC_NPROCESSORS_ONLN);
        return n > 0 ? static_cast<unsigned>(n) : 1u;
#endif
      }();
      return hw;
    }

    static inline int compute_threads(int concurrency, size_t work_count,
                                      int max_threads, size_t min_per_thread) noexcept {
      int hw = static_cast<int>(hardware_concurrency());
      if (hw < 2) [[unlikely]] { hw = 2; }
      int tc = concurrency > 0 ? concurrency : hw;
      if (tc > max_threads) { tc = max_threads; }
      if (tc > MAX_WORKERS) [[unlikely]] { tc = MAX_WORKERS; }
      int by_work = static_cast<int>((work_count + min_per_thread - 1) / min_per_thread);
      if (tc > by_work) { tc = by_work; }
      if (tc < 1) [[unlikely]] { tc = 1; }
      return tc;
    }

    /** Type-safe submit: returns a Job handle for expand(). */
    template <typename T>
    Job * submit(int count, void (*fn)(T *), T * arg,
                void (*on_done)(T *), T * done_arg) noexcept {
      return this->submit(count,
        reinterpret_cast<void (*)(void *)>(fn), static_cast<void *>(arg),
        reinterpret_cast<void (*)(void *)>(on_done), static_cast<void *>(done_arg));
    }

    Job * submit(int count, void (*fn)(void *), void * arg,
                void (*on_done)(void *), void * done_arg) noexcept {
      if (count <= 0) [[unlikely]] {
        if (on_done) { on_done(done_arg); }
        return nullptr;
      }
      this->ensure_threads_(count);

      auto * group = this->alloc_fork_group_();
      group->remaining.store(count, std::memory_order_relaxed);
      group->nextSlot.store(count, std::memory_order_relaxed);
      group->fn = fn;
      group->arg = arg;
      group->done_fn = on_done;
      group->done_arg = done_arg;

      for (int i = 0; i < count; ++i) {
        group->tasks[i].group = group;
        this->push_task_(&group->tasks[i]);
      }
      this->wake_n_(count);
      return reinterpret_cast<Job *>(group);
    }

    /** Add more threads to a running job. Thread-safe — callable from pool threads.
     *  Clamped to min(MAX_WORKERS, hardware_concurrency()). Returns count added. */
    int expand(Job * job, int additional) noexcept {
      if (!job || additional <= 0) { return 0; }
      auto * group = reinterpret_cast<ForkGroup *>(job);
      const int maxSlots = max_threads_();

      int added = 0;
      for (int i = 0; i < additional; ++i) {
        const int slot = group->nextSlot.fetch_add(1, std::memory_order_relaxed);
        if (slot >= maxSlots) {
          group->nextSlot.store(maxSlots, std::memory_order_relaxed);
          break;
        }
        group->tasks[slot].group = group;
        group->remaining.fetch_add(1, std::memory_order_relaxed);
        this->push_task_(&group->tasks[slot]);
        ++added;
      }

      if (added > 0) {
        this->ensure_threads_(group->nextSlot.load(std::memory_order_relaxed));
        this->wake_n_(added);
      }
      return added;
    }

    void enqueue(Task & task) noexcept {
      this->ensure_threads_(1);
      this->push_task_(&task);
      this->wake_.post();
    }

    void shutdown() noexcept {
      if (this->shutdown_.load(std::memory_order_relaxed)) { return; }
      this->shutdown_.store(true, std::memory_order_release);

      std::lock_guard<std::mutex> lock(this->mu_);
      for (int i = 0; i < this->thread_count_; ++i) {
        this->wake_.post();
      }

      for (int i = 0; i < this->thread_count_; ++i) {
#ifdef _WIN32
        WaitForSingleObject(this->handles_[i], INFINITE);
        CloseHandle(this->handles_[i]);
#else
        pthread_join(this->threads_[i], nullptr);
#endif
      }
      this->thread_count_ = 0;
    }

    FSH_FORCE_INLINE bool is_shutdown() const noexcept {
      return this->shutdown_.load(std::memory_order_relaxed);
    }

   private:

    // ── Fork group ──

    struct ForkGroup;

    struct ForkTask : Task {
      ForkGroup * group;
      void run() noexcept override;
    };

    struct alignas(64) ForkGroup {
      std::atomic<int> remaining{0};
      std::atomic<int> nextSlot{0};
      void (*fn)(void *) = nullptr;
      void * arg = nullptr;
      void (*done_fn)(void *) = nullptr;
      void * done_arg = nullptr;
      std::atomic<bool> in_use{false};
      ForkTask tasks[MAX_WORKERS];
    };

    static constexpr int MAX_FORK_GROUPS = 8;

    // ── State ──

    alignas(64) std::atomic<Task *> queue_head_{nullptr};
    alignas(64) Semaphore wake_;
    alignas(64) std::mutex mu_;
    std::atomic<bool> shutdown_{false};
    int thread_count_ = 0;
#ifdef _WIN32
    HANDLE handles_[MAX_WORKERS]{};
#else
    pthread_t threads_[MAX_WORKERS]{};
#endif
    ForkGroup groups_[MAX_FORK_GROUPS];

    static FSH_FORCE_INLINE int max_threads_() noexcept {
      static const int v = [] {
        int hw = static_cast<int>(hardware_concurrency());
        if (hw < 2) [[unlikely]] { hw = 2; }
        return hw < MAX_WORKERS ? hw : MAX_WORKERS;
      }();
      return v;
    }

    // ── Lock-free LIFO task queue ──

    void push_task_(Task * task) noexcept {
      Task * head = this->queue_head_.load(std::memory_order_relaxed);
      for (;;) {
        task->next_ = head;
        if (this->queue_head_.compare_exchange_weak(head, task,
            std::memory_order_release, std::memory_order_relaxed)) [[likely]] {
          return;
        }
        cpu_pause();
      }
    }

    Task * pop_task_() noexcept {
      Task * head = this->queue_head_.load(std::memory_order_acquire);
      while (head) {
        if (this->queue_head_.compare_exchange_weak(head, head->next_,
            std::memory_order_acq_rel)) [[likely]] {
          return head;
        }
        cpu_pause();
      }
      return nullptr;
    }

    void wake_n_(int n) noexcept {
      for (int i = 0; i < n; ++i) {
        this->wake_.post();
      }
    }

    // ── Fork group allocation ──

    ForkGroup * alloc_fork_group_() noexcept {
      for (;;) {
        for (int i = 0; i < MAX_FORK_GROUPS; ++i) {
          bool expected = false;
          if (this->groups_[i].in_use.compare_exchange_strong(expected, true,
              std::memory_order_acquire)) {
            return &this->groups_[i];
          }
        }
        cpu_pause();
      }
    }

    static void release_fork_group_(ForkGroup * group) noexcept {
      group->in_use.store(false, std::memory_order_release);
    }

    // ── Thread management ──

    FSH_FORCE_INLINE void ensure_threads_(int needed) noexcept {
      if (this->thread_count_ >= needed) [[likely]] { return; }
      this->grow_(needed);
    }

    FSH_NO_INLINE void grow_(int needed) noexcept {
      if (this->shutdown_.load(std::memory_order_acquire)) { return; }

      std::lock_guard<std::mutex> lock(this->mu_);
      int target = needed < max_threads_() ? needed : max_threads_();
      if (this->thread_count_ >= target) { return; }

#ifndef _WIN32
      pthread_attr_t attr;
      pthread_attr_init(&attr);
      pthread_attr_setstacksize(&attr, THREAD_STACK_SIZE);
#endif

      while (this->thread_count_ < target) {
#ifdef _WIN32
        uintptr_t h = _beginthreadex(nullptr, static_cast<unsigned>(THREAD_STACK_SIZE),
          thread_entry_, this, 0, nullptr);
        if (!h) [[unlikely]] { break; }
        this->handles_[this->thread_count_] = reinterpret_cast<HANDLE>(h);
#else
        if (pthread_create(&this->threads_[this->thread_count_], &attr, thread_entry_, this) != 0) [[unlikely]] { break; }
#endif
        this->thread_count_++;
      }

#ifndef _WIN32
      pthread_attr_destroy(&attr);
#endif
    }

    // ── Worker loop ──

    static FSH_NO_INLINE void worker_loop_(ThreadPool * pool) noexcept {
      for (;;) {
        Task * task = pool->pop_task_();
        if (task) [[likely]] {
          task->run();
          continue;
        }

        if (pool->shutdown_.load(std::memory_order_acquire)) [[unlikely]] { return; }

        if (!pool->wake_.wait_for_ms(IDLE_TIMEOUT_MS)) [[unlikely]] {
          if (pool->shutdown_.load(std::memory_order_acquire)) [[unlikely]] { return; }
          continue;
        }

        if (pool->shutdown_.load(std::memory_order_acquire)) [[unlikely]] { return; }
      }
    }

#ifdef _WIN32
    static unsigned __stdcall thread_entry_(void * raw) {
      worker_loop_(static_cast<ThreadPool *>(raw));
      return 0;
    }
#else
    static void * thread_entry_(void * raw) {
      worker_loop_(static_cast<ThreadPool *>(raw));
      return nullptr;
    }
#endif
  };

  inline void ThreadPool::ForkTask::run() noexcept {
    auto * g = this->group;
    g->fn(g->arg);
    if (g->remaining.fetch_sub(1, std::memory_order_acq_rel) == 1) [[unlikely]] {
      auto done_fn = g->done_fn;
      auto done_arg = g->done_arg;
      release_fork_group_(g);
      if (done_fn) { done_fn(done_arg); }
    }
  }

}  // namespace fast_fs_hash

#endif
