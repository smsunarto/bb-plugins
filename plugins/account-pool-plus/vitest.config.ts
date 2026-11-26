import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  define: { __BB_PLUGIN_ID__: JSON.stringify("account-pool-plus") },
  test: {
    silent: "passed-only",
    name: "bb-plugin-account-pool-plus",
    include: ["src/**/*.test.{ts,tsx}", "*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    globalSetup: ["../../scripts/test-tmp-root.mjs"],
  },
});
