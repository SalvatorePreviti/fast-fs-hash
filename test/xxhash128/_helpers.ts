/**
 * Shared constants, fixtures, and helpers for xxhash128 test files.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { XXHash128, XXHash128Wasm } from "fast-fs-hash";
import { afterAll, beforeAll } from "vitest";

//  - Known xxHash3-128 values (seed 0 unless noted)

/** hash("") */
export const H_EMPTY = "99aa06d3014798d86001c324468d497f";
/** hash("hello world") */
export const H_HELLO_WORLD = "df8d09e93f874900a99b8775cc15b6c7";
/** hash("hello") */
export const H_HELLO = "b5e9c1ad071b3e7fc779cfaa5e523818";
/** hash("world") */
export const H_WORLD = "fa0d38a9b38280d0891e4985bdb2583e";
/** hash("hello world\n") — file a.txt content */
export const H_HELLO_WORLD_LF = "eefac9d87100cd1336b2e733a5484425";
/** hash("goodbye world\n") — file b.txt content */
export const H_GOODBYE_WORLD_LF = "472e10c9821c728278f31afb08378f2f";
/** hash("second input") */
export const H_SECOND_INPUT = "3ee0a1fa1aee88446d7fc964fd741cee";
/** hash("deterministic test input") */
export const H_DETERMINISTIC = "d4eda7f49d59fcbd3b2a44403aa95841";
/** hash("alphabetagammadelta") — streaming: alpha + beta + gamma + delta */
export const H_ABGD = "1711218225c1291b3a4be5addce11463";

/** hash("hello world", seed 42, 0) */
export const H_HW_SEED_42_0 = "5a5ecb4a698378a282c1ce3b43a636ba";
/** hash("hello world", seed 0, 42) */
export const H_HW_SEED_0_42 = "ef8e7031c4aed4e25d34b0470936b5b2";
/** hash("hello world", seed 123, 456) */
export const H_HW_SEED_123_456 = "954ea75c6dc99739878336dd196d0dc6";
/** hash("hello world", seed 42, 99) */
export const H_HW_SEED_42_99 = "fa02c118551d9e0e2765c10f89392d8e";
/** hash("hello world", seed 0xffffffff, 0xffffffff) */
export const H_HW_SEED_MAX = "81b1c25a11865b660e073134928addc0";
/** hash("test", seed 0xffffffff, 0xffffffff) */
export const H_TEST_SEED_MAX = "6cc7cd132e2ff1eeac22e8e10a24ee1d";

/** updateFilesBulk([a,b]) combined digest */
export const HF_AB_COMBINED = "14cb7b529dbb3358999291d5315f9ec8";
/** updateFilesBulk([b,a]) combined digest */
export const HF_BA_COMBINED = "b96712ebc4252558f427015fab836b59";
/** updateFilesBulk([a, missing]) combined digest */
export const HF_A_MISSING_COMBINED = "3bd4a3acde4c43af41d10b55b7dcc098";
/** Zero hash (unreadable / missing file) */
export const H_ZERO = "0".repeat(32);

/** hash(salt="mysalt" + "hello world\n", seed 0,0) */
export const HF_A_SALT_MYSALT = "f269da00a3f956f199158556730e4af1";
/** hash(salt="mysalt" + "hello world\n", seed 42,0) */
export const HF_A_SALT_MYSALT_SEED42 = "ffc8b234b10f7b17def04905ebb1d001";
/** hash(salt="mysalt" + "hello world\n", seed 0xffffffff,0xffffffff) */
export const HF_A_SALT_MYSALT_SEED_MAX = "792cc06f75a86868388691e89a723956";
/** hash("hello world\n", seed 42,0) */
export const HF_A_SEED_42_0 = "860ad33aa44f26a9ae34601b61d5637c";
/** hash("hello world\n", seed 0,42) */
export const HF_A_SEED_0_42 = "4d1bb5a5314ef1e687c3e451ac6176e5";
/** hash("hello world\n", seed 123,456) */
export const HF_A_SEED_123_456 = "5af43df781f7e9963b9c2d89ca3ebc5a";
/** hash("goodbye world\n", seed 42,0) */
export const HF_B_SEED_42_0 = "4638f724963550a71a54688c03cf18ad";
/** hash(salt=[1,2,3,4] + binary.bin, seed 0,0) */
export const HF_BINARY_SALT_1234 = "48ff1eeae97208f1b02ffd1307ccc6da";

//  - Test fixtures

export const FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "fixtures-xxhash128");

export const fileA = () => path.join(FIXTURES_DIR, "a.txt");
export const fileB = () => path.join(FIXTURES_DIR, "b.txt");
export const fileEmpty = () => path.join(FIXTURES_DIR, "empty.txt");

//  - Helper: run tests for both implementations

export type HasherClass = typeof XXHash128 | typeof XXHash128Wasm;

export const implementations: [string, HasherClass][] = [
  ["XXHash128 (native)", XXHash128],
  ["XXHash128Wasm", XXHash128Wasm],
];

/**
 * Call once per test file to set up fixtures + init both hashers.
 */
export function setupXXHash128Fixtures(): void {
  beforeAll(async () => {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURES_DIR, { recursive: true });

    writeFileSync(fileA(), "hello world\n");
    writeFileSync(fileB(), "goodbye world\n");
    writeFileSync(fileEmpty(), "");

    await XXHash128Wasm.init();
    await XXHash128.init();
  });

  afterAll(() => {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });
}
