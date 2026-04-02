#ifndef _FAST_FS_HASH_THREAD_POOL_H
#define _FAST_FS_HASH_THREAD_POOL_H

#include "ForkJob.h"
#include "FshSemaphore.h"

#ifdef _WIN32
#  include <process.h>
#else
#  include <pthread.h>
#endif

#include <mutex>

namespace fast_fs_hash {

  /**
   * Per-addon-instance thread pool.
   *
   * Threads spawn on demand and self-terminate after IDLE_TIMEOUT_MS of inactivity.
   * shutdown() sets the flag, wakes all, joins all — draining remaining tasks first.
   * trim() wakes idle threads so they can check and exit if no work is pending.
   *
   * Task queue is FIFO: tasks are executed in the order they are submitted.
   * Uses a TTAS spinlock-guarded intrusive linked list (head/tail pointers).
   * The critical section is ~2 pointer operations so contention is negligible.
   *
   * Wakeup signaling uses an idle_count_ to avoid wasted semaphore posts:
   * only threads that are actually blocked in wait_for_ms() are woken.
   */
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

    ThreadPool() = default;
    ~ThreadPool() { this->shutdown(); }

    /** Return the number of online CPUs (cached, called once). */
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

    /**
     * Compute the number of threads to use for a parallel job.
     *
     * @param concurrency  Requested thread count (0 = use hardware_concurrency).
     * @param work_count   Total work items.
     * @param max_threads  Upper bound on threads.
     * @param min_per_thread  Minimum work items per thread to avoid over-splitting.
     * @return Clamped thread count in [1, MAX_WORKERS].
     */
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
      const int by_work = static_cast<int>((work_count + min_per_thread - 1) / min_per_thread);
      if (tc > by_work) {
        tc = by_work;
      }
      if (tc < 1) [[unlikely]] {
        tc = 1;
      }
      return tc;
    }

    /**
     * Fork count threads via a caller-owned ForkJob.
     * Pushes count tasks, ensures threads exist, then wakes them.
     * If count <= 0, calls forkDone() immediately (no threads spawned).
     */
    template <typename T>
    void submit(T & job, int count) noexcept {
      if (count <= 0) [[unlikely]] {
        job.forkDone();
        return;
      }

      job.remaining.store(count, std::memory_order_relaxed);
      job.nextSlot.store(count, std::memory_order_relaxed);

      // Push all tasks first, then ensure threads + wake.
      // Order matters: tasks must be visible before ensure_threads_ checks,
      // so thread_self_exit_ sees them via pop_task_().
      for (int i = 0; i < count; ++i) {
        job.tasks[i].job = &job;
        this->push_task_(&job.tasks[i]);
      }
      this->ensure_threads_(count);
      this->notify_n_(count);
    }

    /**
     * Add more threads to a running ForkJob. Thread-safe — callable from pool threads.
     * MUST be called from within forkWork() (i.e. by a thread that is part of
     * the job's remaining count) to guarantee the job stays alive.
     *
     * @return Count actually added (limited by MaxTasks and hardware_concurrency).
     */
    template <typename T>
    int expand(T & job, int additional) noexcept {
      if (additional <= 0) {
        return 0;
      }
      constexpr int kMaxSlots = T::MAX_TASKS;
      const int hwMax = max_threads_();
      const int maxSlots = hwMax < kMaxSlots ? hwMax : kMaxSlots;

      int added = 0;
      for (int i = 0; i < additional; ++i) {
        const int slot = job.nextSlot.fetch_add(1, std::memory_order_relaxed);
        if (slot >= maxSlots) {
          job.nextSlot.store(maxSlots, std::memory_order_relaxed);
          break;
        }
        job.tasks[slot].job = &job;
        // Increment remaining BEFORE pushing the task. Use release so that
        // the new task's fetch_sub(acq_rel) in ForkTask::run() sees this.
        job.remaining.fetch_add(1, std::memory_order_release);
        this->push_task_(&job.tasks[slot]);
        ++added;
      }

      if (added > 0) {
        this->ensure_threads_(job.nextSlot.load(std::memory_order_relaxed));
        this->notify_n_(added);
      }
      return added;
    }

    /** Enqueue a single task on a pool thread. */
    void enqueue(Task & task) noexcept {
      this->push_task_(&task);
      this->ensure_threads_(1);
      this->notify_one_();
    }

    /** Wake idle threads so they can self-terminate if no work is pending. */
    void trim() noexcept {
      if (this->state_.load(std::memory_order_relaxed) == STATE_SHUTDOWN) {
        return;
      }
      this->trim_gen_.fetch_add(1, std::memory_order_release);
      const int idle = this->idle_count_.load(std::memory_order_relaxed);
      for (int i = 0; i < idle; ++i) {
        this->wake_.post();
      }
    }

    /**
     * Shut down the pool: set the shutdown flag, wake all threads, join all.
     * Safe to call multiple times (second call is a no-op).
     * Any tasks still in the queue are drained by worker threads before they exit.
     */
    void shutdown() noexcept {
      uint32_t expected = STATE_RUNNING;
      if (!this->state_.compare_exchange_strong(expected, STATE_SHUTDOWN, std::memory_order_acq_rel)) {
        return;
      }

      int count;
#ifdef _WIN32
      HANDLE handles[MAX_WORKERS];
#else
      pthread_t threads[MAX_WORKERS];
#endif
      {
        std::lock_guard<std::mutex> lock(this->mu_);
        count = this->thread_count_.load(std::memory_order_relaxed);
        for (int i = 0; i < count; ++i) {
          this->wake_.post();
#ifdef _WIN32
          handles[i] = this->handles_[i];
#else
          threads[i] = this->threads_[i];
#endif
        }
        this->thread_count_.store(0, std::memory_order_relaxed);
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

    /** Returns true if the pool has been shut down. Lock-free relaxed read. */
    FSH_FORCE_INLINE bool is_shutdown() const noexcept {
      return this->state_.load(std::memory_order_relaxed) == STATE_SHUTDOWN;
    }

   private:
    static constexpr int SPIN_BEFORE_WAIT = 32;

    static constexpr uint32_t STATE_RUNNING = 0;
    static constexpr uint32_t STATE_SHUTDOWN = 1;

    alignas(64) std::atomic<bool> q_lock_{false};
    Task * q_head_ = nullptr;
    Task * q_tail_ = nullptr;

    alignas(64) Semaphore wake_;

    alignas(64) std::mutex mu_;
    std::atomic<uint32_t> state_{STATE_RUNNING};
    std::atomic<uint32_t> trim_gen_{0};
    std::atomic<int> thread_count_{0};

    alignas(64) std::atomic<int> idle_count_{0};

#ifdef _WIN32
    HANDLE handles_[MAX_WORKERS]{};
    DWORD thread_ids_[MAX_WORKERS]{};
#else
    pthread_t threads_[MAX_WORKERS]{};
#endif

    /** Max threads this pool will ever spawn (min(hw_concurrency, MAX_WORKERS), cached). */
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

    /** Acquire the TTAS spinlock guarding the task queue. */
    FSH_FORCE_INLINE void q_acquire_() noexcept {
      for (;;) {
        if (!this->q_lock_.exchange(true, std::memory_order_acquire)) [[likely]] {
          return;
        }
        // TTAS: spin on relaxed load (shared cache state) until the lock looks free,
        // avoiding exclusive bus transactions while another thread holds the lock.
        do {
          cpu_pause();
        } while (this->q_lock_.load(std::memory_order_relaxed));
      }
    }

    /** Release the TTAS spinlock guarding the task queue. */
    FSH_FORCE_INLINE void q_release_() noexcept { this->q_lock_.store(false, std::memory_order_release); }

    /** Push a task to the tail of the FIFO queue. */
    void push_task_(Task * task) noexcept {
      task->next_ = nullptr;
      this->q_acquire_();
      if (this->q_tail_) {
        this->q_tail_->next_ = task;
      } else {
        this->q_head_ = task;
      }
      this->q_tail_ = task;
      this->q_release_();
    }

    /** Pop a task from the head of the FIFO queue. Returns nullptr if empty. */
    Task * pop_task_() noexcept {
      this->q_acquire_();
      Task * task = this->q_head_;
      if (task) {
        this->q_head_ = task->next_;
        if (!this->q_head_) {
          this->q_tail_ = nullptr;
        }
      }
      this->q_release_();
      return task;
    }

    /** Drain and execute all remaining tasks in the queue. */
    void drain_tasks_() noexcept {
      Task * task;
      while ((task = this->pop_task_())) {
        task->run();
      }
    }

    /** Post one semaphore wake if any thread is idle. */
    void notify_one_() noexcept {
      if (this->idle_count_.load(std::memory_order_relaxed) > 0) {
        this->wake_.post();
      }
    }

    /** Post up to n semaphore wakes, capped by the current idle count. */
    void notify_n_(int n) noexcept {
      const int idle = this->idle_count_.load(std::memory_order_relaxed);
      const int to_wake = n < idle ? n : idle;
      for (int i = 0; i < to_wake; ++i) {
        this->wake_.post();
      }
    }

    /** Ensure at least `needed` threads exist, spawning if necessary. */
    FSH_FORCE_INLINE void ensure_threads_(int needed) noexcept {
      if (this->thread_count_.load(std::memory_order_acquire) >= needed) [[likely]] {
        return;
      }
      this->grow_(needed);
    }

    /** Spawn threads up to `needed` (capped by max_threads_). Holds mu_. */
    FSH_NO_INLINE void grow_(int needed) noexcept {
      if (this->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) {
        return;
      }

      std::lock_guard<std::mutex> lock(this->mu_);
      const int current = this->thread_count_.load(std::memory_order_relaxed);
      const int cap = max_threads_();
      const int target = needed < cap ? needed : cap;
      if (current >= target) {
        return;
      }

#ifndef _WIN32
      pthread_attr_t attr;
      pthread_attr_init(&attr);
      pthread_attr_setstacksize(&attr, THREAD_STACK_SIZE);
#endif

      int count = current;
      while (count < target) {
#ifdef _WIN32
        unsigned tid = 0;
        uintptr_t h = _beginthreadex(nullptr, static_cast<unsigned>(THREAD_STACK_SIZE), thread_entry_, this, 0, &tid);
        if (!h) [[unlikely]] {
          break;
        }
        this->handles_[count] = reinterpret_cast<HANDLE>(h);
        this->thread_ids_[count] = static_cast<DWORD>(tid);
#else
        if (pthread_create(&this->threads_[count], &attr, thread_entry_, this) != 0) [[unlikely]] {
          break;
        }
#endif
        count++;
      }
      this->thread_count_.store(count, std::memory_order_release);

#ifndef _WIN32
      pthread_attr_destroy(&attr);
#endif
    }

    /**
     * Try to unregister and detach this thread from the pool.
     * Returns true if the thread was detached and MUST exit immediately.
     * Returns false if work is pending or shutdown — caller should loop back.
     *
     * Race to close: a concurrent enqueue() can push a task after our first
     * queue check but before this thread fully unregisters. To prevent stranding
     * that work, we temporarily remove this thread from the pool metadata,
     * re-check the queue under mu_, and restore the current thread if new work
     * arrived. That keeps the current worker alive instead of relying on a
     * replacement thread to spawn successfully under resource pressure.
     */
    bool thread_self_exit_() noexcept {
      std::lock_guard<std::mutex> lock(this->mu_);
      if (this->state_.load(std::memory_order_relaxed) == STATE_SHUTDOWN) {
        return false;
      }

      // Check for stranded tasks before unregistering. Must be done inside mu_ —
      // after detaching, this thread must not touch pool state (shutdown could
      // destroy the pool once thread_count_ reaches 0).
      this->q_acquire_();
      const bool has_work = this->q_head_ != nullptr;
      this->q_release_();
      if (has_work) {
        return false;
      }

      const int count = this->thread_count_.load(std::memory_order_relaxed);
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
          this->thread_count_.store(last, std::memory_order_release);

          this->q_acquire_();
          const bool still_has_work = this->q_head_ != nullptr;
          this->q_release_();
          if (still_has_work) {
            this->handles_[last] = h;
            this->thread_ids_[last] = my_id;
            this->thread_count_.store(count, std::memory_order_release);
            return false;
          }

          CloseHandle(h);
          return true;
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
          this->thread_count_.store(last, std::memory_order_release);

          this->q_acquire_();
          const bool still_has_work = this->q_head_ != nullptr;
          this->q_release_();
          if (still_has_work) {
            this->threads_[last] = my_tid;
            this->thread_count_.store(count, std::memory_order_release);
            return false;
          }

          pthread_detach(my_tid);
          return true;
        }
      }
#endif
      return false;
    }

    /**
     * Main worker loop — each pool thread runs this until shutdown or idle-timeout.
     *
     * Flow: pop task → run → repeat. If no task, spin briefly, then block on
     * semaphore with idle timeout. On timeout, self-terminate if no work pending.
     * On shutdown, drain remaining tasks before exiting to avoid stranded promises.
     */
    static FSH_NO_INLINE void worker_loop_(ThreadPool * pool) noexcept {
      uint32_t seen_trim_gen = pool->trim_gen_.load(std::memory_order_relaxed);

      for (;;) {
        Task * task = pool->pop_task_();
        if (task) [[likely]] {
          task->run();
          continue;
        }

        if (pool->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) [[unlikely]] {
          pool->drain_tasks_();
          return;
        }

        for (int spin = 0; spin < SPIN_BEFORE_WAIT; ++spin) {
          cpu_pause();
          task = pool->pop_task_();
          if (task) {
            break;
          }
        }
        if (task) {
          task->run();
          continue;
        }

        pool->idle_count_.fetch_add(1, std::memory_order_release);
        const bool woken = pool->wake_.wait_for_ms(idle_timeout_ms());
        pool->idle_count_.fetch_sub(1, std::memory_order_release);

        if (!woken) [[unlikely]] {
          // Timed out — try to self-terminate.
          // thread_self_exit_ returns true if detached (must exit),
          // false if work arrived or shutdown (loop back to process).
          if (pool->thread_self_exit_()) {
            return;
          }
          continue;
        }

        if (pool->state_.load(std::memory_order_acquire) == STATE_SHUTDOWN) [[unlikely]] {
          // Drain any remaining tasks before exiting — tasks may have been
          // pushed by expand() just before shutdown, and their forkDone()
          // callbacks must fire to avoid stranded promises.
          pool->drain_tasks_();
          return;
        }

        const uint32_t cur_gen = pool->trim_gen_.load(std::memory_order_acquire);
        if (cur_gen != seen_trim_gen) [[unlikely]] {
          seen_trim_gen = cur_gen;
          if (pool->thread_self_exit_()) {
            return;
          }
          // Work pending — loop back to process it.
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

}  // namespace fast_fs_hash

#endif
