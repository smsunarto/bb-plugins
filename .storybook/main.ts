import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "@storybook/react-vite";

const config = {
  framework: "@storybook/react-vite",
  stories: ["../{plugins,packages}/**/storybook/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-vitest", "@storybook/addon-mcp"],
  features: {
    componentsManifest: true,
  },
  viteFinal(config) {
    config.resolve = {
      ...config.resolve,
      dedupe: ["react", "react-dom", "@tanstack/react-query", "@get-bb/plugin-sdk"],
    };
    config.plugins = [
      ...(config.plugins ?? []),
      tailwindcss(),
      {
        name: "plugin-local-aliases",
        enforce: "pre",
        resolveId(source, importer) {
          if (!source.startsWith("@/") || !importer) return null;
          const match = importer.match(/(.*\/plugins\/[^/]+)\//);
          const root = match?.[1];
          if (!root) return null;
          const tsconfig = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
          const pattern = tsconfig.compilerOptions?.paths?.["@/*"]?.[0] ?? "./*";
          return this.resolve(resolve(root, pattern.replace("*", source.slice(2))), importer, {
            skipSelf: true,
          });
        },
      },
    ];
    // The public SDK test harness uses React.act in static previews too.
    config.define = { ...config.define, "process.env.NODE_ENV": JSON.stringify("development") };
    // The preview lives in a workspace package; prebundle its React runtime.
    config.optimizeDeps = {
      ...config.optimizeDeps,
      entries: [resolve(import.meta.dirname, "../plugins/*/storybook/*.stories.tsx")],
      include: [
        ...(config.optimizeDeps?.include ?? []),
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        // Lazy registered panels must not trigger an optimizer reload mid-test.
        "@pierre/diffs/react",
        "@radix-ui/react-tabs",
        "vaul",
        "@dagrejs/dagre",
        "@get-bb/plugin-sdk",
        "@xyflow/react",
        "cmdk",
        "@tiptap/extension-bubble-menu",
        "@tiptap/suggestion",
        "mediabunny",
        "three",
        "three/addons/controls/OrbitControls.js",
        "three/addons/environments/RoomEnvironment.js",
        "three/addons/libs/meshopt_decoder.module.js",
        "three/addons/loaders/GLTFLoader.js",
      ],
    };
    return config;
  },
} satisfies StorybookConfig;

export default config;
