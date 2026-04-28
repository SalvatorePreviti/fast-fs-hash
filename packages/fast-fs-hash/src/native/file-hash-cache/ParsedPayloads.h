#ifndef _FAST_FS_HASH_PARSED_PAYLOADS_H
#define _FAST_FS_HASH_PARSED_PAYLOADS_H

#include "file-hash-cache-format.h"
#include "../core/OwnedBuf.h"

#include <vector>

namespace fast_fs_hash {

  /**
   * Parsed payload array from a NAPI argument.
   * Holds GC-pinned references to JS buffers and their (ptr, len) slices.
   * Used for both compressed and uncompressed payload arrays — the caller
   * chooses the max-size limit to validate against.
   * Non-copyable — move only.
   */
  struct ParsedPayloads : NonCopyable {
    OwnedBuf<> items_buf;
    std::vector<Napi::ObjectReference> refs;
    size_t item_count_ = 0;
    bool has_error = false;

    ParsedPayloads() = default;
    ParsedPayloads(ParsedPayloads &&) = default;
    ParsedPayloads & operator=(ParsedPayloads &&) = default;

    /** Parse and validate a payloads argument from a NAPI call.
     *  - Array<Uint8Array> → items populated (validated)
     *  - null/undefined → empty items (clear payloads)
     *  @param info       NAPI call info.
     *  @param arg_index  Argument index to parse.
     *  @param max_total  Max allowed total byte size (per-side limit).
     *  @param label      Short name used in error messages ("compressed" or "uncompressed").
     *  @throws TypeError if an item is not a Uint8Array.
     *  @throws RangeError if total payload size exceeds max_total. */
    ParsedPayloads(const Napi::CallbackInfo & info, size_t arg_index, size_t max_total, const char * label) {
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

      this->items_buf = OwnedBuf<>::alloc(len * sizeof(PayloadSlice));
      if (!this->items_buf) {
        return;
      }
      auto * slices = reinterpret_cast<PayloadSlice *>(this->items_buf.ptr);
      this->refs.reserve(len);
      size_t total_size = 0;
      for (uint32_t i = 0; i < len; ++i) {
        auto item = arr.Get(i);
        if (!item.IsTypedArray()) [[unlikely]] {
          this->items_buf.reset();
          this->refs.clear();
          this->has_error = true;
          std::string msg = "FileHashCache: ";
          msg += label;
          msg += " payload items must be Uint8Array";
          Napi::TypeError::New(info.Env(), msg).ThrowAsJavaScriptException();
          return;
        }
        auto ta = item.As<Napi::Uint8Array>();
        slices[i] = {ta.Data(), ta.ByteLength()};
        this->refs.push_back(Napi::ObjectReference::New(ta, 1));
        total_size += ta.ByteLength();
        if (total_size > max_total) [[unlikely]] {
          this->items_buf.reset();
          this->refs.clear();
          this->has_error = true;
          std::string msg = "FileHashCache: total ";
          msg += label;
          msg += " payload size exceeds 128 MiB";
          Napi::RangeError::New(info.Env(), msg).ThrowAsJavaScriptException();
          return;
        }
      }
      this->item_count_ = len;
    }

    size_t count() const noexcept { return this->item_count_; }

    size_t totalBytes() const noexcept {
      if (this->item_count_ == 0) {
        return 0;
      }
      const auto * slices = reinterpret_cast<const PayloadSlice *>(this->items_buf.ptr);
      size_t total = 0;
      for (size_t i = 0; i < this->item_count_; ++i) {
        total += slices[i].len;
      }
      return total;
    }

    const PayloadSlice * data() const noexcept {
      return this->item_count_ > 0 ? reinterpret_cast<const PayloadSlice *>(this->items_buf.ptr) : nullptr;
    }
  };

}  // namespace fast_fs_hash

#endif
