import { defineConfig } from "vitest/config";

// The bots tests, forked from Bots Sidebar, run under vitest.
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    restoreMocks: true,
    // The SDK harness uses durable SQLite and filesystem exports.
    maxWorkers: 4,
    testTimeout: 20_000,
  },
});
