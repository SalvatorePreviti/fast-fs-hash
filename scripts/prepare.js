import { execFileSync } from "node:child_process";

// prepare.mjs — runs as npm "prepare" lifecycle hook.
// Installs lefthook git hooks for local development.
// Silently skips in CI or when git/lefthook are unavailable (e.g. Docker builds).

if (process.env.CI !== "true") {
  try {
    execFileSync("lefthook", ["install"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } catch {
    // Not an error — lefthook install is optional.
    // Can fail if git isn't installed, repo isn't a git checkout, etc.
  }
}
