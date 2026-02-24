/**
 * Internal helpers shared across the fast-fs-hash implementation.
 *
 * NOT part of the public API — consumed by xxhash128-base, xxhash128-wasm,
 * and xxhash128 modules.
 *
 * @module
 * @internal
 */

import type { FileHandle } from "node:fs/promises";
import { readFile, rename, unlink } from "node:fs/promises";

/** Input accepted by xxHash128 streaming methods. */
export type HashInput = string | Buffer | Uint8Array;

export const { from: bufferFrom, alloc: bufferAlloc, allocUnsafe: bufferAllocUnsafe, isBuffer } = Buffer;

/** No-op callback — avoids allocating a new closure on every `.catch()`. */
export function noop(): void {}

/** Throw a "not initialized" error. */
export function notInitialized(): never {
  throw new Error("XXHash128: library not initialized. Call XXHash128.init() or XXHash128Wasm.init() before use.");
}

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

/**
 * Element-wise strict equality check for two readonly arrays.
 * Returns `true` when both arrays have the same length and every
 * element at the same index is `===`-equal.
 */
export function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) {
    return true;
  }
  const len = a.length;
  if (len !== b.length) {
    return false;
  }
  for (let i = 0; i < len; ++i) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Close a file handle, ignoring errors (best-effort). */
export function safeClose(fh: FileHandle): Promise<void> {
  return fh.close().catch(noop);
}

/**
 * Finalize a pending write: close handle -> rename temp -> final atomically.
 * On rename failure, removes the temp file (best-effort).
 */
export async function finalizeWrite(
  writeFh: FileHandle,
  tmpPath: string | null,
  outPath: string | null
): Promise<void> {
  await safeClose(writeFh);
  if (tmpPath && outPath) {
    try {
      await rename(tmpPath, outPath);
    } catch {
      await unlink(tmpPath).catch(noop);
    }
  } else if (tmpPath) {
    await unlink(tmpPath).catch(noop);
  }
}

export async function loadXxHash128WasmModule() {
  // biome-ignore lint/suspicious/noExplicitAny: Wasm and tsc issue for node, we don't want to bring all the dom lib
  return (globalThis as any).WebAssembly.compile(await readFile(new URL("./xxhash128.wasm", import.meta.url)));
}
