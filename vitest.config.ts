import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "fast-fs-hash/file-hash-cache-format": path.resolve(
        import.meta.dirname,
        "packages/fast-fs-hash/src/file-hash-cache-format.ts"
      ),
      "fast-fs-hash": path.resolve(import.meta.dirname, "packages/fast-fs-hash/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    watch: false,
    pool: "threads",
    benchmark: {
      include: ["test/**/*.bench.ts"],
    },
  },
});
