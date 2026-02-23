#!/usr/bin/env node

/**
 * Builds the xxhash128 WebAssembly module using Emscripten (emcc).
 *
 * Source: packages/fast-fs-hash/src/wasm/xxhash128.c
 * Output: packages/fast-fs-hash/src/xxhash128.wasm
 *
 * emcc is located via (in order):
 *   1. EMCC env var
 *   2. PATH
 *   3. $EMSDK/upstream/emscripten/emcc
 *   4. ~/emsdk/upstream/emscripten/emcc
 *
 * Usage:
 *   node scripts/build-wasm.js
 *   EMCC=/path/to/emcc node scripts/build-wasm.js
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { elapsed, logInfo, logOk, ROOT_DIR, SRC_DIR } from "./lib/utils.js";

// ─── Locate emcc ──────────────────────────────────────────────────────────────

/**
 * Returns the path to emcc, or null if it cannot be found.
 * Searches: EMCC env var → EMSDK env var → ~/emsdk → PATH.
 */
function findEmcc() {
  // 1. Explicit env override
  if (process.env.EMCC) {
    return process.env.EMCC;
  }

  // 2. EMSDK env var
  if (process.env.EMSDK) {
    const candidate = path.join(process.env.EMSDK, "upstream", "emscripten", "emcc");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 3. Well-known locations: ~/emsdk
  const homeEmsdk = path.join(os.homedir(), "emsdk", "upstream", "emscripten", "emcc");
  if (existsSync(homeEmsdk)) {
    return homeEmsdk;
  }

  // 4. Check PATH by trying to resolve via `which`/`where`
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["emcc"], { stdio: "ignore" });
    return "emcc";
  } catch {
    return null;
  }
}

// ─── Build ────────────────────────────────────────────────────────────────────

const t0 = performance.now();

const emcc = findEmcc();
const xxhashDir = path.resolve(ROOT_DIR, "deps", "xxHash");
const wasmSrc = path.resolve(SRC_DIR, "wasm", "xxhash128.c");
const wasmOut = path.resolve(SRC_DIR, "xxhash128.wasm");

if (!emcc) {
  logInfo("emcc not found — skipping WASM build (pre-built xxhash128.wasm used).");
  logInfo("To rebuild WASM: source ~/emsdk/emsdk_env.sh && npm run build:wasm");
  process.exit(0);
}

logInfo(`Building xxhash128.wasm (emcc: ${emcc})...`);

// Emscripten flags:
//
//   -O3 -flto            Maximum optimization + link-time optimization
//   --no-entry           No main() entry point — pure library WASM module
//   -s STANDALONE_WASM=1 Emit a standalone WASM file (no JS glue needed)
//   -s INITIAL_MEMORY    Fixed memory size; 262144 = 4 WASM pages = 256 KiB
//   -s ALLOW_MEMORY_GROWTH=0  Statically sized memory → simpler, smaller binary
//   -s ASSERTIONS=0      Disable runtime assertions (already implied by -O3)
//   -I deps/xxHash       xxhash.h include path
//   -DXXH_IMPLEMENTATION  Embed the xxHash implementation in this TU
//   -DXXH_STATIC_LINKING_ONLY  Expose full XXH3_state_t struct definition
//   -DXXH_VECTOR=4       XXH_NEON = WASM SIMD128 path (via SIMDe arm_neon.h polyfill).
//                        Node.js 18.20+ / 20.8+ / 22+ support WASM SIMD natively (no flag).
//                        If the runtime does not support SIMD, WebAssembly.compile() throws
//                        a CompileError — the module will not silently fall back to scalar.
//   -msimd128            Emit WebAssembly SIMD 128-bit opcodes (v128 type).
//   -fno-exceptions -fno-rtti  No C++ overhead (C code, but just in case)
//   -fomit-frame-pointer
//   -funroll-loops
//   -Wl,--strip-all      Strip debug/name/producers sections → deterministic binary
//   --export=*           Explicitly list all public symbols so they survive
//                        dead-code elimination

const emccArgs = [
  wasmSrc,
  "-O3",
  "-flto",
  "--no-entry",
  "-s",
  "STANDALONE_WASM=1",
  "-s",
  `INITIAL_MEMORY=${196608}`, // 192 KiB = 3 WASM pages (fixed)
  "-s",
  "ALLOW_MEMORY_GROWTH=0",
  "-s",
  "ASSERTIONS=0",
  "-s",
  "STACK_SIZE=8192", // 8 KiB stack — xxHash uses minimal stack
  `-I${xxhashDir}`,
  "-DXXH_IMPLEMENTATION",
  "-DXXH_STATIC_LINKING_ONLY",
  "-DXXH_VECTOR=4", // XXH_NEON → WASM SIMD128 via SIMDe arm_neon.h
  "-msimd128", // emit WASM SIMD128 instructions
  "-fno-exceptions",
  "-fno-rtti",
  "-fomit-frame-pointer",
  "-funroll-loops",
  "-fmerge-all-constants",
  "-Wl,--strip-all", // strip debug/name/producers sections → deterministic binary
  "-Wl,--export=Wasm_GetBuffer",
  "-Wl,--export=Wasm_GetState",
  "-Wl,--export=Wasm_Init",
  "-Wl,--export=Wasm_Update",
  "-Wl,--export=Wasm_Final",
  "-Wl,--export=Wasm_StateSize",
  "-Wl,--export=Wasm_SyncInitUpdate",
  "-Wl,--export=Wasm_SyncUpdate",
  "-Wl,--export=Wasm_SyncFinal",
  "-Wl,--export=Wasm_SyncCalculate",
  "-Wl,--export=Wasm_InitSeedless",
  "-Wl,--export=Wasm_SyncInitUpdateSeedless",
  "-Wl,--export=Wasm_SyncCalculateSeedless",
  "-Wl,--export=Wasm_FinalLE",
  "-Wl,--export=Wasm_SyncCalculateLE",
  "-o",
  wasmOut,
];

try {
  execFileSync(emcc, emccArgs, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env,
  });
} catch {
  process.exit(1);
}

// Print output size
try {
  const { size } = statSync(wasmOut);
  const kb = (size / 1024).toFixed(1);
  logOk(`xxhash128.wasm: ${kb} KB (${size} bytes) in ${elapsed(t0)}`);
} catch {
  // file may not exist on cross-compile dry runs
}
