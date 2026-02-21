/**
 * Tests for the XXHash128 class hierarchy:
 *  - XXHash128Wasm (WASM backend)
 *  - XXHash128 (native backend, falls back to WASM)
 *
 * Verifies: init, static hash, streaming, reset, digestTo, updateFile,
 * hashFiles, seed support, determinism, error handling, libraryStatus,
 * and cross-implementation byte-compatibility.
 *
 * Every hash assertion checks the exact expected hex value to catch
 * any algorithmic drift or encoding regression.
 */
export {};
