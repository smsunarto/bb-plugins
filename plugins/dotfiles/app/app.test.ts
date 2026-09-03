import { afterEach, beforeEach, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import type * as MonacoNs from "monaco-editor";

// The DOM must exist BEFORE the SDK's render harness is evaluated,
// so the import is dynamic and comes after installDom().
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { waitFor } = await import("@testing-library/react");
const { monacoRuntime } = await import("./monaco/runtime.ts");

const overviewStub = {
  overview: async () => ({
    repoPath: "/dotfiles",
    repoExists: true,
    branch: "main",
    groups: [],
    gitEntries: [],
  }),
};

// The panel prewarms Monaco on mount. Stub the runtime so no test reaches for
// the real editor assets.
let release = mock<() => void>();
let acquire = spyOn(monacoRuntime, "acquire");

beforeEach(() => {
  release = mock<() => void>();
  acquire = spyOn(monacoRuntime, "acquire").mockResolvedValue({
    monaco: {} as typeof MonacoNs,
    release,
  });
});

afterEach(() => {
  acquire.mockRestore();
});

test("the nav panel keeps the dotfiles route and registers both fixed tabs", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  // Route lock: scripts/plugin-screenshot-fixtures.ts pins route "dotfiles/dotfiles".
  assert.equal(panel.id, "dotfiles");
  assert.equal(panel.path, "dotfiles");
  assert.deepEqual(
    panel.fixedTabs?.map((tab) => ({ panelId: tab.panelId, id: tab.id })),
    [
      { panelId: "dotfiles", id: "files" },
      { panelId: "dotfiles", id: "tasks" },
    ],
  );
});

test("the files tab renders the overview", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const filesTab = captured.navPanels[0]?.fixedTabs?.[0];
  assert.ok(filesTab, "the files tab is registered");
  const slot = renderSlot(filesTab, { subPath: "" }, { rpc: overviewStub });
  await slot.findByText("/dotfiles");
  slot.unmount();
});

test("the page prompts for a selection at the panel root", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: overviewStub });
  await slot.findByText("Select a file in the Files tab.");
  slot.unmount();
});

test("the panel prewarms the editor runtime before a file is selected", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: overviewStub });

  await slot.findByText("Select a file in the Files tab.");
  await waitFor(() => assert.equal(acquire.mock.calls.length, 1));
  slot.unmount();

  assert.equal(release.mock.calls.length, 1);
});
