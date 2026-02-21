#include "XXHash128Wrap.h"
#include "UpdateFileWorker.h"
#include "HashFilesWorker.h"
#include "PathIndex.h"

// ── InstanceHashWorker::Execute ──────────────────────────────────────────

void InstanceHashWorker::Execute() {
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
    fast_fs_hash::HashFilesWorker::run(paths.segments, file_count, this->output.data, this->concurrency_);
  } else {
    this->output.len = 0;
  }
}

// ── InstanceHashWorker::OnOK (needs complete XXHash128Wrap) ──────────────

void InstanceHashWorker::OnOK() {
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

// ── UpdateFileWorker::Execute ────────────────────────────────────────────

void UpdateFileWorker::Execute() {
  fast_fs_hash::FileHandle fh(this->path_.c_str());
  if (FSH_UNLIKELY(!fh)) {
    SetError("updateFile: cannot open file");
    return;
  }

  static constexpr size_t INITIAL_CAP = 256 * 1024;
  size_t cap = INITIAL_CAP;
  uint8_t * buf = static_cast<uint8_t *>(malloc(cap));
  if (FSH_UNLIKELY(!buf)) {
    SetError("updateFile: out of memory");
    return;
  }

  size_t len = 0;
  for (;;) {
    if (len == cap) {
      cap *= 2;
      uint8_t * p = static_cast<uint8_t *>(realloc(buf, cap));
      if (FSH_UNLIKELY(!p)) {
        free(buf);
        this->data_ = nullptr;
        SetError("updateFile: out of memory");
        return;
      }
      buf = p;
    }
    int64_t n = fh.read(buf + len, cap - len);
    if (n <= 0) break;
    len += static_cast<size_t>(n);
  }

  this->data_ = buf;
  this->len_ = len;
}

// ── UpdateFileWorker::OnOK ──────────────────────────────────────────────

void UpdateFileWorker::OnOK() {
  auto env = Env();
  Napi::HandleScope scope(env);

  auto * wrap = Napi::ObjectWrap<XXHash128Wrap>::Unwrap(this->instance_ref_.Value().As<Napi::Object>());

  if (this->len_ > 0) {
    XXH3_128bits_update(&wrap->state, this->data_, this->len_);
  }

  this->deferred_.Resolve(env.Undefined());
}
