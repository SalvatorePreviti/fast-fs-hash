/**
 * LZ4 vs Node.js zlib deflate benchmark.
 *
 * Compares compression/decompression throughput and ratio.
 * Uses deflate (raw, no header) at level 1 for fair comparison —
 * both are fast block compressors targeting speed over ratio.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { lz4CompressBlock, lz4DecompressBlock } from "fast-fs-hash";
import { bench, describe } from "vitest";

function makeTestData(size: number): Buffer {
  const chunk = Buffer.from(
    'import { readFileSync } from "node:fs";\nconst data = readFileSync("package.json", "utf8");\nconsole.log(JSON.parse(data).name);\nexport function processFile(path: string) { return path; }\n'
  );
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += chunk.length) {
    chunk.copy(buf, i, 0, Math.min(chunk.length, size - i));
  }
  return buf;
}

const sizes = [
  { label: "64 KB", size: 65536 },
  { label: "1 MB", size: 1048576 },
];

for (const { label, size } of sizes) {
  const input = makeTestData(size);
  const lz4Compressed = lz4CompressBlock(input);
  const deflateCompressed = deflateRawSync(input, { level: 1 });

  const lz4Ratio = ((lz4Compressed.length / input.length) * 100).toFixed(1);
  const deflateRatio = ((deflateCompressed.length / input.length) * 100).toFixed(1);

  describe(`LZ4 vs deflate — ${label}`, () => {
    describe(`compress ${label}`, () => {
      bench(`native LZ4 [${lz4Ratio}%]`, () => {
        lz4CompressBlock(input);
      });

      bench(`Node.js deflate level=1 [${deflateRatio}%]`, () => {
        deflateRawSync(input, { level: 1 });
      });
    });

    describe(`decompress ${label}`, () => {
      bench("native LZ4", () => {
        lz4DecompressBlock(lz4Compressed, input.length);
      });

      bench("Node.js deflate", () => {
        inflateRawSync(deflateCompressed);
      });
    });
  });
}
