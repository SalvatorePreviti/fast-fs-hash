/**
 * Out-of-line method bodies for InstanceHashWorker.
 *
 * Separated into an _impl header because OnOK() needs the complete
 * XXHash128Wrap definition (circular dependency with the class declaration).
 * Must be #included AFTER XXHash128Wrap.h in the single compilation unit.
 */

#ifndef _FAST_FS_HASH_INSTANCE_HASH_WORKER_IMPL_H
#define _FAST_FS_HASH_INSTANCE_HASH_WORKER_IMPL_H

#include "XXHash128Wrap.h"
#include "HashFilesWorker.h"
#include "PathIndex.h"

// ── InstanceHashWorker::Execute ──────────────────────────────────────────

inline void InstanceHashWorker::Execute() {
  PathIndex paths(this->paths_data_, this->paths_len_);
  const size_t file_count = paths.count;

  if (FSH_LIKELY(file_count > 0)) {
    const size_t needed = file_count * 16;
    if (!this->output.data) {
      if (FSH_UNLIKELY(!this->output.allocate(fast_fs_hash::OUTPUT_ALIGNMENT, needed))) {
        SetError("hash_files: out of memory");
        return;
      }
    } else if (FSH_UNLIKELY(needed > this->output.len)) {
      SetError("hash_files: output buffer too small");
      return;
    } else {
      this->output.len = needed;
    }
    fast_fs_hash::HashFilesWorker worker{paths.segments, file_count, this->output.data};
    worker.run(this->concurrency_);
  } else {
    this->output.len = 0;
  }
}

// ── InstanceHashWorker::OnOK (needs complete XXHash128Wrap) ──────────────

inline void InstanceHashWorker::OnOK() {
  auto env = Env();
  Napi::HandleScope scope(env);

  uint8_t * out = this->output.data;
  size_t len = this->output.len;

  auto * wrap = Napi::ObjectWrap<XXHash128Wrap>::Unwrap(this->instance_ref_.Value().As<Napi::Object>());

  // Feed per-file hashes into the streaming state.
  if (len > 0) {
    XXH3_128bits_update(&wrap->state, out, len);
  }

  switch (this->mode) {
    case Mode::RESOLVE_NULL: this->deferred_.Resolve(env.Null()); break;

    case Mode::RESOLVE_BUFFER: {
      if (out && len > 0) {
        this->output.release();  // ownership transferred to Napi::Buffer
        this->deferred_.Resolve(Napi::Buffer<uint8_t>::New(env, out, len, [](Napi::Env, uint8_t * p) {
          aligned_free(p);
        }));
      } else {
        this->deferred_.Resolve(Napi::Buffer<uint8_t>::New(env, 0));
      }
      break;
    }
  }
}

#endif
