import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "fast-fs-hash": path.resolve(import.meta.dirname, "packages/fast-fs-hash/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.bench.ts"],
    watch: false,
  },
});
