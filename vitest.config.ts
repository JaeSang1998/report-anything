import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@report-anything/core": src("core"),
      "@report-anything/react": src("react"),
    },
  },
  test: { include: ["packages/*/src/**/*.test.{ts,tsx}"] },
});
