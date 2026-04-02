/**
 * Runs benchmarks and updates results in README.md.
 *
 * Usage:
 *   node scripts/update-benchmarks.js          — run benchmarks + update README
 *   node scripts/update-benchmarks.js --skip   — update README from last run
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { elapsed, logChanged, logError, logInfo, logOk, logTitle, ROOT_DIR, runScript } from "./lib/utils.js";

const _prettierBin = resolve(ROOT_DIR, "node_modules/.bin/prettier");

function formatMarkdown(content, filePath) {
  try {
    return execFileSync(_prettierBin, ["--stdin-filepath", filePath, "--parser", "markdown"], {
      input: content,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT_DIR,
      shell: process.platform === "win32",
    });
  } catch {
    return content;
  }
}

const t0 = performance.now();

const BENCH_JSON = resolve(ROOT_DIR, "test", "tmp", "bench-output.json");
const README = resolve(ROOT_DIR, "README.md");
const RAW_DATA_DIR = resolve(ROOT_DIR, "test", "bench", "raw-data");
const LIST_JSON_PATH = resolve(RAW_DATA_DIR, "list.json");

const BENCH_ENV_START = "<!-- BENCH_ENV:START -->";
const BENCH_ENV_END = "<!-- BENCH_ENV:END -->";

const FHC_BENCHMARKS_START = "<!-- FHC_BENCHMARKS:START -->";
const FHC_BENCHMARKS_END = "<!-- FHC_BENCHMARKS:END -->";

const HASHFILE_BENCHMARKS_START = "<!-- HASHFILE_BENCHMARKS:START -->";
const HASHFILE_BENCHMARKS_END = "<!-- HASHFILE_BENCHMARKS:END -->";

const BENCHMARKS_START = "<!-- BENCHMARKS:START -->";
const BENCHMARKS_END = "<!-- BENCHMARKS:END -->";

const HASH_BUFFER_START = "<!-- HASH_BUFFER_BENCHMARKS:START -->";
const HASH_BUFFER_END = "<!-- HASH_BUFFER_BENCHMARKS:END -->";

const LZ4_BENCHMARKS_START = "<!-- LZ4_BENCHMARKS:START -->";
const LZ4_BENCHMARKS_END = "<!-- LZ4_BENCHMARKS:END -->";

const FILES_EQUAL_BENCHMARKS_START = "<!-- FILES_EQUAL_BENCHMARKS:START -->";
const FILES_EQUAL_BENCHMARKS_END = "<!-- FILES_EQUAL_BENCHMARKS:END -->";

//  - Benchmark data size

/** Read the benchmark fixture file list. */
function getBenchmarkFileList() {
  if (!existsSync(LIST_JSON_PATH)) {
    return [];
  }
  return JSON.parse(readFileSync(LIST_JSON_PATH, "utf8"));
}

/** Compute total bytes of the benchmark fixture files. */
function getBenchmarkTotalBytes(list) {
  let total = 0;
  for (const rel of list) {
    try {
      total += statSync(resolve(RAW_DATA_DIR, rel)).size;
    } catch {}
  }
  return total;
}

//  - Formatting helpers

/** Format a number with thousands separator (1 234) and fixed decimals. */
function fmt(n, decimals = 0) {
  if (n == null || Number.isNaN(n)) {
    return "—";
  }
  const fixed = n.toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** Format a time value in milliseconds — always shows both ms and µs. */
function fmtTime(meanMs) {
  if (meanMs == null || Number.isNaN(meanMs)) {
    return "—";
  }
  const us = meanMs * 1000;
  const msDecimals = us < 1 ? 4 : us < 10 ? 3 : us < 100 ? 2 : 1;
  return `${meanMs.toFixed(msDecimals)} ms (${fmt(us, 1)} µs)`;
}

function fmtThroughput(bytes, meanMs) {
  if (!bytes || !meanMs || meanMs <= 0) {
    return "—";
  }
  const bytesPerSec = (bytes / meanMs) * 1000;
  if (bytesPerSec >= 1e9) {
    return `${(bytesPerSec / 1e9).toFixed(1)} GB/s`;
  }
  if (bytesPerSec >= 1e6) {
    return `${(bytesPerSec / 1e6).toFixed(0)} MB/s`;
  }
  return `${(bytesPerSec / 1e3).toFixed(0)} KB/s`;
}

/** Build a markdown table from header + rows (array of arrays). */
function markdownTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const hdr = `| ${headers.map((h, i) => h.padEnd(widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c, i) => String(c).padEnd(widths[i])).join(" | ")} |`).join("\n");
  return `${hdr}\n${sep}\n${body}`;
}

//  - Benchmark execution

/** Only these bench files contribute to README sections. */
const README_BENCH_FILES = [
  "test/bench/hashfiles.bench.ts",
  "test/bench/hashfile.bench.ts",
  "test/bench/hash-buffer.bench.ts",
  "test/bench/file-hash-cache-validate.bench.ts",
  "test/bench/file-hash-cache-serialize.bench.ts",
  "test/bench/file-hash-cache-validate-serialize.bench.ts",
  "test/bench/file-hash-cache-validate-serialize-many.bench.ts",
  "test/bench/file-hash-cache-write-new.bench.ts",
  "test/bench/lz4.bench.ts",
  "test/bench/files-equal.bench.ts",
  "test/bench/file-hash-cache-locked.bench.ts",
];

function runBenchmarks() {
  if (process.argv.includes("--skip")) {
    if (!existsSync(BENCH_JSON)) {
      logError(`No previous benchmark output found at ${BENCH_JSON}`);
      logError("Run without --skip first.");
      process.exit(1);
    }
    logInfo("Reusing previous benchmark output.");
  } else {
    const fileArgs = README_BENCH_FILES.map((f) => resolve(ROOT_DIR, f)).join(" ");
    logInfo(`Running ${README_BENCH_FILES.length} benchmark files…`);
    execSync(`npx vitest bench --outputJson ${BENCH_JSON} ${fileArgs}`, { cwd: ROOT_DIR, stdio: "inherit" });
  }
  return JSON.parse(readFileSync(BENCH_JSON, "utf8"));
}

//  - Result extraction

/**
 * Extract the last segment of a vitest group fullName.
 * fullName looks like "path/to/file.bench.ts > outer > inner".
 * Returns the part after the last " > ".
 */
function groupNameSegment(fullName) {
  if (!fullName) {
    return "";
  }
  const idx = fullName.lastIndexOf(" > ");
  return idx >= 0 ? fullName.slice(idx + 3) : fullName;
}

/**
 * Find all benchmarks in a group whose fullName matches a pattern.
 * @param {object} data     Vitest bench JSON output.
 * @param {string} pattern  Substring to search for in group.fullName.
 * @param {boolean} [exact] When true, the last segment of fullName must
 *   equal pattern exactly (ignores the file-path prefix vitest prepends).
 */
function findBenchesInGroup(data, pattern, exact = false) {
  const results = [];
  for (const file of data.files ?? []) {
    for (const group of file.groups ?? []) {
      const match = exact ? groupNameSegment(group.fullName) === pattern : group.fullName?.includes(pattern);
      if (match) {
        for (const b of group.benchmarks ?? []) {
          if (b.mean != null) {
            results.push(b);
          }
        }
      }
    }
  }
  // Sort by rank (fastest first)
  results.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return results;
}

//  - Section builders

/** Build a comparison table for a set of benchmarks (slowest = baseline). */
function buildComparisonTable(benches, totalBytes) {
  if (benches.length === 0) {
    return ["_No benchmark data available._"];
  }

  const baseline = benches[benches.length - 1]; // slowest = baseline
  const rows = benches.map((b) => {
    const speedup = baseline.mean / b.mean;
    const relative = b === baseline ? "baseline" : `**${fmt(speedup, 1)}× faster**`;
    const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "—";
    return [b.name, fmtTime(b.mean), hzStr, fmtThroughput(totalBytes, b.mean), relative];
  });

  return [markdownTable(["Scenario", "Mean", "Hz", "Throughput", "Relative"], rows)];
}

/** Build two tables for FileHashCache benchmarks — native and WASM side by side. */
function buildFhcTables(benchGroups, totalFiles, totalBytes) {
  const allBenches = benchGroups.flat();
  if (allBenches.length === 0) {
    return ["_No benchmark data available._"];
  }

  const nativeBenches = [];
  const wasmBenches = [];
  for (const b of allBenches) {
    const name = b.name.trim().replace(/ {2,}/g, " ");
    if (name.startsWith("native")) {
      nativeBenches.push({ ...b, label: name.replace(/^native\s+/, "") });
    } else if (name.startsWith("wasm")) {
      wasmBenches.push({ ...b, label: name.replace(/^wasm\s+/, "") });
    }
  }

  // "no change" is stat-only — throughput is meaningless.
  // "1 file changed" reads one file — throughput is not meaningful.
  // "many files changed" and "no existing cache" read all files — show throughput.
  const needsThroughput = (label) => !label.includes("no change") && !label.includes("1 file");

  const buildRows = (benches) =>
    benches.map((b) => {
      const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "—";
      const filesPerSec = totalFiles && b.mean > 0 ? `${fmt((totalFiles / b.mean) * 1000, 0)} files/s` : "—";
      const throughput = needsThroughput(b.label) ? fmtThroughput(totalBytes, b.mean) : "—";
      return [b.label, fmtTime(b.mean), hzStr, filesPerSec, throughput];
    });

  const headers = ["Scenario", "Mean", "Hz", "Files/s", "Throughput"];
  const lines = [];
  if (nativeBenches.length > 0) {
    lines.push("**Native (C++ addon):**", "", markdownTable(headers, buildRows(nativeBenches)));
  }
  if (wasmBenches.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("**WASM fallback:**", "", markdownTable(headers, buildRows(wasmBenches)));
  }
  return lines;
}

//  - README update

function updateReadmeSection(readme, startMarker, endMarker, content) {
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    logError(`Could not find ${startMarker} / ${endMarker} markers in README.md`);
    process.exit(1);
  }
  return `${readme.slice(0, startIdx + startMarker.length)}\n\n${content}\n\n${readme.slice(endIdx)}`;
}

//  - Environment info

/** Detect CPU model string via Node.js os.cpus(). */
function getCpuModel() {
  const c = cpus();
  return c.length > 0 ? c[0].model.trim() : "unknown";
}

/** Detect OS label via Node.js os module. */
function getOsLabel() {
  const p = platform();
  const label = p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : p;
  return `${label} ${release()} (${arch()})`;
}

//  - Main

logTitle("Updating benchmarks");

const benchData = runBenchmarks();
const benchFileList = getBenchmarkFileList();
const totalBytes = getBenchmarkTotalBytes(benchFileList);
const totalFiles = benchFileList.length;
const nodeVersion = `Node.js ${process.version}`;
const vitestVersion = `Vitest ${benchData.version ?? "4.x"}`;
const cpuModel = getCpuModel();
const osLabel = getOsLabel();

//  - Consolidated benchmark environment header

const benchEnvSection = [
  `> ${nodeVersion}, ${vitestVersion} — ${cpuModel}, ${osLabel}, with anti-virus.`,
  ">",
  `> _Results vary by hardware, file sizes, and OS cache state._`,
];

//  - digestFilesParallel benchmarks (bulk file hashing)

const hashBenches = findBenchesInGroup(benchData, "digestFilesParallel", true);

const hashSections = buildComparisonTable(hashBenches, totalBytes);

//  - digestFile benchmarks (single file, multiple sizes)

const HASHFILE_SIZE_GROUPS = ["large file", "medium file", "small file"];

/**
 * Extract the actual group label (e.g. "small file (~1.0 KB)") from the
 * vitest bench JSON.  The fullName looks like:
 *   "digestFile (single file) > small file (~1.0 KB)"
 * We search for the HASHFILE_SIZE_GROUPS substring and return the full
 * last segment so the file-size annotation is preserved.
 */
function findHashFileGroup(data, pattern) {
  for (const file of data.files ?? []) {
    for (const group of file.groups ?? []) {
      if (group.fullName?.includes(pattern) && (group.benchmarks ?? []).some((b) => b.mean != null)) {
        // Last segment after " > " is the describe() label with the size
        const parts = group.fullName.split(" > ");
        return parts[parts.length - 1] || pattern;
      }
    }
  }
  return pattern;
}

/**
 * Parse a size annotation like "(~1.0 KB)" or "(~200 KB)" from a label string.
 * Returns the size in bytes, or 0 if not parseable.
 */
function parseSizeAnnotation(label) {
  const m = label.match(/\(~?([\d.]+)\s*(B|KB|MB|GB)\)/i);
  if (!m) {
    return 0;
  }
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "GB") {
    return n * 1e9;
  }
  if (unit === "MB") {
    return n * 1e6;
  }
  if (unit === "KB") {
    return n * 1e3;
  }
  return n;
}

function buildHashFileTables(benchData) {
  const lines = [];
  for (const groupName of HASHFILE_SIZE_GROUPS) {
    const benches = findBenchesInGroup(benchData, groupName);
    if (benches.length === 0) {
      continue;
    }

    // Use the full label from vitest output (includes file size)
    const label = findHashFileGroup(benchData, groupName);
    const fileBytes = parseSizeAnnotation(label);

    // Skip throughput for tiny files — I/O overhead dominates, making the number misleading.
    const showThroughput = fileBytes >= 10000;

    const baseline = benches[benches.length - 1]; // slowest = baseline
    const rows = benches.map((b) => {
      const speedup = baseline.mean / b.mean;
      const relative = b === baseline ? "baseline" : `**${fmt(speedup, 1)}\xD7 faster**`;
      const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "\u2014";
      const row = [b.name, fmtTime(b.mean), hzStr];
      if (showThroughput) {
        row.push(fmtThroughput(fileBytes, b.mean));
      }
      row.push(relative);
      return row;
    });

    const headers = showThroughput
      ? ["Scenario", "Mean", "Hz", "Throughput", "Relative"]
      : ["Scenario", "Mean", "Hz", "Relative"];

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`**${label}:**`, "", markdownTable(headers, rows));
  }
  return lines.length > 0 ? lines : ["_No benchmark data available._"];
}

const hashFileSections = buildHashFileTables(benchData);

//  - FileHashCache benchmarks

const FHC_GROUPS = [
  "FileHashCache — no change",
  "FileHashCache — 1 file changed",
  "FileHashCache — many files changed",
  "FileHashCache — no existing cache",
  "FileHashCache — writeNew",
];

const fhcGroups = FHC_GROUPS.map((g) => findBenchesInGroup(benchData, g));

const fhcSections = buildFhcTables(fhcGroups, totalFiles, totalBytes);

//  - In-memory hash buffer benchmarks

const HASH_BUFFER_GROUPS = ["64 KB buffer", "1 MB buffer"];

const HASH_BUFFER_BYTES = {
  "64 KB buffer": 65536,
  "1 MB buffer": 1048576,
};

function buildHashBufferTables(benchData) {
  const lines = [];
  for (const groupName of HASH_BUFFER_GROUPS) {
    const benches = findBenchesInGroup(benchData, groupName);
    if (benches.length === 0) {
      continue;
    }

    const bufBytes = HASH_BUFFER_BYTES[groupName] || 0;
    const baseline = benches[benches.length - 1]; // slowest = baseline
    const rows = benches.map((b) => {
      const speedup = baseline.mean / b.mean;
      const relative = b === baseline ? "baseline" : `**${fmt(speedup, 1)}\xD7 faster**`;
      const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "\u2014";
      return [b.name, fmtTime(b.mean), hzStr, fmtThroughput(bufBytes, b.mean), relative];
    });

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`**${groupName}:**`, "", markdownTable(["Scenario", "Mean", "Hz", "Throughput", "Relative"], rows));
  }
  return lines.length > 0 ? lines : ["_No benchmark data available._"];
}

const hashBufferSections = buildHashBufferTables(benchData);

//  - LZ4 benchmarks

const LZ4_SIZES = ["64 KB", "1 MB"];
const LZ4_BYTES = { "1 KB": 1024, "64 KB": 65536, "1 MB": 1048576 };

/**
 * Parse ratio annotation "[X%]" from bench name.
 * Returns { cleanName, ratio } where ratio is "X%" or null.
 */
function parseLz4Ratio(name) {
  const m = name.match(/^(.+?)\s*\[([\d.]+%)\]\s*$/);
  if (m) {
    return { cleanName: m[1].trim(), ratio: m[2] };
  }
  return { cleanName: name, ratio: null };
}

function buildLz4Tables(benchData) {
  const lines = [];
  for (const sizeLabel of LZ4_SIZES) {
    const bufBytes = LZ4_BYTES[sizeLabel] || 0;
    const ops = ["compress", "decompress"];

    for (const op of ops) {
      const benches = findBenchesInGroup(benchData, `${op} ${sizeLabel}`, true);
      if (benches.length === 0) {
        continue;
      }

      const isCompress = op === "compress";
      const baseline = benches[benches.length - 1];
      const rows = benches.map((b) => {
        const speedup = baseline.mean / b.mean;
        const relative = b === baseline ? "baseline" : `**${fmt(speedup, 1)}× faster**`;
        const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "—";
        const tp = bufBytes && b.mean > 0 ? fmtThroughput(bufBytes, b.mean) : "—";
        const { cleanName, ratio } = parseLz4Ratio(b.name);
        const row = [cleanName];
        if (isCompress) {
          row.push(ratio || "—");
        }
        row.push(fmtTime(b.mean), hzStr, tp, relative);
        return row;
      });

      const headers = isCompress
        ? ["Scenario", "Ratio", "Mean", "Hz", "Throughput", "Relative"]
        : ["Scenario", "Mean", "Hz", "Throughput", "Relative"];

      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(`**${op} ${sizeLabel}:**`, "", markdownTable(headers, rows));
    }
  }
  return lines.length > 0 ? lines : ["_No benchmark data available._"];
}

const lz4Sections = buildLz4Tables(benchData);

//  - filesEqual benchmarks

function buildFilesEqualTables(benchData) {
  const lines = [];
  // Collect all groups under the "filesEqual" top-level describe
  for (const file of benchData.files ?? []) {
    for (const group of file.groups ?? []) {
      if (!group.fullName?.includes("filesEqual")) {
        continue;
      }
      const benches = (group.benchmarks ?? []).filter((b) => b.mean != null);
      if (benches.length === 0) {
        continue;
      }
      benches.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

      const label = groupNameSegment(group.fullName);
      const fileBytes = parseSizeAnnotation(label);
      const showThroughput = fileBytes >= 10000;

      const baseline = benches[benches.length - 1];
      const rows = benches.map((b) => {
        const speedup = baseline.mean / b.mean;
        const relative = b === baseline ? "baseline" : `**${fmt(speedup, 1)}× faster**`;
        const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "—";
        const row = [b.name, fmtTime(b.mean), hzStr];
        if (showThroughput) {
          row.push(fmtThroughput(fileBytes, b.mean));
        }
        row.push(relative);
        return row;
      });

      const headers = showThroughput
        ? ["Scenario", "Mean", "Hz", "Throughput", "Relative"]
        : ["Scenario", "Mean", "Hz", "Relative"];

      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(`**${label}:**`, "", markdownTable(headers, rows));
    }
  }
  return lines.length > 0 ? lines : ["_No benchmark data available._"];
}

const filesEqualSections = buildFilesEqualTables(benchData);

//  - Write README

let readme = readFileSync(README, "utf8");
readme = updateReadmeSection(readme, BENCH_ENV_START, BENCH_ENV_END, benchEnvSection.join("\n"));
readme = updateReadmeSection(readme, FHC_BENCHMARKS_START, FHC_BENCHMARKS_END, fhcSections.join("\n"));
readme = updateReadmeSection(readme, HASHFILE_BENCHMARKS_START, HASHFILE_BENCHMARKS_END, hashFileSections.join("\n"));
readme = updateReadmeSection(readme, BENCHMARKS_START, BENCHMARKS_END, hashSections.join("\n"));
readme = updateReadmeSection(readme, HASH_BUFFER_START, HASH_BUFFER_END, hashBufferSections.join("\n"));
readme = updateReadmeSection(readme, LZ4_BENCHMARKS_START, LZ4_BENCHMARKS_END, lz4Sections.join("\n"));
readme = updateReadmeSection(
  readme,
  FILES_EQUAL_BENCHMARKS_START,
  FILES_EQUAL_BENCHMARKS_END,
  filesEqualSections.join("\n")
);
readme = formatMarkdown(readme, README);

const original = readFileSync(README, "utf8");
if (readme !== original) {
  writeFileSync(README, readme, "utf8");
  logChanged("README.md updated with benchmark results");
} else {
  logOk("README.md benchmarks already up to date");
}

// Sync README (+ LICENSE, NOTICES) to all publishable packages
await runScript("build-readme.js");

logOk(`Benchmarks updated (${elapsed(t0)})`);
