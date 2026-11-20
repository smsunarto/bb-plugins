import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["*.test.ts"], globalSetup: ["../../scripts/test-tmp-root.mjs"] },
});
