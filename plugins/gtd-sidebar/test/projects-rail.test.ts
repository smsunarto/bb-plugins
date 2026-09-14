import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it, mock } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Initiative } from "../lib/initiative-types.ts";

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
  ];

  function mount(isCompactViewport = false) {
    return renderSlot(
      { component: ProjectsRail },
      {
        activeThreadId: "agent-a",
        isCompactViewport,
        threads,
        onNavigate: mock(() => {}),
      },
      {
        settings: { showProviderIcon: true },
        providers: {
          status: "ready",
          providers: [{ id: "codex", displayName: "Codex", logoUrl: null }] as never,
        },
      },
    );
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
    it("reuses GTD status, details, provider, spacing, and navigation contracts", async () => {
      const slot = mount();
      assert.deepEqual(shortcutIds(slot.container), ["coordinator", "agent-a", "agent-child"]);
      assert.equal(new Set(shortcutIds(slot.container)).size, 3);

      const coordinator = slot.container.querySelector<HTMLElement>(
        '[data-sidebar-thread-id="coordinator"]',
      );
      const agent = slot.container.querySelector<HTMLElement>('[data-project-agent-row="agent-a"]');
      const nested = slot.container.querySelector<HTMLElement>(
        '[data-project-agent-row="agent-child"]',
      );
      assert.ok(coordinator);
      assert.ok(agent);
      assert.ok(nested);
      assert.ok(agent.classList.contains("gtd-thread-row"));
      assert.ok(agent.classList.contains("gtd-compact-row"));
      assert.equal(agent.style.paddingLeft, "28px");
      assert.equal(nested.style.paddingLeft, "42px");
      assert.ok(within(coordinator.parentElement!).getByLabelText("Coordinator needs input"));
      assert.ok(within(agent).getByLabelText("Agent working"));
      assert.ok(within(nested).getByLabelText("Unread response"));
      assert.ok(within(agent).getByLabelText("Codex"));

      const agentAnchor = within(agent).getByRole("link", { name: "Working agent" });
      fireEvent.focus(agentAnchor);
      const tooltip = await slot.findByRole("tooltip");
      assert.match(tooltip.textContent ?? "", /Project One/);
      assert.match(tooltip.textContent ?? "", /Child of Project coordinator/);
      assert.match(tooltip.textContent ?? "", /Codex/);

      fireEvent.click(agentAnchor, { metaKey: true });
      assert.deepEqual(slot.inspection.sidebarActionCalls.at(-1), {
        method: "open",
        threadId: "agent-a",
        options: { split: true },
      });
      fireEvent.click(agentAnchor, { button: 2 });
      assert.equal(slot.inspection.sidebarActionCalls.length, 1);
    });

    it("keeps recursive agents under the Project fold with one anchor each", () => {
      const slot = mount();
      fireEvent.click(slot.getByRole("button", { name: "Collapse Project One" }));
      assert.deepEqual(shortcutIds(slot.container), ["coordinator"]);
      fireEvent.click(slot.getByRole("button", { name: "Expand Project One" }));
      assert.deepEqual(shortcutIds(slot.container), ["coordinator", "agent-a", "agent-child"]);
    });

    it("uses the shared compact-row sizing without desktop-only details", () => {
      const slot = mount(true);
      const agent = slot.container.querySelector<HTMLElement>('[data-project-agent-row="agent-a"]');
      assert.ok(agent);
      assert.ok(agent.classList.contains("h-11"));
      assert.ok(agent.querySelector(".gtd-mobile-title"));
      assert.equal(agent.classList.contains("gtd-thread-row"), false);
      assert.deepEqual(shortcutIds(slot.container), ["coordinator", "agent-a", "agent-child"]);
    });
  });
}
