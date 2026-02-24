> **⚠️ This is a platform-specific binary package.**
>
> You should not install `@fast-fs-hash/fast-fs-hash-node-win32-arm64-msvc` directly.
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

> _"There are only two hard things in Computer Science: cache invalidation and naming things."_
> — Phil Karlton

If you ever needed to check whether a set of files changed — to invalidate a cache,
skip redundant builds, or trigger incremental CI — **fast-fs-hash** is for you.

It hashes hundreds of files in milliseconds using [xxHash3-128](https://github.com/Cyan4973/xxHash)
via a native C++ addon with SIMD acceleration, and ships a **zero-dependency WASM fallback** so it
works everywhere Node.js runs — no compiler toolchain required.

xxHash3 is a **non-cryptographic** hash function — it is not suitable for security purposes, but it
is more than enough for cache invalidation, deduplication, and change detection, which is what this
library is designed for.

_Note: Unfortunately this package will not help you naming things, at least, not yet._

## Benchmarks

With **705 files** (~24 MiB total):

<!-- FHC_BENCHMARKS:START -->

Results from Node.js v22.22.0, Vitest 4.x:

**Native (C++ addon):**

| Scenario                            | Mean   | Hz       |
| ----------------------------------- | ------ | -------- |
| validate (no change)                | 1.1 ms | 920 op/s |
| serialize (no existing cache)       | 5.6 ms | 179 op/s |
| validate+serialize (1 file changed) | 4.4 ms | 228 op/s |

**WASM fallback:**

| Scenario                            | Mean    | Hz       |
| ----------------------------------- | ------- | -------- |
| validate (no change)                | 3.2 ms  | 311 op/s |
| serialize (no existing cache)       | 14.7 ms | 68 op/s  |
| validate+serialize (1 file changed) | 6.9 ms  | 145 op/s |

_Results vary by hardware, file sizes, and OS cache state._

<!-- FHC_BENCHMARKS:END -->

<!-- BENCHMARKS:START -->

Results from Node.js v22.22.0, Vitest 4.x:

| Scenario                          | Mean    | Hz       | Throughput | Relative        |
| --------------------------------- | ------- | -------- | ---------- | --------------- |
| native (hashFilesBulk + per file) | 5.2 ms  | 193 op/s | 4.8 GB/s   | **8.3× faster** |
| native (hashFilesBulk)            | 5.3 ms  | 190 op/s | 4.7 GB/s   | **8.2× faster** |
| WASM (hashFilesBulk + per file)   | 12.0 ms | 83 op/s  | 2.1 GB/s   | **3.6× faster** |
| WASM (hashFilesBulk)              | 12.0 ms | 83 op/s  | 2.1 GB/s   | **3.6× faster** |
| Node.js crypto (md5, per file)    | 41.7 ms | 24 op/s  | 0.6 GB/s   | **1.0× faster** |
| Node.js crypto (md5)              | 43.0 ms | 23 op/s  | 0.6 GB/s   | baseline        |

_Results vary by hardware, file sizes, and OS cache state._

<!-- BENCHMARKS:END -->

### In-Memory Buffer Hashing

<!-- HASH_BUFFER_BENCHMARKS:START -->

Results from Node.js v22.22.0, Vitest 4.x:

**1 KB buffer:**

| Scenario           | Mean   | Hz             | Relative        |
| ------------------ | ------ | -------------- | --------------- |
| WASM XXH3-128      | 0.2 µs | 4 759 031 op/s | **7.8× faster** |
| native XXH3-128    | 0.3 µs | 3 571 012 op/s | **5.9× faster** |
| Node.js crypto md5 | 1.6 µs | 606 905 op/s   | baseline        |

**64 KB buffer:**

| Scenario           | Mean    | Hz           | Relative         |
| ------------------ | ------- | ------------ | ---------------- |
| native XXH3-128    | 1.7 µs  | 582 750 op/s | **43.6× faster** |
| WASM XXH3-128      | 5.2 µs  | 191 416 op/s | **14.3× faster** |
| Node.js crypto md5 | 74.8 µs | 13 366 op/s  | baseline         |

**1 MB buffer:**

| Scenario           | Mean       | Hz          | Relative         |
| ------------------ | ---------- | ----------- | ---------------- |
| native XXH3-128    | 24.3 µs    | 41 186 op/s | **48.5× faster** |
| WASM XXH3-128      | 83.8 µs    | 11 926 op/s | **14.0× faster** |
| Node.js crypto md5 | 1 176.4 µs | 850 op/s    | baseline         |

_Results vary by hardware._

<!-- HASH_BUFFER_BENCHMARKS:END -->

## Installation

```bash
npm install fast-fs-hash
```

The native addon is **prebuilt** for common platforms.
If a prebuilt binary isn't available, the bundled WASM module kicks in automatically.

| Platform      | Architecture | Native | WASM fallback |
| ------------- | ------------ | :----: | :-----------: |
| macOS         | arm64, x64   |   ✅   |      ✅       |
| Linux (glibc) | x64, arm64   |   ✅   |      ✅       |
| Linux (musl)  | x64, arm64   |   ✅   |      ✅       |
| Windows       | x64, arm64   |   ✅   |      ✅       |
| FreeBSD       | x64          |   ✅   |      ✅       |
| Any other     | any          |   —    |      ✅       |

## `FileHashCache` — Binary cache invalidation

`FileHashCache` is a stateful cache-file reader/validator/writer for build systems and tools
that need to know **if or which files changed** since the last run.

It stores per-file stat metadata (inode, mtime, ctime, size) and content hashes in a compact
binary format. On the next run it re-stats every tracked file and compares — files whose stat
matches are skipped entirely (no re-read), giving near-instant validation for large file sets.

### Why not just hash everything?

Hashing is fast, but reading thousands of files from disk is not. `FileHashCache` avoids
re-reading files that haven't changed by comparing `stat()` metadata first. Only files with
changed stat are re-hashed. This makes cache validation **O(n × stat)** instead of
**O(n × read + hash)** — typically 10–100× faster for warm caches.

### Lifecycle

```
[setFiles() ->] validate() -> [read() | complete() + getChangedFiles() | setFiles() ->] [complete() + getChangedFiles()] [serialize() + write() ->] [getChangedFiles()] dispose()
```

All steps in brackets are optional. Common patterns:

- **Check-only** (read-only mode): `validate()` -> `read()` -> `dispose()`
- **Full rebuild**: `setFiles()` -> `serialize()` -> `write()` -> `dispose()`
- **Incremental**: `setFiles()` -> `validate()` -> `complete()` -> `getChangedFiles()` -> rebuild changed -> `serialize()` -> `dispose()`
- **Dynamic file list**: `validate()` -> compile -> `setFiles(actualFiles)` -> `serialize()` -> `write()` -> `dispose()`

#### Steps

- **`setFiles()`** — Set the list of files to track. Optional before `validate()` — when omitted,
  the file list is read from the existing cache file.
- **`validate()`** — Open the cache file, compare headers and per-file stat metadata.
  Returns `true` if every file matches, `false` if anything changed.
  After a successful validate, use `read()` / `readv()` to retrieve user data stored in a previous cycle.
- **`setFiles()`** _(again, optional)_ — Switch to a different file list after validation.
  Entries from the previous validation are remapped to the new list.
- **`complete()`** — Complete pending stat + hash work for the current file list.
  Call this before `getChangedFiles()` when `validate()` returned `false`.
- **`getChangedFiles()`** — Returns the sorted list of files that changed since the last cache.
  This method is synchronous and does not do I/O; before completion it returns `[]`.
- **`serialize()`** — Calls `complete()` and writes the cache file. Returns `"written"`, `"deleted"`, or `"error"`.
- **`write()` / `writev()`** — Append arbitrary user data after the cache metadata.
- **`read()` / `readv()`** — Read user data stored in a previous cycle (after `validate()`).
- **`dispose()`** — Close handles and atomically commit the file (tmp -> rename).

#### User data in the header

Four `u32` slots — `userValue0` through `userValue3` — are persisted in the cache file header.
Use them for small metadata (data lengths, flags, format versions) without needing `write()`/`read()`.
They are available immediately after `validate()` and written automatically by `serialize()`.

Instances are **single-use** — you can use `await using` for automatic disposal.

#### Auto-root mode (`rootPath: true`)

When you pass `true` as the `rootPath` (the first constructor argument), the root directory
is automatically computed from the file list on every `setFiles()` call using the common
parent directory of all files. This is useful when the set of tracked files determines the
natural project root:

```ts
const files = ["/project/src/a.ts", "/project/src/b.ts", "/project/lib/c.ts"];

await using cache = new FileHashCache(true, ".cache/build.fsh", { version: 1 });
cache.setFiles(files);
// rootPath is now "/project" (common parent of all files)
```

You can switch between auto and explicit root at any time via `setFiles()`:

```ts
cache.setFiles(files, true);       // Enable auto-root
cache.setFiles(files, "/my/root"); // Switch to explicit root
cache.setFiles(files);             // Keep current mode (auto or explicit)
```

### Example: Simple build cache

Skip a build entirely when source files haven't changed:

```ts
import { FileHashCache } from "fast-fs-hash";
import { globSync } from "node:fs";

await FileHashCache.init();

const files = globSync("src/**/*.ts");

await using cache = new FileHashCache(".", ".cache/build.fsh", {
  version: 1, // bump to invalidate all caches
});

cache.setFiles(files);
const valid = await cache.validate();

if (valid) {
  console.log("Build cache is fresh — skipping.");
} else {
  console.log("Files changed — rebuilding...");
  await runBuild();
  await cache.serialize(); // save new hashes
}
```

### Example: TypeScript compiler with dynamic imports

Real compilers discover their input files during compilation — the set of source files
depends on `import` / `require` statements, which can change between builds. You can't
know the full file list _before_ compiling. `FileHashCache` supports this: validate
with the **previous** file list from the cache, then call `setFiles()` again with the
**actual** list the compiler used.

```ts
import { FileHashCache } from "fast-fs-hash";

await FileHashCache.init();

async function build(entryPoints: string[]) {
  await using cache = new FileHashCache(".", ".cache/tsc.fsh", {
    version: 2,
  });

  // 1. Validate with whatever file list was in the last cache.
  //    No setFiles() call — the list is read from the cache file.
  //    If there was no cache file before, this just returns false and no file list is loaded.
  const valid = await cache.validate();

  if (valid) {
    // Nothing changed — read cached output.
    // You can use cache.userValue0..3 to store and retrieve custom information like how big is the buffer to read
    const bufferSize = cache.userValue0;
    const buf = Buffer.alloc(bufferSize);
    // Read user data from the file.
    await cache.read(buf);
    return JSON.parse(buf.toString());
  }

  // 2. Something changed (or no cache yet) — run the compiler.
  const result = compile(entryPoints);
  // The compiler tells us which files it actually used:
  //   entry points + every file reached via import/require.
  const actualFiles = result.getSourceFiles().map((f) => f.fileName);

  // 3. Update the file list to match what the compiler used.
  //    Hashes from step 1 are remapped — files that appeared in both
  //    the old and new list and whose stat didn't change are NOT re-hashed.
  cache.setFiles(actualFiles);

  // Store the buffer size for example
  cache.userValue0 = result.sizeInBytes;

  // 4. Serialize the new cache and store the build output.
  await cache.serialize();

  // Write custom data at the end of the file
  const output = Buffer.from(JSON.stringify(result.output));
  await cache.write(output); // Add user data to the file
  cache.position += output.length;

  return result.output;
}
```

### Example: Incremental rebuild (only reprocess changed files)

Use `complete()` + `getChangedFiles()` to find exactly which files changed, then rebuild only those:

```ts
import { FileHashCache } from "fast-fs-hash";
import { globSync } from "node:fs";

await FileHashCache.init();

async function incrementalBuild() {
  const files = globSync("src/**/*.ts");

  await using cache = new FileHashCache(".", ".cache/incremental.fsh", {
    version: 1,
  });

  cache.setFiles(files);
  await cache.validate();

  // complete() finalizes all pending hashing work.
  await cache.complete();
  const changed = cache.getChangedFiles();

  if (changed.length === 0) {
    console.log("Nothing changed.");
  } else {
    console.log("Changed files:", changed);
    // Only reprocess the files that actually changed.
    for (const file of changed) {
      await processFile(file);
    }
  }

  // Save updated hashes for next run.
  await cache.serialize();
}
```

### Example: Store user data alongside hashes

The cache file has a user data section after the internal metadata.
Use `write()` / `read()` (or `writev()` / `readv()`) to persist
arbitrary data — compiled output, dependency graphs, source maps, etc.

```ts
import { FileHashCache } from "fast-fs-hash";

await FileHashCache.init();

// Write phase:
{
  await using cache = new FileHashCache(".", ".cache/output.fsh", {
    version: 1,
  });
  cache.setFiles(sourceFiles);
  await cache.serialize();

  // Write compiled output after the cache metadata.
  const data = Buffer.from(compiledOutput);
  await cache.write(data);
  cache.position += data.length;
}

// Read phase (next run):
{
  await using cache = new FileHashCache(".", ".cache/output.fsh", {
    version: 1,
  });
  cache.setFiles(sourceFiles);
  if (await cache.validate()) {
    // Read cached output — position is set to user data start.
    const buf = Buffer.alloc(expectedLength);
    await cache.read(buf);
    return buf;
  }
}
```

---

## `XXHash128` — Direct file hashing

When you don't need a persistent cache file — or you want raw xxHash3-128 digests to
compare yourself — use `XXHash128` directly. `FileHashCache` uses it under the hood,
but the hashing API is fully usable on its own.

### Hash files in bulk

```ts
import { XXHash128, hashToHex, hashesToHexArray } from "fast-fs-hash";

// Initialize once (loads native addon or WASM fallback)
await XXHash128.init();

// Hash a set of files — default outputMode is "digest" (16-byte aggregate).
const digest = await XXHash128.hashFilesBulk({
  files: ["package.json", "src/index.ts", "src/utils.ts"],
});
console.log("Aggregate:", hashToHex(digest));

// Get both aggregate + per-file hashes:
const result = await XXHash128.hashFilesBulk({
  files: ["package.json", "src/index.ts"],
  outputMode: "all",
});
// First 16 bytes = aggregate digest, then N × 16 bytes = per-file hashes
console.log("Aggregate:", hashToHex(result));
console.log("Per-file:", hashesToHexArray(result.subarray(16)));
```

### Using the streaming class

For combining file hashes with extra data (config, environment, etc.):

```ts
import { XXHash128 } from "fast-fs-hash";

await XXHash128.init();

const h = new XXHash128();
h.update("my-config-v2");
await h.updateFilesBulk(["src/index.ts", "src/utils.ts"]);
console.log(h.digest().toString("hex"));
```

### Detect file changes without a cache file

For simple scripts where you don't need `FileHashCache`'s persistent binary format,
you can hash files directly and store the digest yourself:

```ts
import { XXHash128 } from "fast-fs-hash";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { globSync } from "node:fs";

await XXHash128.init();

// Sort paths for deterministic hashing
const files = globSync("src/**/*.ts").sort();

const digest = await XXHash128.hashFilesBulk({ files });
const hash = digest.toString("hex");

let cached: string | undefined;
try {
  cached = readFileSync(".cache/hash", "utf-8");
} catch {}

if (cached === hash) {
  console.log("Nothing changed — skipping build.");
} else {
  console.log("Files changed — rebuilding...");
  mkdirSync(".cache", { recursive: true });
  writeFileSync(".cache/hash", hash);
}
```

### One-shot hash

```ts
const digest = XXHash128.hash("hello world");
console.log(digest.toString("hex"));
```

### WASM-only mode

If you don't want to load any native addons:

```ts
import { XXHash128Wasm } from "fast-fs-hash";

await XXHash128Wasm.init();

const h = new XXHash128Wasm();
h.update("hello ");
h.update("world");
console.log(h.digest().toString("hex"));
```

---

> **[Full API Documentation](https://SalvatorePreviti.github.io/fast-fs-hash/)** — complete TypeDoc reference with all classes, methods, types, and options.

---

## Acknowledgements

The embedded WASM binary is extracted from [hash-wasm](https://github.com/Daninet/hash-wasm)
by [Dani Biró](https://github.com/Daninet) — thank you for the excellent work on a fast,
minimal WASM implementation of xxHash. hash-wasm is licensed under the
[MIT License](https://github.com/Daninet/hash-wasm/blob/master/LICENSE).

The native C++ backend uses [xxHash](https://github.com/Cyan4973/xxHash) by Yann Collet,
fetched automatically by CMake during the build. xxHash is licensed under the
[BSD 2-Clause License](https://github.com/Cyan4973/xxHash/blob/dev/LICENSE).

See [NOTICES.md](NOTICES.md) for full license texts.

## Building from source

```bash
git clone https://github.com/SalvatorePreviti/fast-fs-hash.git
cd fast-fs-hash && npm install
npm run build:native # Compile the C++ addon (requires CMake + a C++20 compiler)
npm run build        # Bundle TypeScript -> dist/
npm test             # Run tests
npm run bench        # Run benchmarks
```

## License

[MIT](LICENSE)
