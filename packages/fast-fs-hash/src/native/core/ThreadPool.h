/**
 * ThreadPool: per-addon-instance thread pool.
 *
 * Threads spawn on demand and self-terminate after IDLE_TIMEOUT_MS of inactivity.
 * shutdown() sets the flag, wakes all, joins all.
 * trim() wakes idle threads so they can check and exit if no work is pending.
 *
 * APIs:
 *   enqueue(Task&) — run a single Task on a pool thread.
 *   submit(n, fn, arg, on_done, done_arg) — fork n threads calling fn(arg),
 *     then call on_done(done_arg) when all n complete. Returns a Job handle.
 *   expand(job, n) — add n more threads to a running job (thread-safe).
 *   trim() — wake idle threads; those with no work self-terminate.
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
    static constexpr int DEFAULT_IDLE_TIMEOUT_MS = 15000;

    /** Thread idle timeout in ms. Read once from FAST_FS_HASH_POOL_IDLE_TIMEOUT_MS env var. */
    static inline int idle_timeout_ms() noexcept {
      static const int v = [] {
        const char * env = std::getenv("FAST_FS_HASH_POOL_IDLE_TIMEOUT_MS");
        if (env && env[0] != '\0') {
          const long val = std::strtol(env, nullptr, 10);
          if (val > 0 && val <= 3600000) {
            return static_cast<int>(val);
          }
        }
        return DEFAULT_IDLE_TIMEOUT_MS;
      }();
      return v;
    }

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

    static inline int compute_threads(int concurrency, size_t work_count, int max_threads, size_t min_per_thread) noexcept {
      int hw = static_cast<int>(hardware_concurrency());
      if (hw < 2) [[unlikely]] {
        hw = 2;
      }
      int tc = concurrency > 0 ? concurrency : hw;
      if (tc > max_threads) {
        tc = max_threads;
      }
      if (tc > MAX_WORKERS) [[unlikely]] {
        tc = MAX_WORKERS;
      }
      int by_work = static_cast<int>((work_count + min_per_thread - 1) / min_per_thread);
      if (tc > by_work) {
        tc = by_work;
      }
      if (tc < 1) [[unlikely]] {
        tc = 1;
      }
      return tc;
    }

    /** Type-safe submit: returns a Job handle for expand(). */
    template <typename T>
    Job * submit(int count, void (*fn)(T *), T * arg, void (*on_done)(T *), T * done_arg) noexcept {
      return this->submit(
        count,
        reinterpret_cast<void (*)(void *)>(fn),
        static_cast<void *>(arg),
        reinterpret_cast<void (*)(void *)>(on_done),
        static_cast<void *>(done_arg));
    }

    Job * submit(int count, void (*fn)(void *), void * arg, void (*on_done)(void *), void * done_arg) noexcept {
      if (count <= 0) [[unlikely]] {
        if (on_done) {
          on_done(done_arg);
        }
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
      if (!job || additional <= 0) {
        return 0;
      }
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

    /** Wake idle threads so they can exit if no work is pending. Not a shutdown.
     *  Increments the trim generation; idle threads that see a new generation exit. */
    void trim() noexcept {
      if (this->state_.load(std::memory_order_relaxed) == STATE_SHUTDOWN) {
        return;
      }
      std::lock_guard<std::mutex> lock(this->mu_);
      this->trim_gen_.fetch_add(1, std::memory_order_release);
      for (int i = 0; i < this->thread_count_; ++i) {
        this->wake_.post();
      }
    }

    void shutdown() noexcept {
      uint32_t expected = STATE_RUNNING;
      if (!this->state_.compare_exchange_strong(expected, STATE_SHUTDOWN, std::memory_order_acq_rel)) {
        return;
      }

      // Snapshot thread count and handles under lock, then join outside lock.
      int count;
#ifdef _WIN32
      HANDLE handles[MAX_WORKERS];
#else
      pthread_t threads[MAX_WORKERS];
#endif
      {
        std::lock_guard<std::mutex> lock(this->mu_);
        count = this->thread_count_;
        for (int i = 0; i < count; ++i) {
          this->wake_.post();
#ifdef _WIN32
          handles[i] = this->handles_[i];
#else
          threads[i] = this->threads_[i];
#endif
        }
        this->thread_count_ = 0;
      }

      for (int i = 0; i < count; ++i) {
#ifdef _WIN32
        WaitForSingleObject(handles[i], INFINITE);
        CloseHandle(handles[i]);
#else
        pthread_join(threads[i], nullptr);
#endif
      }
    }

    FSH_FORCE_INLINE bool is_shutdown() const noexcept {
      return this->state_.load(std::memory_order_relaxed) == STATE_SHUTDOWN;
    }

   private:
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

    static constexpr uint32_t STATE_RUNNING = 0;
    static constexpr uint32_t STATE_SHUTDOWN = 1;

    alignas(64) std::atomic<Task *> queue_head_{nullptr};
    alignas(64) Semaphore wake_;
    alignas(64) std::mutex mu_;
    std::atomic<uint32_t> state_{STATE_RUNNING};
    std::atomic<uint32_t> trim_gen_{0};
    int thread_count_ = 0;
#ifdef _WIN32
    HANDLE handles_[MAX_WORKERS]{};
    DWORD thread_ids_[MAX_WORKERS]{};
#else
    pthread_t threads_[MAX_WORKERS]{};
#endif
    ForkGroup groups_[MAX_FORK_GROUPS];

    static FSH_FORCE_INLINE int max_threads_() noexcept {
      static const int v = [] {
        int hw = static_cast<int>(hardware_concurrency());
        if (hw < 2) [[unlikely]] {
          hw = 2;
        }
        return hw < MAX_WORKERS ? hw : MAX_WORKERS;
      }();
      return v;
    }

    void push_task_(Task * task) noexcept {
      Task * head = this->queue_head_.load(std::memory_order_relaxed);
      for (;;) {
        task->next_ = head;
        if (this->queue_head_.compare_exchange_weak(head, task, std::memory_order_release, std::memory_order_relaxed))
          [[likely]] {
          return;
        }
        cpu_pause();
      }
    }

    Task * pop_task_() noexcept {
      Task * head = this->queue_head_.load(std::memory_order_acquire);
      while (head) {
        if (this->queue_head_.compare_exchange_weak(head, head->next_, std::memory_order_acq_rel)) [[likely]] {
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

    ForkGroup * alloc_fork_group_() noexcept {
      for (;;) {
        for (int i = 0; i < MAX_FORK_GROUPS; ++i) {
          bool expected = false;
          if (this->groups_[i].in_use.compare_exchange_strong(expected, true, std::memory_order_acquire)) {
            return &this->groups_[i];
          }
        }
        cpu_pause();
      }
    }

    static void release_fork_group_(ForkGroup * group) noexcept { group->in_use.store(false, std::memory_order_release); }

    FSH_FORCE_INLINE void ensure_threads_(int needed) noexcept {
      if (this->thread_count_ >= needed) [[likely]] {
        return;
      }
      this->grow_(needed);
    }

    FSH_NO_INLINE void grow_(int needed) noexcept {
      if (this->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) {
        return;
      }

      std::lock_guard<std::mutex> lock(this->mu_);
      int target = needed < max_threads_() ? needed : max_threads_();
      if (this->thread_count_ >= target) {
        return;
      }

#ifndef _WIN32
      pthread_attr_t attr;
      pthread_attr_init(&attr);
      pthread_attr_setstacksize(&attr, THREAD_STACK_SIZE);
#endif

      while (this->thread_count_ < target) {
#ifdef _WIN32
        unsigned tid = 0;
        uintptr_t h =
          _beginthreadex(nullptr, static_cast<unsigned>(THREAD_STACK_SIZE), thread_entry_, this, 0, &tid);
        if (!h) [[unlikely]] {
          break;
        }
        this->handles_[this->thread_count_] = reinterpret_cast<HANDLE>(h);
        this->thread_ids_[this->thread_count_] = static_cast<DWORD>(tid);
#else
        if (pthread_create(&this->threads_[this->thread_count_], &attr, thread_entry_, this) != 0) [[unlikely]] {
          break;
        }
#endif
        this->thread_count_++;
      }

#ifndef _WIN32
      pthread_attr_destroy(&attr);
#endif
    }

    /**
     * Detach this thread from the pool arrays and exit.
     * Called by an idle thread that wants to self-terminate.
     * Must NOT be called during shutdown (shutdown joins, not detaches).
     */
    void thread_self_exit_() noexcept {
      std::lock_guard<std::mutex> lock(this->mu_);
      // During shutdown, threads are joined — don't detach.
      if (this->state_.load(std::memory_order_relaxed) == STATE_SHUTDOWN) {
        return;
      }
      const int count = this->thread_count_;
#ifdef _WIN32
      const DWORD my_id = GetCurrentThreadId();
      for (int i = 0; i < count; ++i) {
        if (this->thread_ids_[i] == my_id) {
          HANDLE h = this->handles_[i];
          const int last = count - 1;
          if (i != last) {
            this->handles_[i] = this->handles_[last];
            this->thread_ids_[i] = this->thread_ids_[last];
          }
          this->thread_count_ = last;
          CloseHandle(h);
          return;
        }
      }
#else
      const pthread_t my_tid = pthread_self();
      for (int i = 0; i < count; ++i) {
        if (pthread_equal(this->threads_[i], my_tid)) {
          const int last = count - 1;
          if (i != last) {
            this->threads_[i] = this->threads_[last];
          }
          this->thread_count_ = last;
          pthread_detach(my_tid);
          return;
        }
      }
#endif
    }

    static FSH_NO_INLINE void worker_loop_(ThreadPool * pool) noexcept {
      uint32_t seen_trim_gen = pool->trim_gen_.load(std::memory_order_relaxed);

      for (;;) {
        Task * task = pool->pop_task_();
        if (task) [[likely]] {
          task->run();
          continue;
        }

        if (pool->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) [[unlikely]] {
          return;
        }

        if (!pool->wake_.wait_for_ms(idle_timeout_ms())) [[unlikely]] {
          // Timed out — no work arrived. Self-terminate if not shutting down.
          if (pool->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) [[unlikely]] {
            return;
          }
          // One last check: work may have arrived just after timeout.
          task = pool->pop_task_();
          if (task) {
            task->run();
            continue;
          }
          pool->thread_self_exit_();
          return;
        }

        // Woken by post(). Check for shutdown before looping.
        if (pool->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) [[unlikely]] {
          return;
        }

        // If trim generation advanced, exit if there's no work queued.
        const uint32_t cur_gen = pool->trim_gen_.load(std::memory_order_acquire);
        if (cur_gen != seen_trim_gen) [[unlikely]] {
          seen_trim_gen = cur_gen;
          task = pool->pop_task_();
          if (task) {
            task->run();
            continue;
          }
          pool->thread_self_exit_();
          return;
        }
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
      if (done_fn) {
        done_fn(done_arg);
      }
    }
  }

}  // namespace fast_fs_hash

#endif
