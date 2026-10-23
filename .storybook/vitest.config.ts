import { coverageConfigDefaults, defineConfig } from "vitest/config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [
    storybookTest({ configDir: import.meta.dirname, storybookUrl: "http://localhost:6010" }),
  ],
  test: {
    name: "storybook",
    coverage: {
      // Vite JSON module URLs are data, not instrumentable JavaScript.
      exclude: [...coverageConfigDefaults.exclude, "**/*.json", "**/*.json?*"],
    },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
