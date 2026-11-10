import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("the plugin imports only the public Plugin SDK, zod, Node and its own files", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scan = await experimental_scanPublicSdkOnly(root, {
    // A public SDK subpath the scanner does not list by default; gitbutler and code-review use it too.
    allow: [
      /^@get-bb\/plugin-sdk\/process$/,
      /^vitest(\/config)?$/,
      /^@testing-library\//,
      /^react$/,
    ],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
