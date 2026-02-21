/**
 * Generates deterministic benchmark fixture data in test/bench/raw-data/.
 *
 * Creates multiple subdirectories with varied file sizes so benchmarks
 * exercise both small-file-count overhead and large-file throughput.
 *
 * Layout:
 *   raw-data/
 *     tiny/          — 200 files,   64 B – 512 B each
 *     small/         — 200 files,  512 B – 4 KiB each
 *     medium/        — 150 files,  4 KiB – 64 KiB each
 *     large/         — 50 files,  64 KiB – 256 KiB each
 *     xlarge/        — 4 files,   1 MiB each
 *     mixed/         — 100 files,   0 B  – 128 KiB each (some empty)
 *     list.json      — sorted array of all relative paths (including itself)
 *
 * Total: ~704 files, deterministic content seeded from file index.
 *
 * Run:  node test/bench/generate-raw-data.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RAW_DATA_DIR = path.join(__dirname, "raw-data");
const LIST_JSON = "list.json";

/** Simple seeded PRNG (xorshift32) — deterministic per-file content. */
function xorshift32(seed) {
  let s = seed | 1; // must not be 0
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

/** Generate a Buffer of `size` bytes with deterministic content from `seed`. */
function generateContent(seed, size) {
  if (size === 0) {
    return Buffer.alloc(0);
  }
  const rng = xorshift32(seed);
  const buf = Buffer.allocUnsafe(size);
  // Fill 4 bytes at a time for speed
  let i = 0;
  for (; i + 3 < size; i += 4) {
    buf.writeUInt32LE(rng(), i);
  }
  // Remaining bytes
  if (i < size) {
    const last = rng();
    for (let j = 0; j < size - i; j++) {
      buf[i + j] = (last >>> (j * 8)) & 0xff;
    }
  }
  return buf;
}

/** Return a deterministic integer in [min, max). */
function randRange(rng, min, max) {
  return min + (rng() % (max - min));
}

const DIRS = [
  { name: "tiny", count: 200, minSize: 64, maxSize: 512 },
  { name: "small", count: 200, minSize: 512, maxSize: 4096 },
  { name: "medium", count: 150, minSize: 4096, maxSize: 65536 },
  { name: "large", count: 50, minSize: 65536, maxSize: 262144 },
  { name: "xlarge", count: 4, minSize: 1048576, maxSize: 1048577 },
  { name: "mixed", count: 100, minSize: 0, maxSize: 131072 },
];

function generate() {
  // Clean & recreate
  if (fs.existsSync(RAW_DATA_DIR)) {
    fs.rmSync(RAW_DATA_DIR, { recursive: true });
  }

  const allPaths = [];

  // list.json goes first (will be generated last, but path is known)
  allPaths.push(LIST_JSON);

  let globalSeed = 0x12345678;

  for (const dir of DIRS) {
    const dirPath = path.join(RAW_DATA_DIR, dir.name);
    fs.mkdirSync(dirPath, { recursive: true });

    const rng = xorshift32(globalSeed);
    globalSeed = rng();

    for (let i = 0; i < dir.count; i++) {
      const ext = i % 5 === 0 ? ".json" : i % 3 === 0 ? ".txt" : ".bin";
      const fileName = `file-${String(i).padStart(4, "0")}${ext}`;
      const filePath = path.join(dirPath, fileName);
      const relPath = path.posix.join(dir.name, fileName);

      const size = randRange(rng, dir.minSize, dir.maxSize);
      const content = generateContent(rng(), size);

      fs.writeFileSync(filePath, content);
      allPaths.push(relPath);
    }
  }

  // Sort for deterministic ordering
  allPaths.sort();

  // Write list.json
  const listPath = path.join(RAW_DATA_DIR, LIST_JSON);
  fs.writeFileSync(listPath, JSON.stringify(allPaths, null, 2) + "\n");

  const totalSize = allPaths.reduce((acc, rel) => {
    const full = path.join(RAW_DATA_DIR, rel);
    try {
      return acc + fs.statSync(full).size;
    } catch {
      return acc;
    }
  }, 0);

  console.log(
    `Generated ${allPaths.length} files in ${RAW_DATA_DIR} (${(totalSize / 1024 / 1024).toFixed(1)} MiB total)`
  );
}

// ── Entrypoint ────────────────────────────────────────────────────────

if (require.main === module) {
  generate();
} else {
  module.exports = { generate, RAW_DATA_DIR, LIST_JSON };
}
