import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // As `bb plugin build` defines it: the shadcn overlays name their portal roots for the plugin.
  define: { __BB_PLUGIN_ID__: JSON.stringify("source-control") },
  test: {
    silent: "passed-only",
    name: "bb-plugin-source-control",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
