#!/usr/bin/env node

/**
 * Smoke test — verifies fast-fs-hash works after npm install from the registry.
 *
 * Exercises every major feature through the native binding:
 *   - xxHash128 on buffers and files (sync + async)
 *   - LZ4 compress/decompress on buffers and files
 *   - FileHashCache open → write → re-open → verify upToDate
 *
 * Exit code 0 = all checks passed, non-zero = failure.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(tmpdir(), `ffsh-smoke-${process.pid}-${Date.now()}`);

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  \u2714 ${name}`);
    passed++;
  } else {
    console.error(`  \u2718 ${name}`);
    failed++;
  }
}

async function main() {
  const ffsh = await import("fast-fs-hash");

  mkdirSync(tmp, { recursive: true });
  const fileA = join(tmp, "a.txt");
  const fileB = join(tmp, "b.txt");
  const fileC = join(tmp, "c.txt");
  writeFileSync(fileA, "hello world");
  writeFileSync(fileB, "hello world");
  writeFileSync(fileC, "different content");

  console.log("Smoke test: fast-fs-hash\n");
  console.log(`  platform: ${process.platform}-${process.arch}`);
  console.log(`  node:     ${process.version}\n`);

  // -- xxHash128: buffers --

  console.log("xxHash128 — buffers:");

  const bufHash = ffsh.digestBuffer(Buffer.from("hello world"));
  check("digestBuffer returns 16-byte Buffer", Buffer.isBuffer(bufHash) && bufHash.length === 16);

  const strHash = ffsh.digestString("hello world");
  check("digestString returns 16-byte Buffer", Buffer.isBuffer(strHash) && strHash.length === 16);

  check("digestBuffer == digestString for same input", bufHash.equals(strHash));

  const hex = ffsh.hashToHex(bufHash);
  check("hashToHex returns 32-char hex", typeof hex === "string" && /^[0-9a-f]{32}$/.test(hex));

  const otherHash = ffsh.digestString("other");
  check("different inputs produce different hashes", !bufHash.equals(otherHash));

  // -- xxHash128: files --

  console.log("\nxxHash128 — files:");

  const fileHash = await ffsh.digestFile(fileA);
  check("digestFile returns 16-byte Buffer", Buffer.isBuffer(fileHash) && fileHash.length === 16);
  check("digestFile matches digestString for same content", fileHash.equals(strHash));

  const fileHex = await ffsh.digestFileToHex(fileA);
  check("digestFileToHex returns 32-char hex", /^[0-9a-f]{32}$/.test(fileHex));
  check("digestFileToHex == hashToHex(digestFile)", fileHex === hex);

  const hashes = await ffsh.digestFilesToHexArray([fileA, fileB, fileC]);
  check("digestFilesToHexArray returns correct count", Array.isArray(hashes) && hashes.length === 3);
  check("identical files produce same hex", hashes[0] === hashes[1]);
  check("different files produce different hex", hashes[0] !== hashes[2]);

  const eq1 = await ffsh.filesEqual(fileA, fileB);
  const eq2 = await ffsh.filesEqual(fileA, fileC);
  check("filesEqual: identical files -> true", eq1 === true);
  check("filesEqual: different files -> false", eq2 === false);

  // -- LZ4: buffers --

  console.log("\nLZ4 — buffers:");

  const lz4Input = Buffer.from("hello world ".repeat(100));
  const compressed = ffsh.lz4CompressBlock(lz4Input);
  check("lz4CompressBlock returns Buffer", Buffer.isBuffer(compressed));
  check("lz4CompressBlock actually compresses", compressed.length < lz4Input.length);
  const decompressed = ffsh.lz4DecompressBlock(compressed, lz4Input.length);
  check("lz4 round-trip matches original", lz4Input.equals(decompressed));

  // -- LZ4: files --

  console.log("\nLZ4 — files:");

  const lz4File = join(tmp, "lz4-test.txt");
  const lz4Content = "lz4 file test content ".repeat(50);
  writeFileSync(lz4File, lz4Content);

  const { data: lz4Data, uncompressedSize } = await ffsh.lz4ReadAndCompress(lz4File);
  check("lz4ReadAndCompress returns data", Buffer.isBuffer(lz4Data));
  check("lz4ReadAndCompress returns correct uncompressedSize", uncompressedSize === Buffer.byteLength(lz4Content));
  check("lz4ReadAndCompress compresses", lz4Data.length < uncompressedSize);

  const lz4OutFile = join(tmp, "lz4-out.txt");
  await ffsh.lz4DecompressAndWrite(lz4OutFile, lz4Data, uncompressedSize);

  const roundTripEqual = await ffsh.filesEqual(lz4File, lz4OutFile);
  check("lz4DecompressAndWrite round-trips correctly", roundTripEqual === true);

  // -- FileHashCache: write → read → verify --

  console.log("\nFileHashCache:");

  const cachePath = join(tmp, "cache.fsh");
  const cacheFiles = [fileA, fileB, fileC];

  // First open: cache does not exist -> status should be 'missing'
  {
    await using cache = await ffsh.FileHashCache.open(cachePath, tmp, cacheFiles, 1);
    check("first open: status is 'missing'", cache.status === "missing");
    check("first open: fileCount matches", cache.fileCount === 3);

    const written = await cache.write();
    check("write() returns true", written === true);
  }

  // Second open: cache exists and files unchanged -> status should be 'upToDate'
  {
    await using cache = await ffsh.FileHashCache.open(cachePath, tmp, cacheFiles, 1);
    check("second open: status is 'upToDate'", cache.status === "upToDate");
    check("second open: fileCount matches", cache.fileCount === 3);
  }

  // Modify a file and re-open: status should be 'changed'
  writeFileSync(fileC, "modified content");
  {
    await using cache = await ffsh.FileHashCache.open(cachePath, tmp, cacheFiles, 1);
    check("after modify: status is 'changed'", cache.status === "changed");

    const written = await cache.write();
    check("re-write returns true", written === true);
  }

  // Verify it's up-to-date again after re-write
  {
    await using cache = await ffsh.FileHashCache.open(cachePath, tmp, cacheFiles, 1);
    check("after re-write: status is 'upToDate'", cache.status === "upToDate");
  }

  // Version change -> stale
  {
    await using cache = await ffsh.FileHashCache.open(cachePath, tmp, cacheFiles, 2);
    check("version bump: status is 'stale'", cache.status === "stale");
  }

  // writeNew convenience method
  const cachePathNew = join(tmp, "cache-new.fsh");
  const wnResult = await ffsh.FileHashCache.writeNew(cachePathNew, tmp, cacheFiles);
  check("writeNew returns true", wnResult === true);

  {
    await using cache = await ffsh.FileHashCache.open(cachePathNew, tmp, cacheFiles, 0);
    check("after writeNew: status is 'upToDate'", cache.status === "upToDate");
  }

  // -- Summary --

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
}

try {
  await main();
} catch (err) {
  console.error("\nSmoke test crashed:", err);
  failed++;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  process.exit(1);
}
