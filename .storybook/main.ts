import type { StorybookConfig } from "@storybook/react-vite";

const config = {
  framework: "@storybook/react-vite",
  stories: ["../{plugins,packages}/**/storybook/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: ["@storybook/addon-mcp"],
  features: {
    componentsManifest: true,
  },
  viteFinal(config) {
    // The preview lives in a workspace package; prebundle its React runtime.
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [
        ...(config.optimizeDeps?.include ?? []),
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    };
    return config;
  },
} satisfies StorybookConfig;

export default config;
