#!/usr/bin/env node

/**
 * Build script for fast-fs-hash.
 *
 * 1. Bundles src/index.ts → dist/index.mjs (ESM) using rolldown.
 * 2. Bundles a CJS wrapper → dist/index.cjs using rolldown.
 * 3. Generates type declarations via tsc + rollup-plugin-dts.
 *
 * Same pattern as vite-plugin-fuse's build script.
 */

import { exec } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const rootDir = resolve(import.meta.dirname, "..");
const pkgDir = resolve(rootDir, "packages/fast-fs-hash");
const srcDir = resolve(pkgDir, "src");
const distDir = resolve(pkgDir, "dist");

mkdirSync(distDir, { recursive: true });

// ── ESM bundle ───────────────────────────────────────────────────────────

async function buildESMBundle() {
  console.time("Building ESM bundle...");
  const { build } = await import("rolldown");

  await build({
    input: resolve(srcDir, "index.ts"),
    external: [/^node:/, /^@fast-fs-hash\//],
    output: {
      file: resolve(distDir, "index.mjs"),
      format: "esm",
      sourcemap: true,
      comments: { jsdoc: true, annotation: true, legal: true },
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    platform: "node",
  });

  console.timeEnd("Building ESM bundle...");
}

// ── CJS bundle ───────────────────────────────────────────────────────────

async function buildCJSBundle() {
  console.time("Building CJS bundle...");
  const { build } = await import("rolldown");

  await build({
    input: resolve(srcDir, "index.ts"),
    external: [/^node:/, /^@fast-fs-hash\//],
    plugins: [
      {
        name: "cjs-redirect",
        resolveId(source) {
          // Redirect ESM-style ./index import to the .mjs file
          if (source === "./index" || source === "./index.js") {
            return { id: "./index.mjs", external: true };
          }
          return null;
        },
      },
    ],
    output: {
      file: resolve(distDir, "index.cjs"),
      format: "cjs",
      sourcemap: true,
      comments: { jsdoc: true, annotation: true, legal: true },
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    platform: "node",
  });

  console.timeEnd("Building CJS bundle...");
}

// ── Type declarations ────────────────────────────────────────────────────

async function generateTypeDeclarations() {
  console.time("Generating type declarations...");

  const tmpDir = resolve(pkgDir, "dist-types-tmp");
  rmSync(tmpDir, { recursive: true, force: true });

  try {
    // Step 1: Emit .d.ts via tsc
    await execAsync(`npx tsc -p tsconfig.json --emitDeclarationOnly --declarationMap false --outDir "${tmpDir}"`, {
      cwd: pkgDir,
    }).catch((err) => {
      const msg = (err.stdout || err.stderr || err.message || "").trim();
      if (msg) {
        console.error(msg);
      }
      throw err;
    });

    // Step 2: Bundle with rollup-plugin-dts
    const { rollup } = await import("rollup");
    const { dts } = await import("rollup-plugin-dts");

    const bundle = await rollup({
      input: resolve(tmpDir, "index.d.ts"),
      plugins: [dts({ respectExternal: true })],
      external: [],
    });
    await bundle.write({ file: resolve(distDir, "index.d.ts"), format: "es" });
    await bundle.close();

    // Step 3: CJS type declaration
    writeFileSync(resolve(distDir, "index.d.cts"), 'export * from "./index.js";\n');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.timeEnd("Generating type declarations...");
}

// ── Inject optionalDependencies for publish ─────────────────────────────

function injectOptionalDeps() {
  const pkgJsonPath = resolve(pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

  // Only inject if not already present (idempotent)
  if (!pkg.optionalDependencies) {
    const version = pkg.version;
    pkg.optionalDependencies = {
      "@fast-fs-hash/darwin-arm64": version,
      "@fast-fs-hash/darwin-x64": version,
      "@fast-fs-hash/freebsd-x64": version,
      "@fast-fs-hash/linux-arm64-gnu": version,
      "@fast-fs-hash/linux-arm64-musl": version,
      "@fast-fs-hash/linux-x64-gnu": version,
      "@fast-fs-hash/linux-x64-musl": version,
      "@fast-fs-hash/win32-arm64-msvc": version,
      "@fast-fs-hash/win32-x64-msvc": version,
    };
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("Injected optionalDependencies into package.json (version " + version + ")");
  }
}

// ── Run ──────────────────────────────────────────────────────────────────

console.time("Build completed");
await Promise.all([buildESMBundle(), buildCJSBundle()]);
copyFileSync(resolve(srcDir, "xxhash128.wasm"), resolve(distDir, "xxhash128.wasm"));
console.log("Copied xxhash128.wasm to dist/");
await generateTypeDeclarations();

// Only inject for CI/publish — controlled by env var
if (process.env.INJECT_OPTIONAL_DEPS === "1") {
  injectOptionalDeps();
}

console.timeEnd("Build completed");
