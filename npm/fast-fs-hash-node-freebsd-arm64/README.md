> **⚠️ This is a platform-specific binary package.**
>
> You should not install `@fast-fs-hash/fast-fs-hash-node-freebsd-arm64` directly.
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

### Why use FileHashCache?

Build systems, code generators, and CI pipelines often produce output that depends on many
input files. Recomputing that output on every run is expensive — even when nothing changed.

`FileHashCache` solves this by persisting a fingerprint of all input files between runs.
On the next invocation, it checks whether any input changed in **sub-millisecond time**
(stat-only, no re-reading). If nothing changed, you skip the expensive step entirely.

**Common use cases:**

- **Incremental builds**: track source files → skip compilation when inputs are unchanged
- **Generated output caching**: store a compiled bundle, generated types, or processed assets
  alongside the cache — rebuild only when dependencies change
- **CI artifact caching**: validate whether a cached artifact is still fresh before uploading
  or downloading a new one
- **Multi-step pipelines**: each stage writes its own cache file, checked independently

The cache file also supports **user data** — opaque binary payloads stored alongside the
file hashes. This lets you embed build output manifests, dependency graphs, or configuration
snapshots directly in the cache, so a single `open()` tells you both "did anything change?"
and "what was the previous result?" — no separate metadata files needed.

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
| no change          | 0.6 ms (649.0 µs)   | 1 541 op/s | 1 086 209 files/s | —          |
| 1 file changed     | 1.1 ms (1 052.3 µs) | 950 op/s   | 669 963 files/s   | —          |
| many files changed | 2.5 ms (2 485.0 µs) | 402 op/s   | 283 699 files/s   | 9.9 GB/s   |
| no existing cache  | 7.5 ms (7 544.2 µs) | 133 op/s   | 93 450 files/s    | 3.3 GB/s   |
| writeNew           | 7.5 ms (7 512.6 µs) | 133 op/s   | 93 842 files/s    | 3.3 GB/s   |

<!-- FHC_BENCHMARKS:END -->

<!-- BENCH_ENV:START -->

> Node.js v24.14.1, Vitest 4.x — Apple M4 Max, macOS 25.4.0 (arm64), with anti-virus.
>
> _Results vary by hardware, file sizes, and OS cache state._

<!-- BENCH_ENV:END -->

### FileHashCache API

Every `open()` acquires an exclusive OS-level lock on the cache file. The lock is held
until `close()` is called (or the `using`/`await using` block exits).

```ts
await using ctx = await FileHashCache.open(cachePath, rootPath?, files?, version?, fingerprint?, lockTimeoutMs?, signal?);
// ctx.status: 'upToDate' | 'changed' | 'stale' | 'missing' | 'statsDirty' | 'lockFailed'

await ctx.write(options?);
// options: { files?, rootPath?, userValue0..3?, fingerprint?, userData?, signal? }
// write() releases the lock — ctx is now disposed
```

- **`open()`** locks the cache file, reads from disk, validates version/fingerprint, and stat-matches entries.
- **`write()`** hashes any unresolved entries, LZ4-compresses, writes directly to the locked fd, then releases the lock.
- **`close()`** releases the lock (no-op if `write()` already released it). Also called automatically by `using` / `await using`.

**Cancellation via AbortSignal:**

All async operations accept an optional `AbortSignal` to cancel the lock wait and/or hash phase:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);

const cache = await FileHashCache.open(
  path,
  root,
  files,
  1,
  null,
  -1,
  controller.signal,
);
// If aborted before the lock is acquired → status === 'lockFailed'
```

The file write itself is never cancelled — once hashing completes, the write always runs to
completion to avoid corrupting the cache file. Cancellation only affects lock acquisition and
the stat/hash phase.

The file list can change between runs — `write({ files: newFiles })` remaps matched entries
from the old cache, preserving hashes for unchanged files.

**Lock properties:**

- **Cross-process**: prevents concurrent writers from any process
- **Crash-safe**: automatically released when the process dies (OS-level `fcntl`/`LockFileEx`)
- **Worker-thread-safe**: automatically released when a worker thread is terminated
- **Zero overhead on the happy path**: lock + open + stat-match in a single native async call

**Note:** The file lock is released on the native pool thread after `write()` completes.
When the `write()` promise resolves, the JS-side instance is disposed, but other processes
calling `isLocked()` may briefly still observe the lock before the OS fully releases it.

**Platform implementations:**

- **POSIX (Linux, macOS, FreeBSD)**: `fcntl F_SETLK` / `F_SETLKW` byte-range lock on the cache file
- **Windows**: `LockFileEx` exclusive lock on the cache file

**Timeout control** (`lockTimeoutMs` parameter):

- `-1` (default): block until the lock is available
- `0`: fail immediately if locked
- `>0`: wait up to N milliseconds

When the lock cannot be acquired (timeout, non-blocking, or cancelled via `signal`), `open()`
returns an instance with `status === 'lockFailed'`. You can still call `write()` on it — it
transparently falls back to `writeNew()` with a fresh lock attempt.

```ts
// Non-blocking try
const cache = await FileHashCache.open(path, root, files, 1, null, 0);
try {
  // use cache here
} finally {
  cache.close();
}

// Check if another process holds the lock (non-blocking)
FileHashCache.isLocked(path); // → boolean

// Wait until another process releases the lock
await FileHashCache.waitUnlocked(path, 5000); // → true if unlocked, false on timeout
await FileHashCache.waitUnlocked(path, -1); // block until unlocked
await FileHashCache.waitUnlocked(path, 0); // non-blocking check
await FileHashCache.waitUnlocked(path, -1, controller.signal); // cancellable wait
```

**Static methods:**

| Method                                             | Description                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isLocked(cachePath)`                              | Non-blocking check: returns `true` if another process holds the lock. Uses `fcntl F_GETLK` (POSIX) or `LockFileEx` (Windows). Only detects cross-process locks.                                                    |
| `waitUnlocked(cachePath, lockTimeoutMs?, signal?)` | Wait until the lock is released. `-1` = block forever, `0` = non-blocking, `>0` = timeout ms. For infinite waits, blocks in the kernel with zero CPU. Returns `true` if unlocked, `false` on timeout/cancellation. |
| `writeNew(cachePath, rootPath, files, options?)`   | Write a brand-new cache without reading the old one. Options include `signal` for cancellation. Useful when you know a full rebuild is needed.                                                                     |

### Example: Simple build cache

```ts
import { FileHashCache } from "fast-fs-hash";
import { globSync } from "node:fs";

const files = globSync("src/**/*.ts");
await using ctx = await FileHashCache.open(".cache/build.fsh", ".", files, 1);

if (ctx.status === "upToDate") {
  console.log("Build cache is fresh — skipping.");
} else {
  console.log("Files changed — rebuilding...");
  await runBuild();
  await ctx.write();
  // write() released the lock
}
// `await using` calls close() (no-op if write() already released)
```

### Example: Dynamic file list + user data

When the full file list is only known after a build step, open with `null` files
(reuses the list from the previous cache), then pass the actual files to `write()`:

```ts
import { FileHashCache } from "fast-fs-hash";

export async function getBuildOutput() {
  await using ctx = await FileHashCache.open(".cache/tsc.fsh", ".", null, 2);

  if (ctx.status === "upToDate" && ctx.userData.length > 0) {
    return JSON.parse(ctx.userData[0].toString());
  }

  const result = runBuild();
  const outputFiles = result.getSourceFiles().map((f) => f.fileName);

  await ctx.write({
    files: outputFiles,
    userData: [Buffer.from(JSON.stringify(result.output))],
  });

  return result.output;
}
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
| native               | 0.04 ms (41.6 µs) | 24 066 op/s | 4.7 GB/s   | **6.6× faster** |
| Node.js crypto (md5) | 0.3 ms (273.6 µs) | 3 656 op/s  | 721 MB/s   | baseline        |

**medium file (~49.9 KB):**

| Scenario             | Mean              | Hz          | Throughput | Relative        |
| -------------------- | ----------------- | ----------- | ---------- | --------------- |
| native               | 0.02 ms (24.7 µs) | 40 542 op/s | 2.0 GB/s   | **4.5× faster** |
| Node.js crypto (md5) | 0.1 ms (110.7 µs) | 9 035 op/s  | 451 MB/s   | baseline        |

**small file (~1.0 KB):**

| Scenario             | Mean              | Hz          | Relative        |
| -------------------- | ----------------- | ----------- | --------------- |
| native               | 0.02 ms (23.6 µs) | 42 418 op/s | **2.4× faster** |
| Node.js crypto (md5) | 0.06 ms (57.7 µs) | 17 320 op/s | baseline        |

<!-- HASHFILE_BENCHMARKS:END -->

### Parallel file hashing (705 files)

<!-- BENCHMARKS:START -->

| Scenario             | Mean                  | Hz       | Throughput | Relative        |
| -------------------- | --------------------- | -------- | ---------- | --------------- |
| native               | 7.3 ms (7 297.0 µs)   | 137 op/s | 3.4 GB/s   | **4.9× faster** |
| Node.js crypto (md5) | 35.7 ms (35 726.3 µs) | 28 op/s  | 691 MB/s   | baseline        |

<!-- BENCHMARKS:END -->

### In-memory buffer hashing

<!-- HASH_BUFFER_BENCHMARKS:START -->

**64 KB buffer:**

| Scenario           | Mean              | Hz           | Throughput | Relative         |
| ------------------ | ----------------- | ------------ | ---------- | ---------------- |
| native XXH3-128    | 0.001 ms (1.4 µs) | 730 691 op/s | 47.9 GB/s  | **48.7× faster** |
| Node.js crypto md5 | 0.07 ms (66.6 µs) | 15 013 op/s  | 984 MB/s   | baseline         |

**1 MB buffer:**

| Scenario           | Mean                | Hz          | Throughput | Relative         |
| ------------------ | ------------------- | ----------- | ---------- | ---------------- |
| native XXH3-128    | 0.02 ms (21.2 µs)   | 47 148 op/s | 49.4 GB/s  | **49.8× faster** |
| Node.js crypto md5 | 1.1 ms (1 056.4 µs) | 947 op/s    | 993 MB/s   | baseline         |

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

### Hex string convenience

```ts
import { digestFileToHex, digestFilesToHexArray } from "fast-fs-hash";

// Single file → 32-char hex string
const hex = await digestFileToHex("package.json");

// Multiple files in parallel → per-file hex strings
const hexes = await digestFilesToHexArray(["src/a.ts", "src/b.ts"], 8);
```

| Function                                                    | Description                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `digestFileToHex(path, throwOnError?)`                      | Hash a file → 32-char hex string. Wrapper around digestFile + hashToHex |
| `digestFilesToHexArray(paths, concurrency?, throwOnError?)` | Hash files in parallel → per-file hex strings. Default concurrency 8    |

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
| native LZ4              | 0.7%  | 0.003 ms (3.3 µs) | 304 314 op/s | 19.9 GB/s  | **7.3× faster** |
| Node.js deflate level=1 | 1.0%  | 0.02 ms (24.0 µs) | 41 686 op/s  | 2.7 GB/s   | baseline        |

**decompress 64 KB:**

| Scenario        | Mean              | Hz           | Throughput | Relative        |
| --------------- | ----------------- | ------------ | ---------- | --------------- |
| native LZ4      | 0.003 ms (2.6 µs) | 386 927 op/s | 25.4 GB/s  | **3.6× faster** |
| Node.js deflate | 0.009 ms (9.4 µs) | 106 748 op/s | 7.0 GB/s   | baseline        |

**compress 1 MB:**

| Scenario                | Ratio | Mean              | Hz          | Throughput | Relative        |
| ----------------------- | ----- | ----------------- | ----------- | ---------- | --------------- |
| native LZ4              | 0.4%  | 0.03 ms (33.2 µs) | 30 097 op/s | 31.6 GB/s  | **9.8× faster** |
| Node.js deflate level=1 | 0.7%  | 0.3 ms (324.2 µs) | 3 084 op/s  | 3.2 GB/s   | baseline        |

**decompress 1 MB:**

| Scenario        | Mean              | Hz          | Throughput | Relative        |
| --------------- | ----------------- | ----------- | ---------- | --------------- |
| native LZ4      | 0.03 ms (32.2 µs) | 31 054 op/s | 32.6 GB/s  | **3.3× faster** |
| Node.js deflate | 0.1 ms (107.6 µs) | 9 290 op/s  | 9.7 GB/s   | baseline        |

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

| Function                                                                                           | Description                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `lz4CompressBlock(input, offset?, length?)`                                                        | Sync compress → new Buffer                                                           |
| `lz4CompressBlockTo(input, output, outputOffset?, inputOffset?, inputLength?)`                     | Sync compress into pre-allocated buffer → bytes written                              |
| `lz4CompressBlockAsync(input, offset?, length?)`                                                   | Async compress on pool thread → Promise\<Buffer\>                                    |
| `lz4DecompressBlock(input, uncompressedSize, offset?, length?)`                                    | Sync decompress → new Buffer                                                         |
| `lz4DecompressBlockTo(input, uncompressedSize, output, outputOffset?, inputOffset?, inputLength?)` | Sync decompress into pre-allocated buffer → bytes written                            |
| `lz4DecompressBlockAsync(input, uncompressedSize, offset?, length?)`                               | Async decompress on pool thread → Promise\<Buffer\>                                  |
| `lz4CompressBound(inputSize)`                                                                      | Max compressed size for pre-allocation                                               |
| `lz4ReadAndCompress(path)`                                                                         | Read a file and LZ4-compress it on pool thread → `Promise<{data, uncompressedSize}>` |
| `lz4DecompressAndWrite(compressedData, uncompressedSize, path)`                                    | Decompress and write to file on pool thread (creates dirs) → `Promise<boolean>`      |

> **Note:** LZ4 block compression supports inputs up to ~1.9 GiB (`LZ4_MAX_INPUT_SIZE = 0x7E000000`).
> `lz4ReadAndCompress` and `lz4DecompressAndWrite` support files up to 512 MiB.

### Read and compress a file

`lz4ReadAndCompress` reads a file and LZ4-block-compresses it in a single pool-thread operation —
no JS-thread I/O, no intermediate Buffer allocation visible to the event loop.

```ts
import {
  lz4ReadAndCompress,
  lz4DecompressAndWrite,
  lz4DecompressBlock,
} from "fast-fs-hash";

const { data, uncompressedSize } = await lz4ReadAndCompress("large-file.bin");
console.log(`Compressed ${uncompressedSize} → ${data.length} bytes`);

// Decompress back to a file (creates parent directories if needed)
await lz4DecompressAndWrite(data, uncompressedSize, "restored-file.bin");

// Or decompress to a buffer in memory
const original = lz4DecompressBlock(data, uncompressedSize);
```

---

## File Comparison

Compare two files for byte-equality asynchronously on a native pool thread. Opens both files,
compares sizes via `fstat`, then reads in lockstep chunks with `memcmp`. Returns `false` if
either file cannot be opened/read or if sizes differ — never throws.

<!-- FILES_EQUAL_BENCHMARKS:START -->

**equal files (~49.9 KB):**

| Scenario                           | Mean              | Hz          | Throughput | Relative        |
| ---------------------------------- | ----------------- | ----------- | ---------- | --------------- |
| native                             | 0.05 ms (47.0 µs) | 21 261 op/s | 1.1 GB/s   | **2.4× faster** |
| Node.js (fs.open + read + compare) | 0.1 ms (111.4 µs) | 8 978 op/s  | 448 MB/s   | baseline        |

**equal files (~197.3 KB):**

| Scenario                           | Mean              | Hz          | Throughput | Relative        |
| ---------------------------------- | ----------------- | ----------- | ---------- | --------------- |
| native                             | 0.05 ms (48.8 µs) | 20 479 op/s | 4.0 GB/s   | **3.2× faster** |
| Node.js (fs.open + read + compare) | 0.2 ms (155.7 µs) | 6 423 op/s  | 1.3 GB/s   | baseline        |

**different content, same size (~49.9 KB):**

| Scenario                           | Mean              | Hz          | Throughput | Relative        |
| ---------------------------------- | ----------------- | ----------- | ---------- | --------------- |
| native                             | 0.04 ms (39.9 µs) | 25 093 op/s | 1.3 GB/s   | **2.7× faster** |
| Node.js (fs.open + read + compare) | 0.1 ms (106.0 µs) | 9 431 op/s  | 471 MB/s   | baseline        |

**different sizes (early exit):**

| Scenario                           | Mean              | Hz          | Relative        |
| ---------------------------------- | ----------------- | ----------- | --------------- |
| native                             | 0.04 ms (37.2 µs) | 26 901 op/s | **2.4× faster** |
| Node.js (fs.open + read + compare) | 0.09 ms (88.8 µs) | 11 261 op/s | baseline        |

<!-- FILES_EQUAL_BENCHMARKS:END -->

```ts
import { filesEqual } from "fast-fs-hash";

if (await filesEqual("output.bin", "expected.bin")) {
  console.log("Files are identical");
} else {
  console.log("Files differ (or one doesn't exist)");
}
```

| Function                   | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `filesEqual(pathA, pathB)` | Async byte-equality check on pool thread → `Promise<boolean>` |

---

## Utility Functions

| Function                                             | Description                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `hashToHex(digest)`                                  | Convert a 16-byte digest to a 32-char hex string                     |
| `hashesToHexArray(digests)`                          | Convert an array of digests to hex strings                           |
| `findCommonRootPath(files, baseRoot?, allowedRoot?)` | Longest common parent directory of file paths                        |
| `normalizeFilePaths(rootPath, files)`                | Resolve, sort, deduplicate paths relative to root                    |
| `toRelativePath(rootPath, filePath)`                 | Single path → clean unix-style relative path (or null)               |
| `threadPoolTrim()`                                   | Wake idle native pool threads so they self-terminate and free memory |

---

## Environment Variables

| Variable                            | Default     | Description                                                                                                                                                     |
| ----------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAST_FS_HASH_ISA`                  | auto-detect | Override SIMD variant: `avx512`, `avx2`, or `baseline` (x64 only)                                                                                               |
| `FAST_FS_HASH_POOL_IDLE_TIMEOUT_MS` | `15000`     | Idle timeout for native pool threads (1–3600000 ms). Threads self-terminate after this duration with no work. They respawn automatically when new work arrives. |

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

## Release process

- **`main`** — development branch. CI runs lint, typecheck, tests, and builds native binaries for all platforms on every push and PR.
- **`publish`** — release branch. Pushing to `publish` triggers the full CI pipeline. After all builds and tests pass, a dry-run publish verifies all packages. An admin must then manually approve the publish job (via the `npm-publish` GitHub environment) to publish to npm, create a git tag, and deploy docs.

npm packages are published with [provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC — no npm tokens are stored in CI.

### Required GitHub repository settings

- **Branch protection on `publish`**: require PR reviews, require status checks to pass, restrict push access to admins only.
- **Environment `npm-publish`**: create under Settings → Environments with "Required reviewers" restricted to trusted maintainers.
- **npm trusted publishing**: configure each `@fast-fs-hash/*` package on npmjs.com to trust the `npm-publish` environment from this repository.

## License

[MIT](LICENSE) — Copyright (c) 2025-present Salvatore Previti
