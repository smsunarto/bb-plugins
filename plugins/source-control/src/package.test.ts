import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("the plugin imports only the public Plugin SDK, zod, Node, Pierre, Effect on the server, smol-toml on the host and its own files", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scan = await experimental_scanPublicSdkOnly(root, {
    // A public SDK subpath the scanner does not list by default; gitbutler and code-review use it too.
    allow: [
      /^@get-bb\/plugin-sdk\/process$/,
      /^vitest(\/config)?$/,
      /^@testing-library\//,
      // Parses the built stylesheet in css.test.ts.
      /^lightningcss$/,
      /^react$/,
      // bb's runtime provides Pierre's diff renderer to plugin apps, as for gitbutler.
      /^@pierre\/diffs(\/react)?$/,
      // The server's Effect runtime; layering.test.ts keeps both out of every other layer.
      /^effect$/,
      /^@bb-plugins\/effect-bridge$/,
      // GitButler's branch metadata, read on the host.
      /^smol-toml$/,
    ],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
