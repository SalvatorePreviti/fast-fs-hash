# fast-fs-hash

Blazing fast filesystem hashing library for Node.js with native C++ backend using xxHash3-128 and SIMD acceleration.

## Features

- **Native C++ backend** — xxHash3-128 with SSE4.2/NEON SIMD acceleration
- **Parallel file I/O** — lock-free thread pool for maximum throughput
- **Promise-based API** — non-blocking, runs entirely off the main thread
- **Simple Buffer output** — 16-byte combined hash, optional per-file hashes
- **Salt support** — mix a string or `Uint8Array` salt into the combined hash
- **Pre-encoded paths** — accept `Buffer` of null-terminated strings for zero-copy hot paths
- **Cross-platform** — pre-built binaries for macOS, Linux (glibc + musl), Windows, FreeBSD
- **JS fallback** — works everywhere Node.js ≥ 22 runs, even without native binding
- **ESM** — native ES module

## Installation

```bash
npm install fast-fs-hash
```

The native binding is distributed as optional platform-specific packages:

| Platform          | Package                          |
| ----------------- | -------------------------------- |
| macOS arm64       | `@fast-fs-hash/darwin-arm64`     |
| macOS x64         | `@fast-fs-hash/darwin-x64`       |
| Linux x64 glibc   | `@fast-fs-hash/linux-x64-gnu`    |
| Linux x64 musl    | `@fast-fs-hash/linux-x64-musl`   |
| Linux arm64 glibc | `@fast-fs-hash/linux-arm64-gnu`  |
| Linux arm64 musl  | `@fast-fs-hash/linux-arm64-musl` |
| Windows x64       | `@fast-fs-hash/win32-x64-msvc`   |
| Windows arm64     | `@fast-fs-hash/win32-arm64-msvc` |
| FreeBSD x64       | `@fast-fs-hash/freebsd-x64`      |

npm automatically installs only the package matching your platform. If no native binding is available, a pure JavaScript fallback using Node.js `crypto` (MD5) is used.

## Usage

```typescript
import {
  hash,
  hashSlow,
  encodeFilePaths,
  isNativeAvailable,
} from "fast-fs-hash";

// Check native binding availability
console.log("Native:", isNativeAvailable());

// Combined hash (16 bytes)
const result = await hash(["/path/to/file1.ts", "/path/to/file2.ts"]);
console.log(result?.toString("hex"));

// Combined + per-file hashes
const detailed = await hash(files, { files: true });
// detailed[0..15]  = combined hash
// detailed[16..31] = file0 hash
// detailed[32..47] = file1 hash (all-zero if unreadable)

// With salt
const salted = await hash(files, { salt: "v1.2.3" });

// Pre-encode paths for repeated hashing
const encoded = encodeFilePaths(files);
const r1 = await hash(encoded);
const r2 = await hash(encoded, { salt: "build-2" });

// Pure JS fallback (always uses Node.js crypto, no native binding)
const slow = await hashSlow(files);
```

## API

### `hash(files, options?): Promise<Buffer | null>`

Hash a list of files using the native binding (or JS fallback).

- **files** — `string[]` of absolute paths, or a `Buffer` of null-terminated UTF-8 strings (see `encodeFilePaths`).
- **options** — optional `HashOptions`.
- **returns** — `Buffer` with the result, or `null` on catastrophic error.

**Output layout:**

| `files` option    | Output size          | Layout                        |
| ----------------- | -------------------- | ----------------------------- |
| `false` (default) | 16 bytes             | `[combined]`                  |
| `true`            | `(1 + N) × 16` bytes | `[combined, file0, file1, …]` |

Files that cannot be read produce a 16-byte all-zero per-file hash.

### `hashSlow(files, options?): Promise<Buffer | null>`

Same API as `hash()` but always uses the pure JavaScript fallback (MD5). Useful for testing and environments without native bindings.

> **Note:** Output is NOT byte-compatible with the native xxHash3-128 path.

### `encodeFilePaths(files: string[]): Buffer`

Encode file paths into a `Buffer` of null-terminated UTF-8 strings. This is the format accepted by `hash()` and `hashSlow()` for zero-copy pre-encoding.

### `isNativeAvailable(): boolean`

Returns `true` if the native C++ binding is loaded.

### `HashOptions`

| Property      | Type                   | Default     | Description                                        |
| ------------- | ---------------------- | ----------- | -------------------------------------------------- |
| `salt`        | `string \| Uint8Array` | `undefined` | Salt mixed into the combined hash                  |
| `concurrency` | `number`               | `0` (auto)  | Max parallel file reads (0 = CPU count × 2)        |
| `files`       | `boolean`              | `false`     | Include per-file 16-byte hashes after the combined |

## Performance

The native binding uses xxHash3-128, one of the fastest non-cryptographic hash functions available, with automatic SIMD vectorization (SSE4.2 on x86_64, NEON on ARM64). File I/O uses a lock-free thread pool that scales to available CPU cores.

<!-- BENCHMARKS:START -->

Results from Node.js v22.22.0, Vitest 4.x:

| Scenario                         | Mean    | Throughput (hz) | Relative         |
| -------------------------------- | ------- | --------------- | ---------------- |
| native                           | 4.0 ms  | 249.4           | **10.3× faster** |
| native (per file output)         | 4.4 ms  | 227.1           | **9.4× faster**  |
| Node.js crypto (md5)             | 38.8 ms | 25.8            | **1.1× faster**  |
| WASM                             | 39.6 ms | 25.2            | **1.0× faster**  |
| Node.js crypto (per file output) | 40.1 ms | 24.9            | **1.0× faster**  |
| WASM (per file output)           | 41.3 ms | 24.2            | baseline         |

_Results vary by hardware, file sizes, and OS cache state._

<!-- BENCHMARKS:END -->

## Building from source

Requires CMake ≥ 3.15 and a C++17 compiler.

```bash
npm install
npx cmake-js compile
```

## Development

```bash
npm test          # Run tests
npm run bench     # Run benchmarks
npm run build     # Build JS bundles + types
npm run lint      # Lint with biome
```

## License

MIT

See [NOTICES.md](NOTICES.md) for third-party licenses.
