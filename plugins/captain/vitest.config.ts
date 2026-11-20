import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // As `bb plugin build` defines it.
  define: { __BB_PLUGIN_ID__: JSON.stringify("captain") },
  test: {
    silent: "passed-only",
    name: "bb-plugin-captain",
    include: ["src/**/*.test.{ts,tsx}"],
    globalSetup: ["../../scripts/test-tmp-root.mjs"],
    exclude: ["node_modules/**"],
  },
});
