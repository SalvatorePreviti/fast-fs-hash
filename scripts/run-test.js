/**
 * Test runner wrapper.
 *
 * - Sets NO_COLOR=1 when stdout is not a TTY (e.g. Claude Code, CI pipes).
 * - Passes all extra arguments through to `vitest run`.
 *
 * Usage:
 *   node scripts/run-test.js              — run all tests
 *   node scripts/run-test.js test/foo.ts  — run specific test file
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dirname, "..");

// Disable colors when stdout is not a TTY (pipes, CI, Claude Code).
if (!process.stdout.isTTY) {
  process.env.NO_COLOR = "1";
}

const extraArgs = process.argv.slice(2).join(" ");
const cmd = `npx vitest run ${extraArgs}`.trim();

try {
  execSync(cmd, { cwd: ROOT_DIR, stdio: "inherit", env: { ...process.env } });
} catch (e) {
  process.exit(e.status || 1);
}
