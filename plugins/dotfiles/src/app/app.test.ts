import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";

// The DOM must exist BEFORE the SDK's render harness is evaluated,
// so the import is dynamic and comes after installDom().
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent } = await import("@testing-library/react");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");

afterEach(() => pluginQueryClient.clear());

const names: Record<string, string> = {
  host_server: "linux-builder",
  host_mac: "Local Mac",
};

/** A server whose panel machine starts as `selected` and moves when the picker stores another. */
function server(selected: string, connected = true) {
  let current = selected;
  return {
    hosts: async () => ({
      selectedHostId: current,
      hosts: Object.entries(names).map(([id, name]) => ({ id, name, connected })),
    }),
    selectHost: async (input: unknown) => {
      current = (input as { hostId: string }).hostId;
      return { selectedHostId: current };
    },
    overview: async (input: unknown) => {
      const { hostId } = input as { hostId?: string };
      const host = { id: hostId ?? "host_server", name: names[hostId ?? "host_server"] ?? "?" };
      if (!connected) return { state: "offline" as const, host };
      return {
        state: "ready" as const,
        host,
        repoPath:
          hostId === "host_mac" ? "/Users/example/git/dotfiles" : "/home/codex/git/dotfiles",
        repoExists: true,
        branch: "main",
        groups: [],
        gitEntries: [],
      };
    },
  };
}

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

test("the files tab reads the picked machine and names it beside the repo path", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const filesTab = captured.navPanels[0]?.fixedTabs?.[0];
  assert.ok(filesTab, "the files tab is registered");
  const slot = renderSlot(filesTab, { subPath: "" }, { rpc: server("host_mac") });

  await slot.findByText("/Users/example/git/dotfiles");
  const picker = slot.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
  assert.equal(picker.selectedOptions[0]?.textContent, "Local Mac");
  assert.deepEqual(
    slot.rpcCalls.filter((call) => call.method === "overview").map((call) => call.input),
    [{ hostId: "host_mac" }],
  );
  slot.unmount();
});

test("picking another machine stores it and reloads the file list from there", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const filesTab = captured.navPanels[0]?.fixedTabs?.[0];
  assert.ok(filesTab, "the files tab is registered");
  const slot = renderSlot(filesTab, { subPath: "" }, { rpc: server("host_server") });
  await slot.findByText("/home/codex/git/dotfiles");

  fireEvent.change(slot.getByRole("combobox", { name: "Machine" }), {
    target: { value: "host_mac" },
  });

  await slot.findByText("/Users/example/git/dotfiles");
  assert.deepEqual(
    slot.rpcCalls.filter((call) => call.method === "selectHost").map((call) => call.input),
    [{ hostId: "host_mac" }],
  );
  slot.unmount();
});

test("an offline machine is named instead of showing an empty file list", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const filesTab = captured.navPanels[0]?.fixedTabs?.[0];
  assert.ok(filesTab, "the files tab is registered");
  const slot = renderSlot(filesTab, { subPath: "" }, { rpc: server("host_mac", false) });

  await slot.findByText("Local Mac is not connected.");
  slot.unmount();
});

test("the page prompts for a selection at the panel root", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: server("host_server") });
  await slot.findByText("Select a file in the Files tab.");
  slot.unmount();
});
