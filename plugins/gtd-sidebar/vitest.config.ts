import { defineConfig } from "vitest/config";

// The forked Thread list's component tests (app/**) run under vitest and
// jsdom, as they do in bb. GTD's model, server and host tests in test/ keep
// running under bun and node (see the package's test script).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "gtd-sidebar",
    include: ["app/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
