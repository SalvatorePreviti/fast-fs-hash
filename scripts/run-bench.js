/**
 * Benchmark runner wrapper.
 *
 * - Sets NO_COLOR=1 when stdout is not a TTY (e.g. Claude Code, CI pipes).
 * - Writes a timestamped JSON report to /tmp/fast-fs-hash-bench/ after each run.
 * - Passes all extra arguments through to `vitest bench`.
 *
 * Usage:
 *   node scripts/run-bench.js                    — run all benchmarks
 *   node scripts/run-bench.js test/bench/foo.ts   — run specific bench file
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dirname, "..");
const REPORT_DIR = "/tmp/fast-fs-hash-bench";
const VITEST_JSON = resolve(ROOT_DIR, "test/tmp/bench-output.json");

// Disable colors when stdout is not a TTY (pipes, CI, Claude Code).
if (!process.stdout.isTTY) {
  process.env.NO_COLOR = "1";
}

// Build vitest command with pass-through args and JSON output.
const extraArgs = process.argv.slice(2).join(" ");
const cmd = `npx vitest bench --outputJson ${VITEST_JSON} ${extraArgs}`.trim();

try {
  execSync(cmd, { cwd: ROOT_DIR, stdio: "inherit", env: { ...process.env } });
} catch (e) {
  // vitest exits with non-zero on benchmark failure — still save the report if JSON was written.
  if (!existsSync(VITEST_JSON)) {
    process.exit(e.status || 1);
  }
}

// Save timestamped report.
if (existsSync(VITEST_JSON)) {
  mkdirSync(REPORT_DIR, { recursive: true });

  const now = new Date();
  const ts = now.toISOString().replace(/[T]/g, "_").replace(/[:.]/g, "-").replace("Z", "");
  const reportPath = resolve(REPORT_DIR, `bench_${ts}.json`);

  const raw = readFileSync(VITEST_JSON, "utf8");
  writeFileSync(reportPath, raw, "utf8");

  const size = (Buffer.byteLength(raw) / 1024).toFixed(1);
  console.log(`\nBenchmark report: ${reportPath} (${size} KB)`);
}
