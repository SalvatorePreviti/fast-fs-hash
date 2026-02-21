# fast-fs-hash

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

Hashing **701 files** (~20 MiB total), with and without per-file output:

<!-- BENCHMARKS:START -->

Results from Node.js v22.22.0, Vitest 4.x:

_No benchmark data available._

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
| Linux (musl)  | x64          |   ✅   |      ✅       |
| Windows       | x64          |   ✅   |      ✅       |
| Any other     | any          |   —    |      ✅       |

## Quick start

```ts
import { XXHash128 } from "fast-fs-hash";

// Initialize once (loads native addon or WASM fallback)
await XXHash128.init();

// Hash a set of files — paths must be sorted for deterministic results
const hasher = new XXHash128();
await hasher.hashFiles(["package.json", "src/index.ts", "src/utils.ts"]);
console.log(hasher.digest().toString("hex"));
// → "a1b2c3d4e5f6...0123456789ab" (32 hex chars = 128 bits)
```

### Detect file changes (cache invalidation)

```ts
import { XXHash128 } from "fast-fs-hash";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { globSync } from "node:fs";

await XXHash128.init();

// Sort paths for deterministic hashing
const files = globSync("src/**/*.ts").sort();

const h = new XXHash128();
await h.hashFiles(files);
const hash = h.digest().toString("hex");

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

## API

### `XXHash128`

The primary entry point. Uses the native C++ addon when available, WASM otherwise.

| Method / Property                            | Description                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `XXHash128.init()`                           | Initialize the backend. Call **once** before creating instances. No-op on subsequent calls. |
| `XXHash128.hash(input, seedLow?, seedHigh?)` | One-shot hash → 16-byte `Buffer`.                                                           |
| `new XXHash128(seedLow?, seedHigh?)`         | Create a streaming hasher. Throws if `init()` hasn't been called.                           |
| `hasher.update(input, offset?, length?)`     | Feed data (`string \| Buffer \| Uint8Array`).                                               |
| `hasher.digest()`                            | Return 16-byte hash. Does **not** reset — call again for incremental snapshots.             |
| `hasher.digestTo(output, offset?)`           | Write 16-byte hash into an existing buffer.                                                 |
| `hasher.reset()`                             | Reset to initial state (same seed).                                                         |
| `hasher.hashFiles(files)`                    | Hash files in parallel → feed per-file hashes into streaming state. Returns `null`.         |
| `hasher.hashFiles(files, true)`              | Same, but returns `Buffer` of all per-file hashes (`N × 16` bytes).                         |
| `hasher.hashFiles(files, output, offset?)`   | Same, writes per-file hashes into your buffer.                                              |
| `hasher.updateFile(path)`                    | Read file(s) and feed **raw contents** into hasher. Returns file count.                     |
| `hasher.concurrency`                         | Max parallel I/O. `0` (default) = auto.                                                     |
| `hasher.libraryStatus`                       | `"native" \| "wasm" \| "not-initialized"`                                                   |

**`files`** can be `string[]` or a `Uint8Array` of null-separated UTF-8 paths.
Unreadable files are silently skipped (zero hash). **Sort paths before hashing** for
deterministic results — `hashFiles` does not sort internally.

### `XXHash128Wasm`

Same API as `XXHash128`, but always uses the WASM backend.

| Method                 | Description                                |
| ---------------------- | ------------------------------------------ |
| `XXHash128Wasm.init()` | Compile WASM module. Call once before use. |

### Utility functions

| Function                               | Description                                  |
| -------------------------------------- | -------------------------------------------- |
| `encodeFilePaths(paths: string[])`     | Encode paths into a null-separated `Buffer`. |
| `decodeFilePaths(buf: Uint8Array)`     | Decode null-separated buffer → `string[]`.   |
| `hashesToHexArray(hashes: Uint8Array)` | Split `N × 16`-byte buffer into hex strings. |

### Types

```ts
type HashInput = string | Buffer | Uint8Array;
type XXHash128LibraryStatus = "native" | "wasm" | "not-initialized";
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
npm run build        # TypeScript + native addon
npm test             # Run tests
npm run bench        # Run benchmarks
```

## License

[MIT](LICENSE)
