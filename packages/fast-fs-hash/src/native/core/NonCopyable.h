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
