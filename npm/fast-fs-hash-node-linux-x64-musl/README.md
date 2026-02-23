> **⚠️ This is a platform-specific binary package.**
>
> You should not install `@fast-fs-hash/fast-fs-hash-node-linux-x64-musl` directly.
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

**Zero external dependencies.** Requires Node.js >= 22.

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
| no change          | 0.5 ms (527.3 µs)   | 1 896 op/s | 1 336 947 files/s | —          |
| 1 file changed     | 0.9 ms (919.3 µs)   | 1 088 op/s | 766 897 files/s   | —          |
| many files changed | 2.3 ms (2 310.4 µs) | 433 op/s   | 305 148 files/s   | 10.7 GB/s  |
| no existing cache  | 7.2 ms (7 222.1 µs) | 138 op/s   | 97 617 files/s    | 3.4 GB/s   |
| overwrite          | 7.5 ms (7 451.8 µs) | 134 op/s   | 94 608 files/s    | 3.3 GB/s   |

<!-- FHC_BENCHMARKS:END -->

<!-- BENCH_ENV:START -->

> Node.js v24.14.1, Vitest 4.x — Apple M4 Max, macOS 25.4.0 (arm64), with anti-virus.
>
> _Results vary by hardware, file sizes, and OS cache state._

<!-- BENCH_ENV:END -->

### FileHashCache API

A long-lived cache that tracks file content hashes with exclusive OS-level locking.
Create the instance once, then call `open()` on each build cycle. Configuration
(files, version, fingerprint) is set via the constructor, setters, or `configure()`.

### Example: Build cache with dynamic file list

The typical usage: the file list is only known after a build step. Open without files
(reuses the list from the previous cache on disk), then set the new file list before writing.
Use `payloadData` to store arbitrary build metadata alongside the cache.

```ts
import { FileHashCache } from "fast-fs-hash";

const cache = new FileHashCache({
  cachePath: ".cache/build.fsh",
  rootPath: ".",
  version: 1,
});

export async function build() {
  using session = await cache.open();

  if (session.status === "upToDate" && session.payloadData.length > 0) {
    return JSON.parse(session.payloadData[0].toString()); // cached result
  }

  const result = await runBuild();

  cache.configure({ files: result.getSourceFiles().map((f) => f.fileName) });

  await session.write({
    payloadData: [Buffer.from(JSON.stringify(result.output))],
  });

  return result.output;
}
```

### Example: Simple build cache with known files

When the file list is known upfront, pass it to the constructor:

```ts
import { FileHashCache } from "fast-fs-hash";
import { globSync } from "node:fs";

const cache = new FileHashCache({
  cachePath: ".cache/build.fsh",
  rootPath: ".",
  files: globSync("src/**/*.ts"),
  version: 1,
});

using session = await cache.open();

if (session.status === "upToDate") {
  console.log("Build cache is fresh — skipping.");
} else {
  console.log("Files changed — rebuilding...");
  await runBuild();
  await session.write();
}
```

### API Reference

**Constructor:** `new FileHashCache({ cachePath, files?, rootPath?, version?, fingerprint?, lockTimeoutMs? })`

**Cache configuration** (mutable between opens):

- **`configure(opts)`** — set multiple config fields at once: `files`, `rootPath`, `version`, `fingerprint`, `lockTimeoutMs`
- Setters: `cache.files`, `cache.rootPath`, `cache.version`, `cache.fingerprint`, `cache.lockTimeoutMs`
- `needsOpen` — `true` when config changed since last open, or cache was never opened

**Cache methods:**

- **`open(signal?)`** — acquires an exclusive lock, reads from disk, validates version/fingerprint, stat-matches entries. Returns a `FileHashCacheSession`.
- **`overwrite(options?)`** — writes a brand-new cache without reading the old one. Options: `payloadValue0..3`, `payloadData`, `signal`, `lockTimeoutMs`.
- **`invalidate(paths)`** / **`invalidateAll()`** — mark files as dirty for the next open (watch mode).
- **`isLocked()`** / **`waitUnlocked(timeout?, signal?)`** — check or wait for lock.
- **`checkCacheFile()`** — sync stat check if the cache file on disk changed since last open.

**Session properties (read-only, from disk):**

- `status` — `'upToDate'` | `'changed'` | `'stale'` | `'missing'` | `'statsDirty'` | `'lockFailed'`
- `needsWrite` — `true` if the session holds the lock and the status indicates changes
- `configChanged` — `true` if cache config was modified since this session was opened
- `wouldNeedWrite` — `true` if either files changed on disk or config changed
- `busy` / `disposed` — async operation state
- `files`, `fileCount`, `version`, `rootPath`
- `payloadValue0..3` — four f64 numeric values read from disk
- `payloadData` — array of binary Buffer payloads read from disk

**Session methods:**

- **`write(options?)`** — hashes unresolved entries, compresses, writes to disk, releases lock. Can only be called once. Options: `payloadValue0..3`, `payloadData`, `signal`.
- **`resolve(signal?)`** — completes stat + hash for ALL files, returns `FileHashCacheEntries`. Can be called before `write()`. See below.
- **`close()`** — releases the lock. Also called automatically by `using`.

**Static methods:**

- `FileHashCache.isLocked(cachePath)` — check if locked by another process
- `FileHashCache.waitUnlocked(cachePath, lockTimeoutMs?, signal?)` — wait for unlock

**Lock behavior:**

- Cross-process exclusive lock via `fcntl` (POSIX) / `LockFileEx` (Windows)
- Crash-safe: automatically released when the process dies
- `lockTimeoutMs`: `-1` = block forever (default), `0` = non-blocking, `>0` = timeout ms
- When lock fails: `status === 'lockFailed'`. Calling `write()` falls back to `overwrite()`.
- Cancellable via `AbortSignal` on `open()`, `overwrite()`, and `waitUnlocked()`

### Inspecting per-file changes with `resolve()`

After `open()`, the session knows the aggregate status but not which specific files
changed. Call `resolve()` to complete stat + hash for every file and get per-file metadata.

**Note:** `resolve()` stats and hashes every unresolved file on the thread pool. This has
a cost proportional to the number of changed files. Use it only when you need per-file
information — for simple "changed → rebuild all" workflows, just check `session.status`.

```ts
using session = await cache.open();

if (session.status !== "upToDate") {
  const entries = await session.resolve();

  for (const entry of entries) {
    if (entry.changed) {
      console.log(
        `Changed: ${entry.path} (${entry.size} bytes, hash: ${entry.contentHashHex})`,
      );
    }
  }

  await session.write();
}
```

Each `FileHashCacheEntry` provides:

- `path` — absolute file path
- `size` — file size in bytes
- `mtimeMs` / `ctimeMs` — modification / change time in ms
- `changed` — `true` if content differs from the cached version (or is a new file)
- `contentHash` — 16-byte xxHash3-128 as a Buffer (zero-copy view)
- `contentHashHex` — 32-char hex string (lazy, computed on first access)

`FileHashCacheEntries` supports `get(index)`, `find(path)`, and iteration.
The result is cached — subsequent calls to `resolve()` return the same snapshot.

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
| native               | 0.04 ms (45.0 µs) | 22 237 op/s | 4.4 GB/s   | **6.2× faster** |
| Node.js crypto (md5) | 0.3 ms (280.4 µs) | 3 566 op/s  | 704 MB/s   | baseline        |

**medium file (~49.9 KB):**

| Scenario             | Mean              | Hz          | Throughput | Relative        |
| -------------------- | ----------------- | ----------- | ---------- | --------------- |
| native               | 0.03 ms (30.6 µs) | 32 642 op/s | 1.6 GB/s   | **3.8× faster** |
| Node.js crypto (md5) | 0.1 ms (116.3 µs) | 8 601 op/s  | 429 MB/s   | baseline        |

**small file (~1.0 KB):**

| Scenario             | Mean              | Hz          | Relative        |
| -------------------- | ----------------- | ----------- | --------------- |
| native               | 0.02 ms (24.4 µs) | 41 028 op/s | **2.4× faster** |
| Node.js crypto (md5) | 0.06 ms (59.2 µs) | 16 878 op/s | baseline        |

<!-- HASHFILE_BENCHMARKS:END -->

### Parallel file hashing (705 files)

<!-- BENCHMARKS:START -->

| Scenario             | Mean                  | Hz       | Throughput | Relative        |
| -------------------- | --------------------- | -------- | ---------- | --------------- |
| native               | 6.9 ms (6 913.9 µs)   | 145 op/s | 3.6 GB/s   | **5.2× faster** |
| Node.js crypto (md5) | 36.2 ms (36 180.7 µs) | 28 op/s  | 683 MB/s   | baseline        |

<!-- BENCHMARKS:END -->

### In-memory buffer hashing

<!-- HASH_BUFFER_BENCHMARKS:START -->

**64 KB buffer:**

| Scenario           | Mean              | Hz           | Throughput | Relative         |
| ------------------ | ----------------- | ------------ | ---------- | ---------------- |
| native XXH3-128    | 0.001 ms (1.4 µs) | 723 356 op/s | 47.4 GB/s  | **48.8× faster** |
| Node.js crypto md5 | 0.07 ms (67.5 µs) | 14 819 op/s  | 971 MB/s   | baseline         |

**1 MB buffer:**

| Scenario           | Mean                | Hz          | Throughput | Relative         |
| ------------------ | ------------------- | ----------- | ---------- | ---------------- |
| native XXH3-128    | 0.02 ms (21.6 µs)   | 46 273 op/s | 48.5 GB/s  | **50.8× faster** |
| Node.js crypto md5 | 1.1 ms (1 096.9 µs) | 912 op/s    | 956 MB/s   | baseline         |

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

**Busy guard:** Async methods (`addFile`, `addFiles`, `addFilesParallel`) mark the instance
as busy while the native worker thread is processing. During this time, calling any
synchronous method or starting another async operation will throw an error. Always `await`
each async call before invoking another method. Use the `busy` getter to check:

```ts
const h = new XxHash128Stream();
const promise = h.addFile("large.bin");
console.log(h.busy); // true — async operation in flight
// h.addString("oops"); // would throw!
await promise;
console.log(h.busy); // false — safe to use again
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
| native LZ4              | 0.7%  | 0.003 ms (3.4 µs) | 294 887 op/s | 19.3 GB/s  | **7.2× faster** |
| Node.js deflate level=1 | 1.0%  | 0.02 ms (24.5 µs) | 40 794 op/s  | 2.7 GB/s   | baseline        |

**decompress 64 KB:**

| Scenario        | Mean              | Hz           | Throughput | Relative        |
| --------------- | ----------------- | ------------ | ---------- | --------------- |
| native LZ4      | 0.003 ms (2.8 µs) | 358 218 op/s | 23.5 GB/s  | **3.7× faster** |
| Node.js deflate | 0.01 ms (10.2 µs) | 97 756 op/s  | 6.4 GB/s   | baseline        |

**compress 1 MB:**

| Scenario                | Ratio | Mean              | Hz          | Throughput | Relative         |
| ----------------------- | ----- | ----------------- | ----------- | ---------- | ---------------- |
| native LZ4              | 0.4%  | 0.03 ms (34.4 µs) | 29 040 op/s | 30.5 GB/s  | **10.3× faster** |
| Node.js deflate level=1 | 0.7%  | 0.4 ms (355.7 µs) | 2 811 op/s  | 2.9 GB/s   | baseline         |

**decompress 1 MB:**

| Scenario        | Mean              | Hz          | Throughput | Relative        |
| --------------- | ----------------- | ----------- | ---------- | --------------- |
| native LZ4      | 0.03 ms (32.5 µs) | 30 745 op/s | 32.2 GB/s  | **2.9× faster** |
| Node.js deflate | 0.10 ms (95.3 µs) | 10 493 op/s | 11.0 GB/s  | baseline        |

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
| native                             | 0.04 ms (42.6 µs) | 23 485 op/s | 1.2 GB/s   | **2.7× faster** |
| Node.js (fs.open + read + compare) | 0.1 ms (115.0 µs) | 8 694 op/s  | 434 MB/s   | baseline        |

**equal files (~197.3 KB):**

| Scenario                           | Mean              | Hz          | Throughput | Relative        |
| ---------------------------------- | ----------------- | ----------- | ---------- | --------------- |
| native                             | 0.05 ms (50.9 µs) | 19 665 op/s | 3.9 GB/s   | **3.1× faster** |
| Node.js (fs.open + read + compare) | 0.2 ms (159.6 µs) | 6 265 op/s  | 1.2 GB/s   | baseline        |

**different content, same size (~49.9 KB):**

| Scenario                           | Mean              | Hz          | Throughput | Relative        |
| ---------------------------------- | ----------------- | ----------- | ---------- | --------------- |
| native                             | 0.04 ms (41.1 µs) | 24 356 op/s | 1.2 GB/s   | **2.7× faster** |
| Node.js (fs.open + read + compare) | 0.1 ms (109.4 µs) | 9 143 op/s  | 456 MB/s   | baseline        |

**different sizes (early exit):**

| Scenario                           | Mean              | Hz          | Relative        |
| ---------------------------------- | ----------------- | ----------- | --------------- |
| native                             | 0.04 ms (37.5 µs) | 26 664 op/s | **2.4× faster** |
| Node.js (fs.open + read + compare) | 0.09 ms (91.5 µs) | 10 927 op/s | baseline        |

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
