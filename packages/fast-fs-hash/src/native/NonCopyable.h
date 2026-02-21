/**
 * NonCopyable — CRTP-free non-copyable base class.
 *
 * Inherit to delete copy ctor/assign.  Move operations are explicitly
 * defaulted so derived classes can still be move-constructed / move-assigned
 * when they define their own move ops.
 */

#ifndef _FAST_FS_HASH_NON_COPYABLE_H
#define _FAST_FS_HASH_NON_COPYABLE_H

struct NonCopyable {
  NonCopyable() = default;
  ~NonCopyable() = default;
  NonCopyable(const NonCopyable &) = delete;
  NonCopyable & operator=(const NonCopyable &) = delete;
  NonCopyable(NonCopyable &&) noexcept = default;
  NonCopyable & operator=(NonCopyable &&) noexcept = default;
};

#endif
