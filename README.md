# fast-fs-hash

> _"There are only two hard things in Computer Science: cache invalidation and naming things."_
> — Phil Karlton

If you ever needed to check whether a set of files changed — to invalidate a cache,
skip redundant builds, or trigger incremental CI — **fast-fs-hash** is for you.

It hashes hundreds of files in milliseconds using **xxHash3-128** via a native C++ addon
with SIMD acceleration, and ships a **zero-dependency WASM fallback** so it works
everywhere Node.js runs — no compiler toolchain required.

## Highlights

- **Native first** — C++ addon with AVX2/NEON SIMD, multi-threaded parallel I/O, and
  POSIX `read(2)` for maximum throughput.
- **WASM fallback** — Pure WASM backend, no native compilation needed. Still faster than
  Node.js `crypto` MD5.
- **Streaming API** — Feed data incrementally via `update()`, snapshot with `digest()` at
  any point, keep going.
- **Batch file hashing** — `hashFiles()` hashes hundreds of files in parallel and returns
  per-file hashes in a single buffer.
- **Deterministic** — Same input always produces the same 128-bit hash, regardless of backend.
- **Dual CJS/ESM** — Works with both `import` and `require`.
- **Node.js ≥ 22** — Leverages modern APIs like `os.availableParallelism()`.

## Installation

```bash
npm install fast-fs-hash
```

The native addon is **prebuilt** for common platforms.
If a prebuilt binary isn't available, `fast-fs-hash` falls back to the bundled WASM
module automatically — no build step needed.

| Platform        | Architecture | Native | WASM fallback |
| --------------- | ------------ | :----: | :-----------: |
| macOS           | arm64, x64   |   ✅   |      ✅       |
| Linux (glibc)   | x64, arm64   |   ✅   |      ✅       |
| Linux (musl)    | x64          |   ✅   |      ✅       |
| Windows         | x64          |   ✅   |      ✅       |
| Any other       | any          |   —    |      ✅       |

## Quick start

```ts
import { XXHash128 } from "fast-fs-hash";

// Initialize once (loads native addon or WASM fallback)
await XXHash128.init();

// Hash a set of files
const hasher = new XXHash128();
await hasher.hashFiles(["src/index.ts", "src/utils.ts", "package.json"]);
console.log(hasher.digest().toString("hex"));
// → "a1b2c3d4e5f6...0123456789ab" (32 hex chars = 128 bits)
```

### Check if files changed since last run

```ts
import { XXHash128 } from "fast-fs-hash";
import { readFile, writeFile } from "node:fs/promises";

await XXHash128.init();

const h = new XXHash128();
const perFile = await h.hashFiles(glob.sync("src/**/*.ts"), true);
const combined = h.digest().toString("hex");

const cached = await readFile(".cache/hash", "utf-8").catch(() => null);
if (cached === combined) {
  console.log("Nothing changed — skipping build.");
} else {
  console.log("Files changed — rebuilding...");
  await writeFile(".cache/hash", combined);
}
```

### One-shot hash (no streaming)

```ts
const digest = XXHash128.hash("hello world");
console.log(digest.toString("hex"));
```

### WASM-only mode (no native addon)

```ts
import { XXHash128Wasm } from "fast-fs-hash";

await XXHash128Wasm.init();

const h = new XXHash128Wasm();
h.update("hello ");
h.update("world");
console.log(h.digest().toString("hex"));
```

---

## API reference

### `XXHash128` — Main class (native + WASM fallback)

The primary entry point. Prefers the native C++ addon; automatically falls back to
WASM when the native binding is unavailable.

#### `XXHash128.init(): Promise<void>`

Initialize the backend. Must be called **once** before creating instances.
Loads the native addon if available, otherwise compiles and initializes the WASM module.
Repeated calls are no-ops.

#### `XXHash128.hash(input, seedLow?, seedHigh?): Buffer`

One-shot convenience — creates a temporary instance, feeds the input, returns the
16-byte digest. Equivalent to `new XXHash128(); h.update(input); h.digest()`.

- **input** — `string | Buffer | Uint8Array`
- **seedLow** — Lower 32 bits of the 64-bit seed (default `0`)
- **seedHigh** — Upper 32 bits of the 64-bit seed (default `0`)
- **Returns** — 16-byte `Buffer`

#### `new XXHash128(seedLow?, seedHigh?)`

Create a new streaming hasher. Throws if `init()` hasn't been called.

#### `hasher.update(input, inputOffset?, inputLength?): void`

Feed data into the hasher. Can be called multiple times.

- **input** — `string | Buffer | Uint8Array`
- **inputOffset** — Byte offset into the buffer (default `0`)
- **inputLength** — Number of bytes to hash (default: rest of buffer)

#### `hasher.digest(): Buffer`

Return the 16-byte hash of all data fed so far. Does **not** reset the hasher —
you can continue adding data and call `digest()` again for incremental snapshots.

#### `hasher.digestTo(output, outputOffset?): void`

Write the 16-byte digest into an existing `Uint8Array` or `Buffer` at the given offset.

#### `hasher.reset(): void`

Reset the hasher to its initial state (same seed). Allows reuse without reallocating.

#### `hasher.hashFiles(files): Promise<null>`

Hash files in parallel and feed all per-file hashes into this hasher's streaming state.
Each file is hashed individually with xxHash3-128 (seed 0), producing a 16-byte hash.
All per-file hashes are then fed into this instance as one contiguous block.

- **files** — `string[]` or `Uint8Array` (null-separated UTF-8 paths)
- Unreadable files are silently skipped (zero hash).

#### `hasher.hashFiles(files, true): Promise<Buffer>`

Same as above, but also allocates and returns a `Buffer` of all per-file hashes
(`N × 16` bytes). Useful for inspecting individual file hashes.

#### `hasher.hashFiles(files, output, outputOffset?): Promise<Uint8Array>`

Same as above, but writes per-file hashes into your pre-allocated buffer.

#### `hasher.updateFile(path): Promise<number>`

Read one or more files and feed their **raw contents** (not hashes) into the hasher,
in order. Returns the number of files successfully read.

- **path** — `string | string[]`

#### `hasher.concurrency: number`

Maximum parallel file reads. `0` (default) = auto-detect via `os.availableParallelism()`.

#### `hasher.libraryStatus: "native" | "wasm" | "not-initialized"`

Which backend is active for this instance.

---

### `XXHash128Wasm` — WASM-only class

Identical API to `XXHash128`, but always uses the WASM backend.
Use this when you want to avoid loading native addons entirely
(e.g., in sandboxed environments).

#### `XXHash128Wasm.init(): Promise<void>`

Compile the WASM module and patch the prototype. Must be called once before use.

---

### `XXHash128Base` — Abstract base class

The shared abstract base that both `XXHash128` and `XXHash128Wasm` extend.
You won't instantiate this directly, but it defines the full interface above.

---

### Utility functions

#### `encodeFilePaths(paths: string[]): Buffer`

Encode an array of file paths into a null-separated UTF-8 buffer.
This is the format accepted by `hashFiles()` when passing a `Uint8Array`.

#### `decodeFilePaths(buf: Uint8Array): string[]`

Decode a null-separated buffer back into an array of path strings.

#### `hashesToHexArray(hashes: Uint8Array): string[]`

Split a buffer of concatenated 16-byte hashes into an array of lowercase hex strings.
Useful for inspecting the per-file output of `hashFiles(files, true)`.

```ts
const perFile = await hasher.hashFiles(files, true);
const hexes = hashesToHexArray(perFile);
// ["a1b2c3d4...", "e5f6a7b8...", ...]
```

---

### Types

#### `HashInput`

```ts
type HashInput = string | Buffer | Uint8Array;
```

#### `XXHash128LibraryStatus`

```ts
type XXHash128LibraryStatus = "native" | "wasm" | "not-initialized";
```

---

## Performance

Benchmarked on Apple M4 Pro, Node.js v22.22.0 — **701 source files, 21 MB total**:

| Backend               |  Time  |   Throughput | vs MD5       |
| --------------------- | :----: | -----------: | ------------ |
| **Native** (C++ SIMD) | 3.6 ms | ~5,800 MB/s  | **10.9× faster** |
| **WASM**              | 17 ms  | ~1,200 MB/s  | **2.3× faster**  |
| Node.js crypto (MD5)  | 39 ms  |   ~540 MB/s  | baseline     |

The native backend uses multi-threaded POSIX I/O with xxHash3 SIMD acceleration.
The WASM fallback uses `readFile` with `os.availableParallelism()` concurrent workers
and reuses hasher instances across files to minimize overhead.

### Why is the native addon ~88 KB?

On macOS arm64, Mach-O binaries align each segment to **16 KB pages**.
A `.node` file has at minimum 4 segments (`__TEXT`, `__DATA_CONST`, `__DATA`,
`__LINKEDIT`), so the **floor for any native addon is 64 KB** — even an empty one.

Our actual executable code is ~42 KB: the full xxHash3-128 implementation with all
SIMD code paths inlined, the N-API binding, and a parallel file I/O engine with a
thread pool. Only **2 symbols** are exported. On Linux with 4 KB pages, the binary
is significantly smaller.

The WASM module is **~10 KB**.

## Building from source

Building the native addon requires a C++ toolchain (CMake, Ninja) and `cmake-js`:

```bash
# Clone and install
git clone https://github.com/SalvatorePreviti/fast-fs-hash.git
cd fast-fs-hash
npm install

# Build everything (TypeScript + native addon)
npm run build

# Run tests
npm test

# Run benchmarks
npm run bench
```

The native addon uses [xxHash](https://github.com/Cyan4973/xxHash) (BSD 2-Clause),
fetched automatically by CMake during the build.

## License

[MIT](LICENSE)
