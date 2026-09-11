import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-docs",
    testTimeout: 15_000,
    setupFiles: ["./vitest.setup-require.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
