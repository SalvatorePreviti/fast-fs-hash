/**
 * Lightweight, exception-free thread primitive.
 *
 * std::thread throws std::system_error on creation failure, which is
 * undefined behaviour when C++ exceptions are disabled (/EHs-c- on MSVC,
 * -fno-exceptions on GCC/Clang) — calling std::terminate() and crashing
 * the process.  This class uses the OS thread API directly and reports
 * failure via a non-joinable state instead of throwing.
 *
 * Safe for work-stealing loops: if a thread fails to start, the
 * remaining threads (including the caller) drain all work via the
 * shared atomic index — no items are lost, just less parallelism.
 */

#ifndef _FAST_FS_HASH_THREAD_H
#define _FAST_FS_HASH_THREAD_H

#include "includes.h"

#ifdef _WIN32
#  include <process.h>
#else
#  include <pthread.h>
#endif

namespace fast_fs_hash {

  class Thread : NonCopyable {
   public:
    Thread() noexcept = default;

    Thread(Thread && o) noexcept
#ifdef _WIN32
      : h_(o.h_) {
      o.h_ = nullptr;
    }
#else
      : t_(o.t_), joinable_(o.joinable_) {
      o.joinable_ = false;
    }
#endif

    Thread & operator=(Thread && o) noexcept {
      if (this != &o) {
        join();
#ifdef _WIN32
        h_ = o.h_;
        o.h_ = nullptr;
#else
        t_ = o.t_;
        joinable_ = o.joinable_;
        o.joinable_ = false;
#endif
      }
      return *this;
    }

    ~Thread() noexcept { join(); }

    FSH_FORCE_INLINE bool joinable() const noexcept {
#ifdef _WIN32
      return h_ != nullptr;
#else
      return joinable_;
#endif
    }

    FSH_FORCE_INLINE void join() noexcept {
#ifdef _WIN32
      if (h_) {
        WaitForSingleObject(h_, INFINITE);
        CloseHandle(h_);
        h_ = nullptr;
      }
#else
      if (joinable_) {
        pthread_join(t_, nullptr);
        joinable_ = false;
      }
#endif
    }

    /** Number of hardware threads (cores).  Equivalent to
     *  std::thread::hardware_concurrency() without pulling in <thread>. */
    static unsigned hardware_concurrency() noexcept {
#ifdef _WIN32
      SYSTEM_INFO si;
      GetSystemInfo(&si);
      return si.dwNumberOfProcessors;
#else
      long n = sysconf(_SC_NPROCESSORS_ONLN);
      return n > 0 ? static_cast<unsigned>(n) : 1;
#endif
    }

    /**
     * Create and start a thread running `fn()`.
     *
     * Returns an empty (non-joinable) Thread on allocation or OS failure —
     * safe for work-stealing loops where the caller + surviving threads
     * will drain the remaining work.
     *
     * One heap allocation per thread (type-erased context); freed by the
     * new thread itself after moving the callable to a stack local.
     */
    template <typename Fn>
    static Thread create(Fn fn) noexcept {
      // Type-erased callable context — header (trampoline pointer) + payload.
      // Allocated with malloc, constructed with placement new, freed by the
      // new thread after invoking fn.
      struct Ctx {
        void (*trampoline)(void *);
        Fn fn;
      };

      void * mem = malloc(sizeof(Ctx));
      if (!mem) [[unlikely]]
        return {};

      // Construct the callable via placement new.
      auto * ctx = static_cast<Ctx *>(mem);
      ctx->trampoline = [](void * raw) {
        auto * c = static_cast<Ctx *>(raw);
        Fn local(static_cast<Fn &&>(c->fn));
        c->fn.~Fn();
        free(c);
        local();
      };
      ::new (&ctx->fn) Fn(static_cast<Fn &&>(fn));

      Thread t;
#ifdef _WIN32
      uintptr_t h = _beginthreadex(nullptr, 0, entry_win32_, ctx, 0, nullptr);
      if (!h) [[unlikely]] {
        ctx->fn.~Fn();
        free(ctx);
        return {};
      }
      t.h_ = reinterpret_cast<HANDLE>(h);
#else
      int rc = pthread_create(&t.t_, nullptr, entry_posix_, ctx);
      if (rc != 0) [[unlikely]] {
        ctx->fn.~Fn();
        free(ctx);
        return {};
      }
      t.joinable_ = true;
#endif
      return t;
    }

   private:
    // Platform thread entry points.  Read the trampoline function
    // pointer from the start of the type-erased context and invoke it.
    // These must have C-compatible signatures matching the OS thread API.
#ifdef _WIN32
    static unsigned __stdcall entry_win32_(void * raw) {
      static_cast<void (**)(void *)>(raw)[0](raw);
      return 0;
    }
    HANDLE h_ = nullptr;
#else
    static void * entry_posix_(void * raw) {
      static_cast<void (**)(void *)>(raw)[0](raw);
      return nullptr;
    }
    pthread_t t_{};
    bool joinable_ = false;
#endif
  };

}  // namespace fast_fs_hash

#endif
