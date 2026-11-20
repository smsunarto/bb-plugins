import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "t3-composer",
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./test-setup.ts"],
    globalSetup: ["../../scripts/test-tmp-root.mjs"],
    exclude: ["node_modules/**"],
  },
});
