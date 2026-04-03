# fast-fs-hash smoke test

Standalone package that installs `fast-fs-hash` from the npm registry and verifies the native binding works correctly. Not part of the monorepo workspace — it has its own `node_modules` and installs from npm like any consumer would.

## What it tests

- **xxHash128 buffers** — `digestBuffer`, `digestString`, `hashToHex`
- **xxHash128 files** — `digestFile`, `digestFileToHex`, `digestFilesToHexArray`, `filesEqual`
- **LZ4 buffers** — `lz4CompressBlock` / `lz4DecompressBlock` round-trip
- **LZ4 files** — `lz4ReadAndCompress` / `lz4DecompressAndWrite` round-trip
- **FileHashCache** — open (missing) → write → re-open (upToDate) → modify file → re-open (changed) → re-write → verify upToDate → version bump (stale) → `writeNew`

## Run locally

```bash
# Install latest stable release and run
cd test/smoke-test
npm run install-latest
npm test

# Or install a specific version (rc, beta, etc.)
npm install fast-fs-hash@0.0.0-rc1
npm test
```

From the repo root:

```bash
# Install latest + run
npm run smoke-test:install
npm run smoke-test
```

## Run in CI

The **Smoke Test** workflow (`smoke-test.yml`) can be triggered manually from the GitHub Actions UI. It has a **version** input (defaults to `latest`) — set it to any version string like `0.0.1-rc1` to test pre-releases.

It runs on: Windows x64, macOS arm64/x64, Linux x64/arm64 (glibc + musl), and FreeBSD x64.
