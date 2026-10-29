import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The frontend imports through the tsconfig's `@/` alias.
  resolve: { alias: { "@": dirname(fileURLToPath(import.meta.url)) } },
  test: { include: ["lib/**/*.test.ts", "test/**/*.test.ts", "app.test.tsx"] },
});
