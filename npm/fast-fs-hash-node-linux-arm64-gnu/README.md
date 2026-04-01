> **⚠️ This is a platform-specific binary package.**
>
> You should not install `@fast-fs-hash/fast-fs-hash-node-linux-arm64-gnu` directly.
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

> Node.js v24.14.1, Vitest 4.x — Apple M4 Max, macOS 25.4.0 (arm64)
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
| no change          | 0.6 ms (644.3 µs)   | 1 552 op/s | 1 094 293 files/s | —          |
| 1 file changed     | 1.0 ms (1 001.2 µs) | 999 op/s   | 704 156 files/s   | —          |
| many files changed | 2.7 ms (2 656.5 µs) | 376 op/s   | 265 383 files/s   | 9.3 GB/s   |
| no existing cache  | 8.1 ms (8 068.0 µs) | 124 op/s   | 87 382 files/s    | 3.1 GB/s   |

<!-- FHC_BENCHMARKS:END -->

### FileHashCache API

Every `open()` acquires an exclusive OS-level lock on the cache file. The lock is held
until `close()` is called (or the `using`/`await using` block exits).

```ts
await using ctx = await FileHashCache.open(cachePath, rootPath?, files?, version?, fingerprint?, timeoutMs?);
// ctx.status: 'upToDate' | 'changed' | 'stale' | 'missing' | 'statsDirty'

await ctx.write(options?);
// options: { files?, rootPath?, userValue0..3?, fingerprint?, userData? }
// lock released here
```

- **`open()`** locks the cache file, reads from disk, validates version/fingerprint, and stat-matches entries.
- **`write()`** hashes any unresolved entries, LZ4-compresses, and writes directly to the locked fd.
- **`close()`** releases the lock. Also called automatically by `using` / `await using`.

The file list can change between runs — `write({ files: newFiles })` remaps matched entries
from the old cache, preserving hashes for unchanged files.

**Lock properties:**

- **Cross-process**: prevents concurrent writers from any process
- **Crash-safe**: automatically released when the process dies (OS-level `fcntl`/`LockFileEx`)
- **Worker-thread-safe**: automatically released when a worker thread is terminated
- **Zero overhead on the happy path**: lock + open + stat-match in a single native async call

**Platform implementations:**

- **POSIX (Linux, macOS, FreeBSD)**: `fcntl F_SETLK` / `F_SETLKW` byte-range lock on the cache file
- **Windows**: `LockFileEx` exclusive lock on the cache file

**Timeout control** (`timeoutMs` parameter):

- `-1` (default): block until the lock is available
- `0`: fail immediately if locked
- `>0`: wait up to N milliseconds

```ts
// Non-blocking try
const cache = await FileHashCache.open(path, root, files, 1, null, 0);
try {
  // use cache here
} finally {
  cache.close();
}

// Check if locked without acquiring
FileHashCache.isLocked(path); // → boolean
```

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
}
// lock released here
```

### Example: Dynamic file list + user data

```ts
import { FileHashCache } from "fast-fs-hash";

await using ctx = await FileHashCache.open(
  ".cache/tsc.fsh",
  ".",
  entryPoints,
  2,
);

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
// lock released here
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
| native               | 0.04 ms (41.7 µs) | 23 960 op/s | 4.7 GB/s   | **6.5× faster** |
| Node.js crypto (md5) | 0.3 ms (270.5 µs) | 3 696 op/s  | 729 MB/s   | baseline        |

**medium file (~49.9 KB):**

| Scenario             | Mean              | Hz          | Throughput | Relative        |
| -------------------- | ----------------- | ----------- | ---------- | --------------- |
| native               | 0.03 ms (28.5 µs) | 35 125 op/s | 1.8 GB/s   | **3.8× faster** |
| Node.js crypto (md5) | 0.1 ms (109.1 µs) | 9 164 op/s  | 457 MB/s   | baseline        |

**small file (~1.0 KB):**

| Scenario             | Mean              | Hz          | Relative        |
| -------------------- | ----------------- | ----------- | --------------- |
| native               | 0.02 ms (24.5 µs) | 40 851 op/s | **2.4× faster** |
| Node.js crypto (md5) | 0.06 ms (59.1 µs) | 16 914 op/s | baseline        |

<!-- HASHFILE_BENCHMARKS:END -->

### Parallel file hashing (705 files)

<!-- BENCHMARKS:START -->

| Scenario             | Mean                  | Hz       | Throughput | Relative        |
| -------------------- | --------------------- | -------- | ---------- | --------------- |
| native               | 7.4 ms (7 361.8 µs)   | 136 op/s | 3.4 GB/s   | **4.9× faster** |
| Node.js crypto (md5) | 35.9 ms (35 893.9 µs) | 28 op/s  | 688 MB/s   | baseline        |

<!-- BENCHMARKS:END -->

### In-memory buffer hashing

<!-- HASH_BUFFER_BENCHMARKS:START -->

**64 KB buffer:**

| Scenario           | Mean              | Hz           | Throughput | Relative         |
| ------------------ | ----------------- | ------------ | ---------- | ---------------- |
| native XXH3-128    | 0.001 ms (1.4 µs) | 721 364 op/s | 47.3 GB/s  | **48.0× faster** |
| Node.js crypto md5 | 0.07 ms (66.5 µs) | 15 040 op/s  | 986 MB/s   | baseline         |

**1 MB buffer:**

| Scenario           | Mean                | Hz          | Throughput | Relative         |
| ------------------ | ------------------- | ----------- | ---------- | ---------------- |
| native XXH3-128    | 0.02 ms (21.7 µs)   | 46 022 op/s | 48.3 GB/s  | **48.7× faster** |
| Node.js crypto md5 | 1.1 ms (1 057.1 µs) | 946 op/s    | 992 MB/s   | baseline         |

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
| native LZ4              | 0.7%  | 0.003 ms (3.4 µs) | 298 045 op/s | 19.5 GB/s  | **7.3× faster** |
| Node.js deflate level=1 | 1.0%  | 0.02 ms (24.4 µs) | 41 037 op/s  | 2.7 GB/s   | baseline        |

**decompress 64 KB:**

| Scenario        | Mean              | Hz           | Throughput | Relative        |
| --------------- | ----------------- | ------------ | ---------- | --------------- |
| native LZ4      | 0.003 ms (2.6 µs) | 384 184 op/s | 25.2 GB/s  | **3.9× faster** |
| Node.js deflate | 0.01 ms (10.1 µs) | 98 728 op/s  | 6.5 GB/s   | baseline        |

**compress 1 MB:**

| Scenario                | Ratio | Mean              | Hz          | Throughput | Relative        |
| ----------------------- | ----- | ----------------- | ----------- | ---------- | --------------- |
| native LZ4              | 0.4%  | 0.03 ms (33.8 µs) | 29 553 op/s | 31.0 GB/s  | **9.8× faster** |
| Node.js deflate level=1 | 0.7%  | 0.3 ms (332.8 µs) | 3 005 op/s  | 3.2 GB/s   | baseline        |

**decompress 1 MB:**

| Scenario        | Mean              | Hz          | Throughput | Relative        |
| --------------- | ----------------- | ----------- | ---------- | --------------- |
| native LZ4      | 0.03 ms (30.3 µs) | 33 057 op/s | 34.7 GB/s  | **3.1× faster** |
| Node.js deflate | 0.09 ms (93.5 µs) | 10 694 op/s | 11.2 GB/s  | baseline        |

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
