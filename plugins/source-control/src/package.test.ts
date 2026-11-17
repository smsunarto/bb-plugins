import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("the plugin imports only the public Plugin SDK, zod, Node, Pierre, sonner, Effect and its instructions on the server, smol-toml on the host and its own files", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const scan = await experimental_scanPublicSdkOnly(root, {
    // A public SDK subpath the scanner does not list by default; gitbutler and code-review use it too.
    allow: [
      /^@get-bb\/plugin-sdk\/process$/,
      /^vitest(\/config)?$/,
      /^@testing-library\//,
      // Parses the built stylesheet in css.test.ts.
      /^lightningcss$/,
      // Renders the rewritten pull request text as Markdown in guided.test.tsx.
      /^markdown-it$/,
      /^react(\/jsx-runtime)?$/,
      // The vendored responsive overlay flushes a sync render; bb provides react-dom.
      /^react-dom$/,
      // bb's runtime provides Pierre's diff renderer to plugin apps, as for gitbutler.
      /^@pierre\/diffs(\/react)?$/,
      // bb's runtime shims sonner to its own toaster: the merge toast.
      /^sonner$/,
      // The server's Effect runtime; layering.test.ts keeps both out of every other layer.
      /^effect$/,
      /^@bb-plugins\/effect-bridge$/,
      // The review prompts and the findings tool's text, read from instructions/ on the server.
      /^@bb-plugins\/instructions$/,
      // Other plugins' asks to open a pull request's Review (pr-links.ts).
      /^@bb-plugins\/review-request(\/pull-request-url)?$/,
      // GitButler's branch metadata, read on the host.
      /^smol-toml$/,
      // Review playbooks' frontmatter, read by `bb review playbook` on the server.
      /^yaml$/,
      // The review page's list window.
      /^@tanstack\/virtual-core$/,
      // shadcn components in src/app/components/ui: Radix primitives and their class helpers.
      /^@radix-ui\/react-(avatar|checkbox|collapsible|dialog|dropdown-menu|label|popover|select|slot|tabs|toggle|toggle-group|tooltip)$/,
      // The shared Button, Badge, Input, Textarea, surface edges and cn, re-exported from components/ui.
      /^@bb-plugins\/ui\/(badge|button|input|motion|sidebar-fill|surface|textarea|utils)$/,
      /^class-variance-authority$/,
      /^clsx$/,
      /^tailwind-merge$/,
    ],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
