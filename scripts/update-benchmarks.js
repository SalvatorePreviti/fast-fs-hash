/**
 * Runs benchmarks and updates results in README.md.
 *
 * Usage:
 *   node scripts/update-benchmarks.js          — run benchmarks + update README
 *   node scripts/update-benchmarks.js --skip   — update README from last run
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { elapsed, logChanged, logError, logInfo, logOk, logTitle, ROOT_DIR } from "./lib/utils.js";

const t0 = performance.now();

const BENCH_JSON = resolve(ROOT_DIR, "test", "tmp", "bench-output.json");
const README = resolve(ROOT_DIR, "README.md");
const RAW_DATA_DIR = resolve(ROOT_DIR, "test", "bench", "raw-data");
const LIST_JSON_PATH = resolve(RAW_DATA_DIR, "list.json");

const BENCHMARKS_START = "<!-- BENCHMARKS:START -->";
const BENCHMARKS_END = "<!-- BENCHMARKS:END -->";

const FHC_BENCHMARKS_START = "<!-- FHC_BENCHMARKS:START -->";
const FHC_BENCHMARKS_END = "<!-- FHC_BENCHMARKS:END -->";

const HASH_BUFFER_START = "<!-- HASH_BUFFER_BENCHMARKS:START -->";
const HASH_BUFFER_END = "<!-- HASH_BUFFER_BENCHMARKS:END -->";

//  - Benchmark data size

/** Compute total bytes of the benchmark fixture files. */
function getBenchmarkTotalBytes() {
  if (!existsSync(LIST_JSON_PATH)) {
    return 0;
  }
  const list = JSON.parse(readFileSync(LIST_JSON_PATH, "utf8"));
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

/** Build a markdown table from header + rows (array of arrays). */
function markdownTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const hdr = `| ${headers.map((h, i) => h.padEnd(widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c, i) => String(c).padEnd(widths[i])).join(" | ")} |`).join("\n");
  return `${hdr}\n${sep}\n${body}`;
}

//  - Benchmark execution

function runBenchmarks() {
  if (process.argv.includes("--skip")) {
    if (!existsSync(BENCH_JSON)) {
      logError(`No previous benchmark output found at ${BENCH_JSON}`);
      logError("Run without --skip first.");
      process.exit(1);
    }
    logInfo("Reusing previous benchmark output.");
  } else {
    logInfo("Running benchmarks…");
    execSync(`npx vitest bench --outputJson ${BENCH_JSON}`, { cwd: ROOT_DIR, stdio: "inherit" });
  }
  return JSON.parse(readFileSync(BENCH_JSON, "utf8"));
}

//  - Result extraction

/** Find all benchmarks in a group whose fullName matches a substring. */
function findBenchesInGroup(data, groupSubstring) {
  const results = [];
  for (const file of data.files ?? []) {
    for (const group of file.groups ?? []) {
      if (group.fullName?.includes(groupSubstring)) {
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
    // Throughput in GB/s: totalBytes / mean_ms * 1000 / 1e9
    const gbps = totalBytes > 0 ? ((totalBytes / b.mean) * 1000) / 1e9 : 0;
    const gbpsStr = totalBytes > 0 ? `${gbps.toFixed(1)} GB/s` : "—";
    const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "—";
    return [b.name, `${fmt(b.mean, 1)} ms`, hzStr, gbpsStr, relative];
  });

  return [markdownTable(["Scenario", "Mean", "Hz", "Throughput", "Relative"], rows)];
}

/** Build two tables for FileHashCache benchmarks — native and WASM side by side. */
function buildFhcTables(benchGroups) {
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

  const buildRows = (benches) =>
    benches.map((b) => {
      const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "—";
      return [b.label, `${fmt(b.mean, 1)} ms`, hzStr];
    });

  const lines = [];
  if (nativeBenches.length > 0) {
    lines.push("**Native (C++ addon):**", "", markdownTable(["Scenario", "Mean", "Hz"], buildRows(nativeBenches)));
  }
  if (wasmBenches.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("**WASM fallback:**", "", markdownTable(["Scenario", "Mean", "Hz"], buildRows(wasmBenches)));
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

//  - Main

logTitle("Updating benchmarks");

const benchData = runBenchmarks();
const totalBytes = getBenchmarkTotalBytes();
const nodeVersion = `Node.js ${process.version}`;
const vitestVersion = `Vitest ${benchData.version ?? "4.x"}`;

//  - hashFilesBulk benchmarks

const hashBenches = findBenchesInGroup(benchData, "hashFilesBulk");

const hashSections = [
  `Results from ${nodeVersion}, ${vitestVersion}:`,
  "",
  ...buildComparisonTable(hashBenches, totalBytes),
  "",
  "_Results vary by hardware, file sizes, and OS cache state._",
];

//  - FileHashCache benchmarks

const FHC_GROUPS = [
  "FileHashCache — validate (no change)",
  "FileHashCache — serialize (no existing cache)",
  "FileHashCache — validate+serialize (1 file changed)",
];

const fhcGroups = FHC_GROUPS.map((g) => findBenchesInGroup(benchData, g));

const fhcSections = [
  `Results from ${nodeVersion}, ${vitestVersion}:`,
  "",
  ...buildFhcTables(fhcGroups),
  "",
  "_Results vary by hardware, file sizes, and OS cache state._",
];

//  - In-memory hash buffer benchmarks

const HASH_BUFFER_GROUPS = ["1 KB buffer", "64 KB buffer", "1 MB buffer"];

function buildHashBufferTables(benchData) {
  const lines = [];
  for (const groupName of HASH_BUFFER_GROUPS) {
    const benches = findBenchesInGroup(benchData, groupName);
    if (benches.length === 0) {
      continue;
    }

    const baseline = benches[benches.length - 1]; // slowest = baseline
    const rows = benches.map((b) => {
      const speedup = baseline.mean / b.mean;
      const relative = b === baseline ? "baseline" : `**${fmt(speedup, 1)}\xD7 faster**`;
      const hzStr = b.hz != null ? `${fmt(b.hz, 0)} op/s` : "\u2014";
      return [b.name, `${fmt(b.mean * 1000, 1)} \xB5s`, hzStr, relative];
    });

    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`**${groupName}:**`, "", markdownTable(["Scenario", "Mean", "Hz", "Relative"], rows));
  }
  return lines.length > 0 ? lines : ["_No benchmark data available._"];
}

const hashBufferSections = [
  `Results from ${nodeVersion}, ${vitestVersion}:`,
  "",
  ...buildHashBufferTables(benchData),
  "",
  "_Results vary by hardware._",
];

//  - Write README

let readme = readFileSync(README, "utf8");
readme = updateReadmeSection(readme, BENCHMARKS_START, BENCHMARKS_END, hashSections.join("\n"));
readme = updateReadmeSection(readme, FHC_BENCHMARKS_START, FHC_BENCHMARKS_END, fhcSections.join("\n"));
readme = updateReadmeSection(readme, HASH_BUFFER_START, HASH_BUFFER_END, hashBufferSections.join("\n"));

const original = readFileSync(README, "utf8");
if (readme !== original) {
  writeFileSync(README, readme, "utf8");
  logChanged("README.md updated with benchmark results");
} else {
  logOk("README.md benchmarks already up to date");
}

logOk(`Benchmarks updated (${elapsed(t0)})`);
