> **⚠️ This is a platform-specific binary package.**
>
> You should not install `@fast-fs-hash/fast-fs-hash-node-darwin-x64` directly.
> Instead, install the main package which will automatically select the correct binary for your platform:
>
> ```sh
> npm install fast-fs-hash
> ```
>
> See [fast-fs-hash on npm](https://www.npmjs.com/package/fast-fs-hash) for documentation.

---
# fast-fs-hash

[![npm](https://img.shields.io/npm/v/fast-fs-hash)](https://www.npmjs.com/package/fast-fs-hash)
[![GitHub](https://img.shields.io/github/license/SalvatorePreviti/fast-fs-hash)](https://github.com/SalvatorePreviti/fast-fs-hash)
[![API Docs](https://img.shields.io/badge/docs-API-blue)](https://salvatorepreviti.github.io/fast-fs-hash/)

> _"There are only two hard things in Computer Science: cache invalidation and naming things."_
> — Phil Karlton

If you ever needed to check whether a set of files changed — to invalidate a cache,
skip redundant builds, or trigger incremental CI — **fast-fs-hash** is for you.

It hashes hundreds of files in milliseconds using [xxHash3-128](https://github.com/Cyan4973/xxHash)
via a native C++ addon with SIMD acceleration.

[xxHash3](https://en.wikipedia.org/wiki/XxHash) is a **non-cryptographic** hash function — it is not
suitable for security purposes, but it is more than enough for cache invalidation, deduplication, and
change detection, which is what this library is designed for.

_Note: Unfortunately this package will not help you naming things — if you don't like staring at hexadecimal hashes._

**Requires Node.js >= 22.**

<!-- BENCH_ENV:START -->

> Node.js v22.22.0, Vitest 4.x — Apple M3 Max, macOS 24.6.0 (arm64)
>
> _Results vary by hardware, file sizes, and OS cache state._

<!-- BENCH_ENV:END -->

## Installation

```bash
npm install fast-fs-hash
```

**Requires Node.js >= 22.**

The native addon is **prebuilt** for common platforms via platform-specific optional
dependencies. When you run `npm install`, npm automatically installs only the
package matching your current OS and architecture.

Supported platforms: **macOS**, **Linux** (glibc & musl), **Windows**, **FreeBSD** — both **x64** and **arm64**.

On x64, optimized variants for **AVX2** and **AVX-512** are included and selected automatically at load time via native CPUID detection. Set `FAST_FS_HASH_ISA=avx2|avx512|baseline` to override.

**CI note:** Some CI configurations disable optional dependencies by default
(e.g. `npm install --no-optional` or `--omit=optional`). To get the native addon
in CI, either allow optional dependencies or install the platform package explicitly:

```bash
npm install @fast-fs-hash/fast-fs-hash-node-linux-x64-gnu
```

---

## FileHashCache — Binary cache invalidation

`FileHashCache` reads, validates, and writes a compact binary cache file that tracks per-file
stat metadata (inode, mtime, ctime, size) and content hashes (xxHash3-128).

On the next run it re-stats every tracked file and compares — files whose stat matches are
skipped entirely (no re-read), giving near-instant validation for large file sets.

### Why not just hash everything?

Hashing is fast, but reading thousands of files from disk is not. `FileHashCache` avoids
re-reading files that haven't changed by comparing `stat()` metadata first. Only files with
changed stat are re-hashed. This makes cache validation **O(n × stat)** instead of
**O(n × read + hash)** — typically 10-100× faster for warm caches.

### FileHashCache benchmarks (705 files, ~24 MiB)

<!-- FHC_BENCHMARKS:START -->

**Native (C++ addon):**

| Scenario           | Mean                | Hz         | Files/s           | Throughput |
| ------------------ | ------------------- | ---------- | ----------------- | ---------- |
| no change          | 0.5 ms (502.0 µs)   | 1 992 op/s | 1 404 297 files/s | —          |
| 1 file changed     | 1.1 ms (1 079.0 µs) | 927 op/s   | 653 404 files/s   | —          |
| many files changed | 1.7 ms (1 738.5 µs) | 575 op/s   | 405 521 files/s   | 14.2 GB/s  |
| no existing cache  | 4.0 ms (4 008.8 µs) | 249 op/s   | 175 862 files/s   | 6.2 GB/s   |

<!-- FHC_BENCHMARKS:END -->

### FileHashCache API

```ts
const ctx = await FileHashCache.open(cachePath, rootPath?, files?, version?, fingerprint?);
// ctx.status: 'upToDate' | 'changed' | 'stale' | 'missing' | 'statsDirty'

await ctx.write(options?);
// options: { files?, rootPath?, userValue0..3?, fingerprint?, userData? }
```

- **`open()`** reads the cache file, validates version/fingerprint, and stat-matches entries.
- **`write()`** hashes any unresolved entries, LZ4-compresses, and atomically writes to disk.

The file list can change between runs — `write({ files: newFiles })` remaps matched entries
from the old cache, preserving hashes for unchanged files.

### Example: Simple build cache

```ts
import { FileHashCache } from "fast-fs-hash";
import { globSync } from "node:fs";

const files = globSync("src/**/*.ts");
const ctx = await FileHashCache.open(".cache/build.fsh", ".", files, 1);

if (ctx.status === "upToDate") {
  console.log("Build cache is fresh — skipping.");
} else {
  console.log("Files changed — rebuilding...");
  await runBuild();
  await ctx.write();
}
```

### Example: Dynamic file list + user data

```ts
import { FileHashCache } from "fast-fs-hash";

const ctx = await FileHashCache.open(".cache/tsc.fsh", ".", entryPoints, 2);

if (ctx.status === "upToDate" && ctx.userData.length > 0) {
  return JSON.parse(ctx.userData[0].toString());
}

const result = compile(entryPoints);
const actualFiles = result.getSourceFiles().map((f) => f.fileName);

await ctx.write({
  files: actualFiles,
  userData: [Buffer.from(JSON.stringify(result.output))],
});

return result.output;
```

---

## xxHash128 — Direct hashing

When you don't need a persistent cache file — or you want raw xxHash3-128 digests to
compare yourself — use the digest functions directly. `FileHashCache` uses them under the
hood, but they are fully usable on their own.

### File hashing benchmarks

<!-- HASHFILE_BENCHMARKS:START -->

**large file (~197.3 KB):**

| Scenario             | Mean              | Hz          | Throughput | Relative        |
| -------------------- | ----------------- | ----------- | ---------- | --------------- |
| native               | 0.03 ms (34.8 µs) | 28 743 op/s | 5.7 GB/s   | **8.8× faster** |
| Node.js crypto (md5) | 0.3 ms (307.7 µs) | 3 250 op/s  | 641 MB/s   | baseline        |

**medium file (~49.9 KB):**

| Scenario             | Mean              | Hz          | Throughput | Relative        |
| -------------------- | ----------------- | ----------- | ---------- | --------------- |
| native               | 0.02 ms (17.0 µs) | 58 843 op/s | 2.9 GB/s   | **7.2× faster** |
| Node.js crypto (md5) | 0.1 ms (122.6 µs) | 8 159 op/s  | 407 MB/s   | baseline        |

**small file (~1.0 KB):**

| Scenario             | Mean              | Hz          | Relative        |
| -------------------- | ----------------- | ----------- | --------------- |
| native               | 0.01 ms (14.9 µs) | 67 114 op/s | **3.1× faster** |
| Node.js crypto (md5) | 0.05 ms (46.4 µs) | 21 556 op/s | baseline        |

<!-- HASHFILE_BENCHMARKS:END -->

### Parallel file hashing (705 files)

<!-- BENCHMARKS:START -->

| Scenario             | Mean                  | Hz       | Throughput | Relative         |
| -------------------- | --------------------- | -------- | ---------- | ---------------- |
| native               | 3.0 ms (2 963.6 µs)   | 337 op/s | 8.3 GB/s   | **14.3× faster** |
| Node.js crypto (md5) | 42.4 ms (42 370.5 µs) | 24 op/s  | 583 MB/s   | baseline         |

<!-- BENCHMARKS:END -->

### In-memory buffer hashing

<!-- HASH_BUFFER_BENCHMARKS:START -->

**64 KB buffer:**

| Scenario           | Mean              | Hz           | Throughput | Relative         |
| ------------------ | ----------------- | ------------ | ---------- | ---------------- |
| native XXH3-128    | 0.002 ms (1.6 µs) | 634 512 op/s | 41.6 GB/s  | **52.0× faster** |
| Node.js crypto md5 | 0.08 ms (82.0 µs) | 12 194 op/s  | 799 MB/s   | baseline         |

**1 MB buffer:**

| Scenario           | Mean                | Hz          | Throughput | Relative         |
| ------------------ | ------------------- | ----------- | ---------- | ---------------- |
| native XXH3-128    | 0.02 ms (24.4 µs)   | 40 903 op/s | 42.9 GB/s  | **52.5× faster** |
| Node.js crypto md5 | 1.3 ms (1 284.1 µs) | 779 op/s    | 817 MB/s   | baseline         |

<!-- HASH_BUFFER_BENCHMARKS:END -->

### Hash files

```ts
import { digestFilesParallel, hashToHex } from "fast-fs-hash";

const digest = await digestFilesParallel([
  "package.json",
  "src/index.ts",
  "src/utils.ts",
]);
console.log("Aggregate:", hashToHex(digest));
```

Sequential variant (feeds files into a single running hash):

```ts
import { digestFilesSequential, hashToHex } from "fast-fs-hash";

const digest = await digestFilesSequential(["package.json", "src/index.ts"]);
console.log(hashToHex(digest));
```

### Hash a single file

```ts
import { digestFile, hashToHex } from "fast-fs-hash";

const digest = await digestFile("package.json");
console.log(hashToHex(digest));
```

### Hash buffers and strings

```ts
import { digestBuffer, digestString } from "fast-fs-hash";

const d1 = digestBuffer(myBuffer);
const d2 = digestString("hello world");
console.log(d2.toString("hex"));
```

### Streaming class

For combining file hashes with extra data (config, environment, etc.):

```ts
import { XxHash128Stream } from "fast-fs-hash";

const h = new XxHash128Stream();
h.addString("my-config-v2");
await h.addFiles(["src/index.ts", "src/utils.ts"]);
console.log(h.digest().toString("hex"));
```

---

## LZ4 Block Compression

fast-fs-hash exposes the [LZ4](https://github.com/lz4/lz4) block compression API used internally
for the cache file format. Both synchronous and asynchronous (pool-thread) variants are available.

LZ4 block format does **not** embed the uncompressed size — the caller must store it alongside the
compressed data and pass it to the decompression function.

<!-- LZ4_BENCHMARKS:START -->

**compress 64 KB:**

| Scenario                | Ratio | Mean              | Hz           | Throughput | Relative        |
| ----------------------- | ----- | ----------------- | ------------ | ---------- | --------------- |
| native LZ4              | 0.7%  | 0.004 ms (4.3 µs) | 233 609 op/s | 15.3 GB/s  | **8.0× faster** |
| Node.js deflate level=1 | 1.0%  | 0.03 ms (34.2 µs) | 29 227 op/s  | 1.9 GB/s   | baseline        |

**decompress 64 KB:**

| Scenario        | Mean              | Hz           | Throughput | Relative        |
| --------------- | ----------------- | ------------ | ---------- | --------------- |
| native LZ4      | 0.003 ms (2.9 µs) | 340 142 op/s | 22.3 GB/s  | **3.8× faster** |
| Node.js deflate | 0.01 ms (11.1 µs) | 89 820 op/s  | 5.9 GB/s   | baseline        |

**compress 1 MB:**

| Scenario                | Ratio | Mean              | Hz          | Throughput | Relative         |
| ----------------------- | ----- | ----------------- | ----------- | ---------- | ---------------- |
| native LZ4              | 0.4%  | 0.04 ms (35.9 µs) | 27 849 op/s | 29.2 GB/s  | **12.2× faster** |
| Node.js deflate level=1 | 0.7%  | 0.4 ms (437.5 µs) | 2 286 op/s  | 2.4 GB/s   | baseline         |

**decompress 1 MB:**

| Scenario        | Mean              | Hz          | Throughput | Relative        |
| --------------- | ----------------- | ----------- | ---------- | --------------- |
| native LZ4      | 0.07 ms (74.2 µs) | 13 478 op/s | 14.1 GB/s  | **1.8× faster** |
| Node.js deflate | 0.1 ms (134.0 µs) | 7 463 op/s  | 7.8 GB/s   | baseline        |

<!-- LZ4_BENCHMARKS:END -->

```ts
import {
  lz4CompressBlock,
  lz4DecompressBlock,
  lz4CompressBound,
} from "fast-fs-hash";

const input = Buffer.from("Hello, LZ4!");
const compressed = lz4CompressBlock(input);
const decompressed = lz4DecompressBlock(compressed, input.length);
console.log(decompressed.toString()); // "Hello, LZ4!"
```

### LZ4 API

| Function                                                                                           | Description                                               |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `lz4CompressBlock(input, offset?, length?)`                                                        | Sync compress → new Buffer                                |
| `lz4CompressBlockTo(input, output, outputOffset?, inputOffset?, inputLength?)`                     | Sync compress into pre-allocated buffer → bytes written   |
| `lz4CompressBlockAsync(input, offset?, length?)`                                                   | Async compress on pool thread → Promise\<Buffer\>         |
| `lz4DecompressBlock(input, uncompressedSize, offset?, length?)`                                    | Sync decompress → new Buffer                              |
| `lz4DecompressBlockTo(input, uncompressedSize, output, outputOffset?, inputOffset?, inputLength?)` | Sync decompress into pre-allocated buffer → bytes written |
| `lz4DecompressBlockAsync(input, uncompressedSize, offset?, length?)`                               | Async decompress on pool thread → Promise\<Buffer\>       |
| `lz4CompressBound(inputSize)`                                                                      | Max compressed size for pre-allocation                    |

> **Note:** LZ4 block compression supports inputs up to ~1.9 GiB (`LZ4_MAX_INPUT_SIZE = 0x7E000000`).

---

## Locking — KeyedLock & ProcessLock

<!-- LOCK_BENCHMARKS:START -->

| Scenario    | Mean               | Hz             | Relative          |
| ----------- | ------------------ | -------------- | ----------------- |
| KeyedLock   | 0.0002 ms (0.2 µs) | 5 394 950 op/s | **102.3× faster** |
| ProcessLock | 0.02 ms (19.0 µs)  | 52 718 op/s    | baseline          |

<!-- LOCK_BENCHMARKS:END -->

Both `KeyedLock` and `ProcessLock` implement the same `IKeyedLock` interface.

|                  | `KeyedLock`                | `ProcessLock`                                             |
| ---------------- | -------------------------- | --------------------------------------------------------- |
| **Scope**        | Single process (in-memory) | Cross-process (OS-level)                                  |
| **Key type**     | Any value (`unknown`)      | `string` (hashed to OS identifier)                        |
| **Mechanism**    | Promise chaining           | POSIX shared memory mutex / Windows named mutex           |
| **Crash safety** | N/A (in-process)           | Automatic — stale locks from dead processes are recovered |
| **Overhead**     | Zero (no syscalls)         | ~20µs per acquire (shm_open, mmap, mutex)                 |

### KeyedLock — In-process locking

```ts
import { KeyedLock } from "fast-fs-hash";

await using lock = await KeyedLock.acquire("my-key");
// ... exclusive access within this process ...
```

### ProcessLock — Cross-process locking

`ProcessLock` includes built-in in-process serialization (same promise chaining as `KeyedLock`)
so concurrent acquires from the same process are serialized without redundant OS-level lock attempts.

```ts
import { ProcessLock } from "fast-fs-hash";

await using lock = await ProcessLock.acquire("my-cache");
// ... exclusive access across all processes ...
```

### Example: Protecting FileHashCache with ProcessLock

```ts
import { FileHashCache, ProcessLock } from "fast-fs-hash";

const cachePath = ".cache/build.fsh";
const files = globSync("src/**/*.ts");

await using lock = await ProcessLock.acquire(cachePath);

const ctx = await FileHashCache.open(cachePath, ".", files, 1);
if (ctx.status !== "upToDate") {
  await runBuild();
  await ctx.write();
}
```

### Lock API

Both classes support the instance API for reuse:

```ts
const lock = new KeyedLock("my-key"); // or new ProcessLock("my-key")
await lock.acquire();
try { ... } finally { lock.release(); }
// can call lock.acquire() again after release
```

| Member               | KeyedLock                      | ProcessLock                          | Description                                     |
| -------------------- | ------------------------------ | ------------------------------------ | ----------------------------------------------- |
| `new Lock(key)`      | `new KeyedLock(key, map?)`     | `new ProcessLock(key)`               | Create unacquired lock                          |
| `Lock.acquire(key)`  | `KeyedLock.acquire(key, map?)` | `ProcessLock.acquire(key, options?)` | Static shorthand → `Promise<Lock>`              |
| `lock.acquire()`     | ✓                              | `lock.acquire(options?)`             | Acquire, waiting for previous holder            |
| `lock.release()`     | ✓                              | ✓                                    | Release → `true` if held                        |
| `lock.ownsLock`      | ✓                              | ✓                                    | This instance owns the lock                     |
| `lock.locked`        | In-process only                | Cross-process check                  | Key is locked by anyone                         |
| `lock.key`           | ✓                              | ✓                                    | The lock key                                    |
| `lock.promise`       | ✓                              | ✓                                    | Resolves when released. `undefined` if not held |
| `Lock.count`         | ✓                              | ✓                                    | Number of keys held                             |
| `Lock.isLocked(key)` | In-process only                | Cross-process check                  | Whether a key is locked                         |

ProcessLock options: `{ timeout?: number }` — `-1` = wait forever (default), `0` = try once, `>0` = wait up to N ms

---

## Utility Functions

| Function                                             | Description                                            |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `hashToHex(digest)`                                  | Convert a 16-byte digest to a 32-char hex string       |
| `hashesToHexArray(digests)`                          | Convert an array of digests to hex strings             |
| `findCommonRootPath(files, baseRoot?, allowedRoot?)` | Longest common parent directory of file paths          |
| `normalizeFilePaths(rootPath, files)`                | Resolve, sort, deduplicate paths relative to root      |
| `toRelativePath(rootPath, filePath)`                 | Single path → clean unix-style relative path (or null) |

---

## Acknowledgements

The native C++ backend uses:

- [xxHash](https://github.com/Cyan4973/xxHash) by Yann Collet — xxHash3-128 hashing
  ([BSD 2-Clause License](https://github.com/Cyan4973/xxHash/blob/dev/LICENSE))
- [LZ4](https://github.com/lz4/lz4) by Yann Collet — block compression
  ([BSD 2-Clause License](https://github.com/lz4/lz4/blob/dev/LICENSE))

See [NOTICES.md](NOTICES.md) for full license texts.

## Building from source

### Prerequisites

| Tool           | Version                         | Install                                                                     |
| -------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Node.js        | >= 22                           | [nodejs.org](https://nodejs.org)                                            |
| npm            | >= 9                            | bundled with Node.js                                                        |
| CMake          | >= 3.15                         | `brew install cmake` / `apt install cmake` / [cmake.org](https://cmake.org) |
| C++20 compiler | Clang 14+ / GCC 12+ / MSVC 2022 | Xcode CLT / `build-essential` / Visual Studio                               |

### Quick start

```bash
git clone --recurse-submodules https://github.com/SalvatorePreviti/fast-fs-hash.git
cd fast-fs-hash
npm install
npm run build:all   # compile C++ addon + TypeScript
npm test            # run tests
npm run bench       # run benchmarks
```

> **Note:** `git clone --recurse-submodules` is required to pull `deps/xxHash` (the xxHash
> source used by the native addon).

### Git submodule (xxHash)

The `deps/xxHash/` directory is a git submodule pointing to [xxHash](https://github.com/Cyan4973/xxHash) v0.8.3.

If you cloned without `--recurse-submodules`, initialize the submodule manually:

```bash
git submodule update --init --recursive
```

See `package.json` for the full list of available build scripts.

## License

[MIT](LICENSE) — Copyright (c) 2025-present Salvatore Previti
