/**
 * Internal helpers shared across the fast-fs-hash implementation.
 *
 * NOT part of the public API — consumed by xxhash128-base, xxhash128-wasm,
 * and xxhash128 modules.
 *
 * @module
 * @internal
 */

import type { HashInput } from "./types";

// ── Cached Buffer methods (avoid repeated property lookups) ──────────────

export const {
  from: bufferFrom,
  alloc: bufferAlloc,
  allocUnsafe: bufferAllocUnsafe,
  isBuffer,
  byteLength: bufferByteLength,
} = Buffer;

// ── Error helpers ────────────────────────────────────────────────────────

/** Throw a "not initialized" error. */
export function notInitialized(): never {
  throw new Error("XXHash128: library not initialized. Call XXHash128.init() or XXHash128Wasm.init() before use.");
}

// ── Data conversion ──────────────────────────────────────────────────────

/** Convert {@link HashInput} to a Buffer without unnecessary copies. */
export function toBuffer(input: HashInput): Buffer {
  if (typeof input === "string") {
    return bufferFrom(input, "utf-8");
  }
  if (isBuffer(input)) {
    return input;
  }
  return bufferFrom(input.buffer, input.byteOffset, input.byteLength);
}
