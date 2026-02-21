> **⚠️ This is a platform-specific binary package.**
>
> You should not install `@fast-fs-hash/linux-arm64-musl` directly.
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

Hashing **705 files** (~24 MiB total) via `hashFilesBulk`:

<!-- BENCHMARKS:START -->

Results from Node.js v22.22.0, Vitest 4.x:

| Scenario                          | Mean    | Throughput | Relative        |
| --------------------------------- | ------- | ---------- | --------------- |
| native (hashFilesBulk)            | 4.8 ms  | 5.1 GB/s   | **8.7× faster** |
| native (hashFilesBulk + per file) | 5.1 ms  | 4.8 GB/s   | **8.2× faster** |
| WASM (hashFilesBulk + per file)   | 12.8 ms | 1.9 GB/s   | **3.3× faster** |
| WASM (hashFilesBulk)              | 12.9 ms | 1.9 GB/s   | **3.2× faster** |
| Node.js crypto (md5)              | 41.4 ms | 0.6 GB/s   | **1.0× faster** |
| Node.js crypto (md5, per file)    | 41.8 ms | 0.6 GB/s   | baseline        |

_Results vary by hardware, file sizes, and OS cache state._

<!-- BENCHMARKS:END -->

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

## Quick start

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

### Detect file changes (cache invalidation)

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

## API

### `XXHash128`

The primary entry point. Uses the native C++ addon when available, WASM otherwise.

| Method / Property                                | Description                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `XXHash128.init()`                               | Initialize the backend. Call **once** before creating instances. No-op on subsequent calls. |
| `XXHash128.hash(input, seedLow?, seedHigh?)`     | One-shot hash → 16-byte `Buffer`.                                                           |
| `XXHash128.hashFilesBulk(options)`               | Hash many files in one call. See [hashFilesBulk options](#hashfilesbulk-options) below.     |
| `new XXHash128(seedLow?, seedHigh?)`             | Create a streaming hasher. Throws if `init()` hasn't been called.                           |
| `hasher.update(input, offset?, length?)`         | Feed data (`string \| Buffer \| Uint8Array`).                                               |
| `hasher.digest()`                                | Return 16-byte hash. Does **not** reset — call again for incremental snapshots.             |
| `hasher.digestTo(output, offset?)`               | Write 16-byte hash into an existing buffer.                                                 |
| `hasher.reset()`                                 | Reset to initial state (same seed).                                                         |
| `hasher.updateFilesBulk(files)`                  | Hash files in parallel → feed per-file hashes into streaming state. Returns `null`.         |
| `hasher.updateFilesBulk(files, true)`            | Same, but returns `Buffer` of all per-file hashes (`N × 16` bytes).                         |
| `hasher.updateFilesBulk(files, output, offset?)` | Same, writes per-file hashes into your buffer.                                              |
| `hasher.updateFile(path)`                        | Read a single file and feed its **raw content** into the hasher (no per-file hash).         |
| `hasher.concurrency`                             | Max parallel threads. `0` (default) = auto (hardware concurrency).                          |
| `hasher.libraryStatus`                           | `"native" \| "wasm" \| "not-initialized"`                                                   |

All static methods (`hash`, `hashFilesBulk`, `init`) work correctly when destructured:
`const { hash, hashFilesBulk } = XXHash128;`

#### hashFilesBulk options

`XXHash128.hashFilesBulk(options)` accepts an options object:

| Property       | Type                           | Default    | Description                                                 |
| -------------- | ------------------------------ | ---------- | ----------------------------------------------------------- |
| `files`        | `string[] \| Uint8Array`       | required   | File paths (or null-terminated UTF-8 buffer).               |
| `outputMode`   | `"all" \| "digest" \| "files"` | `"digest"` | What to include in the result buffer.                       |
| `concurrency`  | `number`                       | `0`        | Max parallel threads. `0` = auto (hardware concurrency).    |
| `seedLow`      | `number`                       | `0`        | Lower 32 bits of the aggregate seed.                        |
| `seedHigh`     | `number`                       | `0`        | Upper 32 bits of the aggregate seed.                        |
| `outputBuffer` | `Uint8Array`                   | —          | Pre-allocated output buffer (returned as-is when provided). |
| `outputOffset` | `number`                       | `0`        | Byte offset within `outputBuffer` to start writing.         |

**Output layout** (based on `outputMode`):

- `"digest"` (default) — `16-byte aggregate digest only`
- `"all"` — `[16-byte aggregate digest, N × 16-byte per-file hashes]` (total: `16 + N×16`)
- `"files"` — `N × 16-byte per-file hashes only`

**Sorting:** `hashFilesBulk` does not sort internally. **Sort paths before hashing** for deterministic results.
Unreadable files produce 16 zero bytes.

**`files`** can be `string[]` or a `Uint8Array` of null-separated UTF-8 paths.

### `XXHash128Wasm`

Same API as `XXHash128`, but always uses the WASM backend.

| Method                 | Description                                |
| ---------------------- | ------------------------------------------ |
| `XXHash128Wasm.init()` | Compile WASM module. Call once before use. |

### Utility functions

| Function                                   | Description                                              |
| ------------------------------------------ | -------------------------------------------------------- |
| `encodeFilePaths(paths: Iterable<string>)` | Encode paths into a null-separated `Buffer`.             |
| `decodeFilePaths(buf: Uint8Array)`         | Decode null-separated buffer → `string[]`.               |
| `hashesToHexArray(hashes: Uint8Array)`     | Split `N × 16`-byte buffer into an array of hex strings. |
| `hashToHex(hash: Uint8Array, offset?)`     | Convert a single 16-byte hash to a 32-char hex string.   |

### `XXHash128Base`

Abstract base class shared by `XXHash128` and `XXHash128Wasm`. Useful for writing
backend-agnostic code:

```ts
import type { XXHash128Base } from "fast-fs-hash";

async function computeHash(
  hasher: XXHash128Base,
  files: string[],
): Promise<string> {
  await hasher.updateFilesBulk(files);
  return hasher.digest().toString("hex");
}
```

### Types

```ts
type HashInput = string | Buffer | Uint8Array;
type XXHash128LibraryStatus = "native" | "wasm" | "not-initialized";
type HashFilesBulkOutputMode = "all" | "digest" | "files";

interface HashFilesBulkOptions<T extends Uint8Array = Buffer> {
  files: Iterable<string> | Uint8Array;
  outputMode?: HashFilesBulkOutputMode;
  concurrency?: number;
  seedLow?: number;
  seedHigh?: number;
  outputBuffer?: T;
  outputOffset?: number;
}
```

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
npm run build        # Bundle TypeScript → dist/
npm test             # Run tests
npm run bench        # Run benchmarks
```

## License

[MIT](LICENSE)
