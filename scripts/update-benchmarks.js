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

// ── Benchmark data size ──────────────────────────────────────────────────────

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

// ── Formatting helpers ───────────────────────────────────────────────────────

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

// ── Benchmark execution ──────────────────────────────────────────────────────

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

// ── Result extraction ────────────────────────────────────────────────────────

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

// ── Section builders ─────────────────────────────────────────────────────────

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
    return [b.name, `${fmt(b.mean, 1)} ms`, gbpsStr, relative];
  });

  return [markdownTable(["Scenario", "Mean", "Throughput", "Relative"], rows)];
}

// ── README update ────────────────────────────────────────────────────────────

function updateReadme(content) {
  const readme = readFileSync(README, "utf8");
  const startIdx = readme.indexOf(BENCHMARKS_START);
  const endIdx = readme.indexOf(BENCHMARKS_END);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    logError(`Could not find ${BENCHMARKS_START} / ${BENCHMARKS_END} markers in README.md`);
    process.exit(1);
  }
  const updated = `${readme.slice(0, startIdx + BENCHMARKS_START.length)}\n\n${content}\n\n${readme.slice(endIdx)}`;
  if (updated !== readme) {
    writeFileSync(README, updated, "utf8");
    logChanged("README.md updated with benchmark results");
  } else {
    logOk("README.md benchmarks already up to date");
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

logTitle("Updating benchmarks");

const benchData = runBenchmarks();

const benches = findBenchesInGroup(benchData, "hashFilesBulk");
const totalBytes = getBenchmarkTotalBytes();

const sections = [
  `Results from Node.js ${process.version}, Vitest ${benchData.version ?? "4.x"}:`,
  "",
  ...buildComparisonTable(benches, totalBytes),
  "",
  "_Results vary by hardware, file sizes, and OS cache state._",
];

updateReadme(sections.join("\n"));

logOk(`Benchmarks updated (${elapsed(t0)})`);
