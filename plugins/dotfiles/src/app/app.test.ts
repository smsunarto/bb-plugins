import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-kit/core/testing";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

// The DOM must exist BEFORE the SDK's render harness is evaluated,
// so the import is dynamic and comes after installDom().
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent } = await import("@testing-library/react");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");

afterEach(() => pluginQueryClient.clear());

type CapturedApp = Awaited<ReturnType<typeof loadPluginApp>>;

/** A fixed tab bb shows beside the Dotfiles page, ready for `renderSlot`. */
function fixedTab(captured: CapturedApp, id: string) {
  const tab = captured.tabs.find(
    (candidate) =>
      candidate.id === id &&
      candidate.availability === "fixed" &&
      candidate.context.kind === "nav-panel" &&
      candidate.context.panelId === "dotfiles",
  );
  assert.ok(tab, `the ${id} tab is registered`);
  return { component: tab.component as ComponentType<PluginNavPanelProps> };
}

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

test("the nav panel keeps the dotfiles route and registers its fixed tabs", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  // Route lock: scripts/plugin-screenshot-fixtures.ts pins route "dotfiles/dotfiles".
  assert.equal(panel.id, "dotfiles");
  assert.equal(panel.path, "dotfiles");
  assert.equal(panel.fixedTabs, undefined);
  // Saved panel layouts find each tab by panel id and tab id.
  assert.deepEqual(
    captured.tabs.map(({ id, title, context, availability, layout }) => ({
      id,
      title,
      context,
      availability,
      layout,
    })),
    [
      {
        id: "files",
        title: "Files",
        context: { kind: "nav-panel", panelId: "dotfiles" },
        availability: "fixed",
        layout: "flush",
      },
      {
        id: "workflows",
        title: "Workflows",
        context: { kind: "nav-panel", panelId: "dotfiles" },
        availability: "fixed",
        layout: "flush",
      },
      {
        id: "tasks",
        title: "Tasks",
        context: { kind: "nav-panel", panelId: "dotfiles" },
        availability: "fixed",
        layout: "flush",
      },
    ],
  );
});

test("the files tab reads the picked machine and names it beside the repo path", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const filesTab = fixedTab(captured, "files");
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
  const filesTab = fixedTab(captured, "files");
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
  const filesTab = fixedTab(captured, "files");
  const slot = renderSlot(filesTab, { subPath: "" }, { rpc: server("host_mac", false) });

  await slot.findByText("Local Mac is not connected.");
  slot.unmount();
});

test("the page prompts for a selection at the panel root", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: server("host_server") });
  await slot.findByText("Select a file in the Files or Workflows tab.");
  slot.unmount();
});

test("workflows open their source on the picked machine and stay out of Files", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const workflowPath =
    ".dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks/feature.md";
  const backend = server("host_mac");
  const rpc = {
    ...backend,
    overview: async (input: unknown) => ({
      ...(await backend.overview(input)),
      groups: [
        {
          id: "agents",
          title: "Agent config",
          files: [{ path: ".dotfiles/mcp.json", title: "MCP servers", exists: true, dirty: false }],
        },
        {
          id: "workflows",
          title: "Engineering workflows",
          files: [{ path: workflowPath, title: "Feature", exists: true, dirty: true }],
        },
      ],
    }),
  };
  const workflows = renderSlot(fixedTab(captured, "workflows"), { subPath: "" }, { rpc });
  await workflows.findByText(/After saving, run Refresh agent skills/);
  fireEvent.click(await workflows.findByRole("button", { name: /^Feature/ }));
  assert.ok(workflows.navigateCalls.some((call) => JSON.stringify(call).includes(workflowPath)));
  assert.equal(workflows.queryByRole("button", { name: "MCP servers" }), null);
  assert.deepEqual(workflows.rpcCalls.find((call) => call.method === "overview")?.input, {
    hostId: "host_mac",
  });
  workflows.unmount();

  const files = renderSlot(fixedTab(captured, "files"), { subPath: "" }, { rpc });
  await files.findByRole("button", { name: "MCP servers" });
  assert.equal(files.queryByRole("button", { name: /^Feature/ }), null);
  files.unmount();
});

test("review editing remains reachable when the dotfiles machine is offline", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSlot(
    fixedTab(captured, "workflows"),
    { subPath: "" },
    { rpc: server("host_mac", false) },
  );
  await slot.findByText("Local Mac is not connected.");
  assert.equal(
    slot.getByRole("link", { name: /Review workflow/ }).getAttribute("href"),
    "/plugins/prompt-editor/prompt-editor/code-review/file/skills/review/SKILL.md",
  );
  slot.unmount();
});

test("the refresh action targets the machine selected in Dotfiles", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSlot(
    fixedTab(captured, "tasks"),
    { subPath: "" },
    {
      rpc: {
        ...server("host_mac"),
        runTask: async () => ({ exitCode: 0, output: "Copies match sources" }),
      },
    },
  );
  await slot.findByText("Runs on Local Mac");
  fireEvent.click(slot.getByRole("button", { name: "Refresh agent skills" }));
  await slot.findByText("Copies match sources");
  assert.deepEqual(slot.rpcCalls.find((call) => call.method === "runTask")?.input, {
    hostId: "host_mac",
    task: "install:agent-plugins",
  });
  slot.unmount();
});
