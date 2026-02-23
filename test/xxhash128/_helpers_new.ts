/**
 * Shared setup and helpers for the xxHash128 tests.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as fsh from "fast-fs-hash";
import { afterAll, beforeAll } from "vitest";

export type BackendInstance = typeof fsh;
export type BackendEntry = [string, BackendInstance];

export const ALL_BACKENDS: BackendEntry[] = [["native", fsh]];

let _fixturesDir = "";
export const fixturesDir = (): string => _fixturesDir;

export function setupFixtures(suffix: string): void {
  const dir = path.resolve(import.meta.dirname, "..", "tmp", `xxhash128-${suffix}`);
  _fixturesDir = dir;

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

export function writeFixture(name: string, content: string | Buffer): string {
  const p = path.join(_fixturesDir, name);
  writeFileSync(p, content);
  return p;
}

export function hex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("hex");
}

export function makeBuffer(length: number, seed = 0): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = (i + seed) & 0xff;
  }
  return buf;
}

export function makeAsciiString(length: number): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(String.fromCharCode(33 + (i % 94)));
  }
  return chars.join("");
}

export function make2ByteUtf8String(charCount: number): string {
  const chars: string[] = [];
  for (let i = 0; i < charCount; i++) {
    chars.push(String.fromCharCode(0x00c0 + (i % 64)));
  }
  return chars.join("");
}

export function make3ByteUtf8String(charCount: number): string {
  const chars: string[] = [];
  for (let i = 0; i < charCount; i++) {
    chars.push(String.fromCharCode(0x4e00 + (i % 256)));
  }
  return chars.join("");
}
