import { defineConfig } from "vitest/config";

// Only the bots tests, forked from Bots Sidebar, run under vitest; the rest of
// GTD Sidebar's tests run under bun and node (see package.json).
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    include: ["test/bots/**/*.test.ts", "test/bots/**/*.test.tsx"],
    restoreMocks: true,
    // The SDK harness uses durable SQLite and filesystem exports.
    maxWorkers: 4,
    testTimeout: 20_000,
  },
});
