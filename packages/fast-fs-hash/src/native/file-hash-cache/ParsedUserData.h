#ifndef _FAST_FS_HASH_PARSED_USER_DATA_H
#define _FAST_FS_HASH_PARSED_USER_DATA_H

#include "file-hash-cache-format.h"

#include <vector>

namespace fast_fs_hash {

  /**
   * Parsed user data from a NAPI argument.
   * Holds GC-pinned references to JS buffers and their (ptr, len) slices.
   * Non-copyable — move only.
   */
  struct ParsedUserData : NonCopyable {
    OwnedBuf<> items_buf;
    std::vector<Napi::ObjectReference> refs;
    size_t item_count_ = 0;
    bool has_error = false;

    ParsedUserData() = default;
    ParsedUserData(ParsedUserData &&) = default;
    ParsedUserData & operator=(ParsedUserData &&) = default;

    /** Parse and validate a userData argument from a NAPI call.
     *  - Array<Uint8Array> → items populated (validated)
     *  - null/undefined → empty items (clear user data)
     *  @throws TypeError if an item is not a Uint8Array.
     *  @throws RangeError if total user data size exceeds CACHE_MAX_UD_PAYLOADS. */
    explicit ParsedUserData(const Napi::CallbackInfo & info, size_t arg_index) {
      if (info.Length() <= arg_index || info[arg_index].IsUndefined() || info[arg_index].IsNull()) {
        return;
      }
      if (!info[arg_index].IsArray()) {
        return;
      }

      auto arr = info[arg_index].As<Napi::Array>();
      const uint32_t len = arr.Length();
      if (len == 0) {
        return;
      }

      this->items_buf = OwnedBuf<>::alloc(len * sizeof(UserDataSlice));
      if (!this->items_buf) {
        return;
      }
      auto * slices = reinterpret_cast<UserDataSlice *>(this->items_buf.ptr);
      this->refs.reserve(len);
      size_t total_size = 0;
      for (uint32_t i = 0; i < len; ++i) {
        auto item = arr.Get(i);
        if (!item.IsTypedArray()) [[unlikely]] {
          this->items_buf.reset();
          this->refs.clear();
          this->has_error = true;
          Napi::TypeError::New(info.Env(),
            "FileHashCache: userData items must be Uint8Array")
            .ThrowAsJavaScriptException();
          return;
        }
        auto ta = item.As<Napi::Uint8Array>();
        slices[i] = {ta.Data(), ta.ByteLength()};
        this->refs.push_back(Napi::ObjectReference::New(ta, 1));
        total_size += ta.ByteLength();
        if (total_size > CACHE_MAX_UD_PAYLOADS) [[unlikely]] {
          this->items_buf.reset();
          this->refs.clear();
          this->has_error = true;
          Napi::RangeError::New(info.Env(),
            "FileHashCache: total user data size exceeds 2147483647 bytes")
            .ThrowAsJavaScriptException();
          return;
        }
      }
      this->item_count_ = len;
    }

    size_t count() const noexcept { return this->item_count_; }

    const UserDataSlice * data() const noexcept {
      return this->item_count_ > 0 ? reinterpret_cast<const UserDataSlice *>(this->items_buf.ptr) : nullptr;
    }
  };

}  // namespace fast_fs_hash

#endif
