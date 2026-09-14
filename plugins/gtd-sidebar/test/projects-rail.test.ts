import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it, mock } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Initiative } from "../lib/initiative-types.ts";
import type { RowCommand } from "../components/inbox/thread-actions.ts";

if (process.env.GTD_PROJECTS_RAIL_TEST_CHILD !== "1") {
  it("Projects rail passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_PROJECTS_RAIL_TEST_CHILD: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string },
    ) => {
      window: Window & typeof globalThis;
    };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis && name !== "Event" && name !== "CustomEvent") continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: Reflect.get(dom.window, name),
      writable: true,
    });
  }
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  const { cleanup, fireEvent, within } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();

  const initiative: Initiative = {
    id: "project-one",
    name: "Project One",
    icon: "folder",
    description: "",
    coordinatorThreadId: "coordinator",
    workspaceProjectIds: ["repo-one"],
    workspace: { mode: "legacy" },
    primaryEnvironmentId: null,
    providerId: "codex",
    model: null,
    reasoningLevel: null,
    createdAt: 100,
    updatedAt: 100,
    archivedAt: null,
  };
  const initiatives = {
    status: "ready" as const,
    active: [initiative],
    archived: [],
    byId: new Map([[initiative.id, initiative]]),
    byCoordinator: new Map([[initiative.coordinatorThreadId, initiative]]),
    retry: mock(() => {}),
  };
  mock.module("../hooks/use-initiatives.ts", () => ({ useInitiatives: () => initiatives }));

  const { ProjectsRail } = await import("../components/projects/rail.tsx");

  function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
    return {
      id,
      projectId: "repo-one",
      title: id,
      titleFallback: null,
      parentThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "codex",
      hasPendingInteraction: false,
      activity: {
        workflows: 0,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
      indicator: "none",
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: null,
      host: null,
      createdAt: 100,
      updatedAt: 100,
      lastReadAt: 100,
      latestAttentionAt: Date.now(),
      ...overrides,
    };
  }

  const threads = [
    thread("coordinator", {
      title: "Project coordinator",
      indicator: "waiting-for-input",
      indicatorLabel: "Coordinator needs input",
    }),
    thread("agent-a", {
      title: "Working agent",
      parentThreadId: "coordinator",
      indicator: "runtime",
      indicatorLabel: "Agent working",
      createdAt: 200,
    }),
    thread("agent-child", {
      title: "Nested agent",
      parentThreadId: "agent-a",
      isUnread: true,
      createdAt: 300,
    }),
    thread("agent-b", {
      title: "Review agent",
      parentThreadId: "coordinator",
      createdAt: 400,
    }),
  ];

  function mount(isCompactViewport = false, collapsedThreads: ReadonlySet<string> = new Set()) {
    const command = mock((_command: RowCommand) => {});
    const toggleThread = mock((_threadId: string) => {});
    const slot = renderSlot(
      { component: ProjectsRail },
      {
        activeThreadId: "agent-a",
        isCompactViewport,
        threads,
        onNavigate: mock(() => {}),
        command,
        canPark: () => true,
        collapsedThreads,
        toggleThread,
      },
      {
        settings: { showProviderIcon: true, compactThreads: false },
        providers: {
          status: "ready",
          providers: [{ id: "codex", displayName: "Codex", logoUrl: null }] as never,
        },
      },
    );
    return { slot, command, toggleThread };
  }

  function shortcutIds(container: HTMLElement): string[] {
    return Array.from(
      container.querySelectorAll("[data-sidebar-thread-shortcut-target][data-sidebar-thread-id]"),
      (element) => element.getAttribute("data-sidebar-thread-id")!,
    );
  }

  afterEach(() => cleanup());
  afterAll(() => dom.window.close());

  describe("ProjectsRail", () => {
    it("renders Project agents through the actual nested ThreadCard presentation", async () => {
      const { slot, command } = mount();
      assert.deepEqual(shortcutIds(slot.container), [
        "coordinator",
        "agent-a",
        "agent-child",
        "agent-b",
      ]);
      assert.equal(new Set(shortcutIds(slot.container)).size, 4);
      assert.equal(slot.getAllByRole("button", { name: "New project" }).length, 1);
      assert.equal(slot.queryByText("New project"), null);
      assert.equal(slot.container.querySelector("[data-project-agent-row]"), null);

      const coordinator = slot.container.querySelector<HTMLElement>(
        '[data-sidebar-thread-id="coordinator"]',
      );
      const agentAnchor = slot.getByRole("link", { name: "Working agent" });
      const nestedAnchor = slot.getByRole("link", { name: "Nested agent" });
      const agent = agentAnchor.closest<HTMLElement>(".gtd-thread-row");
      const nested = nestedAnchor.closest<HTMLElement>(".gtd-thread-row");
      assert.ok(coordinator);
      assert.ok(agent);
      assert.ok(nested);
      assert.ok(agent.classList.contains("gtd-thread-row"));
      assert.ok(agent.classList.contains("gtd-compact-row"));
      assert.equal(agent.style.getPropertyValue("--gtd-depth"), "1");
      assert.equal(nested.style.getPropertyValue("--gtd-depth"), "2");
      assert.ok(agent.querySelector(".gtd-tree-elbow"));
      assert.ok(nested.querySelector(".gtd-tree-elbow"));
      assert.ok(nested.querySelector(".gtd-tree-line"));
      assert.ok(within(coordinator.parentElement!).getByLabelText("Coordinator needs input"));
      assert.ok(within(agent).getByLabelText("Agent working"));
      assert.ok(within(nested).getByLabelText("Unread response"));

      fireEvent.focus(agentAnchor);
      const tooltip = await slot.findByRole("tooltip");
      assert.match(tooltip.textContent ?? "", /Project One/);
      assert.match(tooltip.textContent ?? "", /Child of Project coordinator/);
      assert.match(tooltip.textContent ?? "", /Codex/);

      fireEvent.click(agentAnchor, { metaKey: true });
      assert.deepEqual(command.mock.calls.at(-1)?.[0], {
        kind: "open",
        threadId: "agent-a",
        shelf: "waiting",
        split: true,
      });
      fireEvent.click(agentAnchor, { button: 2 });
      assert.equal(command.mock.calls.length, 1);

      fireEvent.click(within(agent).getByRole("button", { name: "Settle" }));
      assert.deepEqual(command.mock.calls.at(-1)?.[0], {
        kind: "settle",
        threadId: "agent-a",
      });
    });

    it("keeps recursive agents under Project and shares subthread collapse state", () => {
      const open = mount();
      const { slot } = open;
      fireEvent.click(slot.getByRole("button", { name: "Collapse Project One" }));
      assert.deepEqual(shortcutIds(slot.container), ["coordinator"]);
      fireEvent.click(slot.getByRole("button", { name: "Expand Project One" }));
      assert.deepEqual(shortcutIds(slot.container), [
        "coordinator",
        "agent-a",
        "agent-child",
        "agent-b",
      ]);
      slot.lifecycle.unmount();

      const folded = mount(false, new Set(["agent-a"]));
      assert.deepEqual(shortcutIds(folded.slot.container), ["coordinator", "agent-a", "agent-b"]);
      const foldedAgent = folded.slot
        .getByRole("link", { name: "Working agent" })
        .closest<HTMLElement>(".gtd-thread-row");
      assert.ok(foldedAgent);
      assert.ok(within(foldedAgent).getByLabelText("Unread response"));
      fireEvent.click(
        folded.slot.getByRole("button", { name: "Expand children of Working agent" }),
      );
      assert.deepEqual(folded.toggleThread.mock.calls.at(-1)?.[0], "agent-a");
    });

    it("keeps native tree keyboard navigation scoped to one Project", () => {
      const { slot } = mount();
      const coordinator = slot.getByRole("link", { name: "Project One" });
      const agent = slot.getByRole("link", { name: "Working agent" });
      const nested = slot.getByRole("link", { name: "Nested agent" });
      const directLeaf = slot.getByRole("link", { name: "Review agent" });

      fireEvent.focus(agent);
      fireEvent.keyDown(agent, { key: "ArrowRight" });
      assert.equal(document.activeElement, nested);

      fireEvent.keyDown(nested, { key: "ArrowLeft" });
      assert.equal(document.activeElement, agent);

      fireEvent.focus(directLeaf);
      fireEvent.keyDown(directLeaf, { key: "ArrowLeft" });
      assert.equal(document.activeElement, coordinator);
    });

    it("uses ThreadCard mobile signals without desktop-only chrome", () => {
      const { slot } = mount(true);
      const agent = slot.getByRole("link", { name: "Working agent" }).closest("li")
        ?.firstElementChild as HTMLElement | null;
      assert.ok(agent);
      assert.ok(agent.classList.contains("min-h-10"));
      assert.ok(agent.querySelector(".gtd-mobile-title"));
      assert.equal(agent.classList.contains("gtd-thread-row"), false);
      assert.ok(within(agent).getByLabelText("Agent working"));
      assert.deepEqual(shortcutIds(slot.container), [
        "coordinator",
        "agent-a",
        "agent-child",
        "agent-b",
      ]);
    });
  });
}
