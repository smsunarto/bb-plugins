import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "bb-plugin-whiteboard",
    silent: "passed-only",
    environment: "node",
    // Upstream review/vitest.config.ts: one scratch home per run, and an empty
    // GITHUB_REPOSITORY so scratch repositories resolve their own remotes.
    env: {
      DEV_REVIEW_HOME: path.join(os.tmpdir(), `whiteboard-tests-${process.pid}`),
      GITHUB_REPOSITORY: "",
    },
    // Vendored engine specs open `node:sqlite` databases and call local git
    // the way upstream did. These wire both to the real implementations.
    setupFiles: [
      "src/server/lib/host-io/testing/vitest-setup.ts",
      "src/server/lib/sqlite-testing.ts",
    ],
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**", "**/*.browser.test.{ts,tsx}"],
  },
});
