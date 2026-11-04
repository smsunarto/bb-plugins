import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-plugins/testing";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

// The DOM must exist BEFORE the SDK's render harness is evaluated,
// so the import is dynamic and comes after installDom().
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent } = await import("@testing-library/react");
const { queryClient } = await import("./query.ts");

afterEach(() => queryClient.clear());

type CapturedApp = Awaited<ReturnType<typeof loadPluginApp>>;

/** The left sidebar bb shows beside the Dotfiles page, ready for `renderSlot`. */
function sidebar(captured: CapturedApp) {
  const component = captured.navPanels[0]?.experimental_sidebar;
  assert.ok(component, "the Dotfiles page registers a sidebar");
  return { component: component as ComponentType<PluginNavPanelProps> };
}

/** Render the sidebar with one section picked, as a reader clicking its switcher would. */
function renderSection(
  captured: CapturedApp,
  section: "Files" | "Workflows" | "Tasks",
  props: PluginNavPanelProps,
  options: Parameters<typeof renderSlot>[2],
) {
  const slot = renderSlot(sidebar(captured), props, options);
  fireEvent.click(slot.getByRole("button", { name: section }));
  return slot;
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
        branch: "main",
        groups: [],
        gitEntries: [],
      };
    },
  };
}

test("the nav panel keeps the dotfiles route and puts its sections in the left sidebar", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  // Route lock: scripts/plugin-screenshot-fixtures.ts pins route "dotfiles/dotfiles".
  assert.equal(panel.id, "dotfiles");
  assert.equal(panel.path, "dotfiles");
  assert.equal(panel.fixedTabs, undefined);
  assert.equal(typeof panel.experimental_sidebar, "function");
  assert.deepEqual(captured.tabs, []);
});

test("the sidebar remembers the picked section", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  window.localStorage.clear();
  const first = renderSection(captured, "Tasks", { subPath: "" }, { rpc: server("host_mac") });
  assert.equal(first.getByRole("button", { name: "Tasks" }).getAttribute("aria-pressed"), "true");
  first.unmount();

  const again = renderSlot(sidebar(captured), { subPath: "" }, { rpc: server("host_mac") });
  assert.equal(again.getByRole("button", { name: "Tasks" }).getAttribute("aria-pressed"), "true");
  assert.equal(again.getByRole("button", { name: "Files" }).getAttribute("aria-pressed"), "false");
  again.unmount();
  window.localStorage.clear();
});

test("the Files section reads the picked machine and names it beside the repo path", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSection(captured, "Files", { subPath: "" }, { rpc: server("host_mac") });

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
  const slot = renderSection(captured, "Files", { subPath: "" }, { rpc: server("host_server") });
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
  const slot = renderSection(
    captured,
    "Files",
    { subPath: "" },
    { rpc: server("host_mac", false) },
  );

  await slot.findByText("Local Mac is not connected.");
  slot.unmount();
});

test("a machine without a repository is named instead of drawing a branch", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const rpc = {
    ...server("host_mac"),
    overview: async () => ({
      state: "noRepository" as const,
      host: { id: "host_mac", name: "Local Mac" },
      repoPath: "/Users/example/git/dotfiles",
    }),
  };

  const files = renderSection(captured, "Files", { subPath: "" }, { rpc });
  await files.findByText("No dotfiles repository at /Users/example/git/dotfiles.");
  assert.equal(files.queryByText("clean"), null);
  assert.equal(files.queryByText("missing"), null);
  files.unmount();

  const panel = captured.navPanels[0];
  assert.ok(panel?.headerContent, "the page registers a status badge");
  const badge = renderSlot(
    { component: panel.headerContent as ComponentType<PluginNavPanelProps> },
    { subPath: "" },
    { rpc },
  );
  await badge.findByText("Local Mac · no repository");
  badge.unmount();
});

test("the page prompts for a selection at the panel root", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const panel = captured.navPanels[0];
  assert.ok(panel, "app.tsx registers one nav panel");
  const slot = renderSlot(panel, { subPath: "" }, { rpc: server("host_server") });
  await slot.findByText("Select a file in the sidebar's Files or Workflows section.");
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
  const workflows = renderSection(captured, "Workflows", { subPath: "" }, { rpc });
  await workflows.findByText(/After saving, run Refresh agent skills/);
  const workflow = await workflows.findByRole("link", { name: /^Feature/ });
  assert.ok(workflow.getAttribute("href")?.includes("/global/at/host_mac/"));
  assert.ok(workflow.getAttribute("href")?.endsWith(workflowPath));
  assert.equal(workflows.queryByRole("button", { name: "MCP servers" }), null);
  assert.deepEqual(workflows.rpcCalls.find((call) => call.method === "overview")?.input, {
    hostId: "host_mac",
  });
  workflows.unmount();

  const files = renderSection(captured, "Files", { subPath: "" }, { rpc });
  await files.findByRole("button", { name: "MCP servers" });
  assert.equal(files.queryByRole("button", { name: /^Feature/ }), null);
  files.unmount();
});

test("review editing remains reachable when the dotfiles machine is offline", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSection(
    captured,
    "Workflows",
    { subPath: "" },
    { rpc: server("host_mac", false) },
  );
  await slot.findByText("Local Mac is not connected.");
  assert.equal(
    slot.getByRole("link", { name: /Review workflow/ }).getAttribute("href"),
    "/plugins/agent-instructions/instructions/prompts/code-review/file/skills/request-review/SKILL.md",
  );
  slot.unmount();
});

test("the refresh action targets the machine selected in Dotfiles", async () => {
  const captured = await loadPluginApp(() => import("./app.tsx"));
  const slot = renderSection(
    captured,
    "Tasks",
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
