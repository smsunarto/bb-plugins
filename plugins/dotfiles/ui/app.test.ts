import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";

// The DOM must exist BEFORE the SDK's render harness is evaluated,
// so the import is dynamic and comes after installDom().
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

test("the nav panel keeps the dotfiles route and renders the overview", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  // Route lock: scripts/plugin-screenshot-fixtures.ts pins route "dotfiles/dotfiles".
  assert.equal(panel.id, "dotfiles");
  assert.equal(panel.path, "dotfiles");
  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        dotfiles_overview: async () => ({
          repoPath: "/dotfiles",
          repoExists: true,
          branch: "main",
          groups: [],
          gitEntries: [],
        }),
      },
    },
  );
  await slot.findByText("/dotfiles");
  slot.unmount();
});
