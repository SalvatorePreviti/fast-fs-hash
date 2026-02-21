/**
 * Out-of-line method bodies for UpdateFileWorker.
 *
 * Separated into an _impl header because OnOK() needs the complete
 * XXHash128Wrap definition (circular dependency with the class declaration).
 * Must be #included AFTER XXHash128Wrap.h in the single compilation unit.
 */

#ifndef _FAST_FS_HASH_UPDATE_FILE_WORKER_IMPL_H
#define _FAST_FS_HASH_UPDATE_FILE_WORKER_IMPL_H

#include "XXHash128Wrap.h"

// ── UpdateFileWorker::Execute ────────────────────────────────────────────

inline void UpdateFileWorker::Execute() {
  fast_fs_hash::FileHandle fh(this->path_.c_str());
  if (!fh) [[unlikely]] {
    SetError("updateFile: cannot open file");
    return;
  }
  fh.hint_sequential();  // multi-read streaming path benefits from readahead

  static constexpr size_t INITIAL_CAP = 256 * 1024;
  size_t cap = INITIAL_CAP;
  uint8_t * buf = static_cast<uint8_t *>(malloc(cap));
  if (!buf) [[unlikely]] {
    SetError("updateFile: out of memory");
    return;
  }

  size_t len = 0;
  for (;;) {
    if (len == cap) {
      cap *= 2;
      uint8_t * p = static_cast<uint8_t *>(realloc(buf, cap));
      if (!p) [[unlikely]] {
        free(buf);
        this->data_ = nullptr;
        SetError("updateFile: out of memory");
        return;
      }
      buf = p;
    }
    const int64_t n = fh.read(buf + len, cap - len);
    if (n < 0) [[unlikely]] {
      free(buf);
      this->data_ = nullptr;
      SetError("updateFile: read error");
      return;
    }
    if (n == 0) break;  // EOF
    len += static_cast<size_t>(n);
  }

  this->data_ = buf;
  this->len_ = len;
}

// ── UpdateFileWorker::OnOK ──────────────────────────────────────────────

inline void UpdateFileWorker::OnOK() {
  auto env = Env();
  Napi::HandleScope scope(env);

  auto * wrap = Napi::ObjectWrap<XXHash128Wrap>::Unwrap(this->instance_ref_.Value().As<Napi::Object>());

  if (this->len_ > 0) {
    XXH3_128bits_update(&wrap->state, this->data_, this->len_);
  }

  this->deferred_.Resolve(env.Undefined());
}

#endif
