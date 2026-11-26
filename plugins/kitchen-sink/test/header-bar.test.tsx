import { afterEach, describe, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();

const { resetHeaderBarRegistry, setHeaderBarSegments } = await import("@bb-plugins/header-bar");
const { act, cleanup, fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { COMPACT_VIEWPORT_QUERY } =
  await import("../src/app/components/ui/hooks/use-compact-viewport.tsx");
const { POINTER_COARSE_QUERY } =
  await import("../src/app/components/ui/hooks/use-pointer-coarse.ts");
const { buildKitchenSinkHeaderSegments } = await import("../src/app/header-bar/lineage.ts");
const { PHONE_VIEWPORT_QUERY } = await import("../src/app/header-bar/status-bar.tsx");
const { PROBE_ATTRIBUTE } = await import("../src/app/timeline-motion/thread-activity.ts");
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("../src/app/app.tsx"));
const statusBarSlot = app.threadHeaderRows.find((entry) => entry.id === "header-status-bar")!;
const probeSlot = app.threadHeaderRows.find((entry) => entry.id === "thread-activity-probe")!;

const originalMatchMedia = window.matchMedia;

function installMatchMedia(initial: { compact: boolean; coarse: boolean }) {
  const state = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  let callCount = 0;

  const matchesFor = (query: string) => {
    if (query === PHONE_VIEWPORT_QUERY) return state.compact && state.coarse;
    if (query === COMPACT_VIEWPORT_QUERY) return state.compact;
    if (query === POINTER_COARSE_QUERY) return state.coarse;
    return false;
  };

  window.matchMedia = ((query: string) => {
    callCount += 1;
    return {
      media: query,
      get matches() {
        return matchesFor(query);
      },
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener(type: string, listener: () => void) {
        if (type !== "change") return;
        let set = listeners.get(query);
        if (!set) {
          set = new Set();
          listeners.set(query, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type !== "change") return;
        listeners.get(query)?.delete(listener);
      },
      dispatchEvent: () => true,
    };
  }) as unknown as typeof window.matchMedia;

  return {
    get callCount() {
      return callCount;
    },
    set(next: Partial<{ compact: boolean; coarse: boolean }>) {
      Object.assign(state, next);
      for (const set of listeners.values()) {
        for (const listener of set) listener();
      }
    },
  };
}

afterEach(() => {
  cleanup();
  resetHeaderBarRegistry();
  window.matchMedia = originalMatchMedia;
});

function makeThread(
  overrides: Partial<PluginSidebarThread> & Pick<PluginSidebarThread, "id" | "displayTitle">,
): PluginSidebarThread {
  return {
    projectId: "proj_1",
    title: overrides.displayTitle,
    titleFallback: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/proj_1/threads/${overrides.id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 1000,
    updatedAt: 1000,
    lastReadAt: null,
    latestAttentionAt: 1000,
    ...overrides,
  };
}

describe("buildKitchenSinkHeaderSegments", () => {
  test("returns empty for standalone threads and ignores generic shared checkouts", () => {
    const sharedEnv = {
      id: "env_main",
      name: null,
      branchName: "main",
      path: "/repo",
      isWorktree: false,
      providerId: null,
      workspaceDisplayKind: null,
    };
    const threads = [
      makeThread({ id: "thr_a", displayTitle: "Thread A", environment: sharedEnv, createdAt: 1 }),
      makeThread({ id: "thr_b", displayTitle: "Thread B", environment: sharedEnv, createdAt: 2 }),
    ];

    expect(
      buildKitchenSinkHeaderSegments({
        threadId: "thr_a",
        threads,
        onOpenThread: () => {},
      }),
    ).toEqual([]);
  });

  test("returns parent lineage only on subthreads without a sibling/subthreads dropdown", () => {
    const threads = [
      makeThread({ id: "thr_parent", displayTitle: "Coordinator", createdAt: 1 }),
      makeThread({
        id: "thr_child_1",
        displayTitle: "Worker 1",
        parentThreadId: "thr_parent",
        status: "active",
        runtimeStatus: "active",
        createdAt: 2,
      }),
      makeThread({
        id: "thr_child_2",
        displayTitle: "Worker 2",
        parentThreadId: "thr_parent",
        createdAt: 3,
      }),
    ];

    const opened: string[] = [];
    const segments = buildKitchenSinkHeaderSegments({
      threadId: "thr_child_1",
      threads,
      onOpenThread: (id) => opened.push(id),
    });

    expect(segments.map((s) => s.slot)).toEqual(["lineage"]);
    expect(segments[0]?.label).toBe("Coordinator");
    segments[0]?.onClick?.();
    expect(opened).toEqual(["thr_parent"]);

    // Parent threads stay clean with no subthreads segment.
    expect(
      buildKitchenSinkHeaderSegments({
        threadId: "thr_parent",
        threads,
        onOpenThread: () => {},
      }),
    ).toEqual([]);
  });

  test("returns Forked lineage on forks and nothing on the source thread", () => {
    const threads = [
      makeThread({ id: "thr_root", displayTitle: "Root plan", createdAt: 1 }),
      makeThread({
        id: "thr_fork",
        displayTitle: "Experiment B",
        sourceThreadId: "thr_root",
        originKind: "fork",
        createdAt: 2,
      }),
    ];

    expect(
      buildKitchenSinkHeaderSegments({
        threadId: "thr_root",
        threads,
        onOpenThread: () => {},
      }),
    ).toEqual([]);

    const forkSegments = buildKitchenSinkHeaderSegments({
      threadId: "thr_fork",
      threads,
      onOpenThread: () => {},
    });
    expect(forkSegments.map((s) => s.slot)).toEqual(["lineage"]);
    expect(forkSegments[0]?.tag).toBe("Fork");
    expect(forkSegments[0]?.prefixIcon).toBe("GitBranch");
  });
});

describe("HeaderStatusBar unified host", () => {
  test("renders nothing for standalone threads and keeps Jump to latest probe intact", () => {
    expect(statusBarSlot.order).toBe(10);

    const renderedBar = renderSlot(
      statusBarSlot,
      { threadId: "thr_solo", projectId: "proj_1", environment: null },
      { sidebarThreads: { threads: [makeThread({ id: "thr_solo", displayTitle: "Solo" })] } },
    );
    const renderedProbe = renderSlot(probeSlot, {
      threadId: "thr_solo",
      projectId: "proj_1",
      environment: null,
    });

    expect(
      renderedBar.container.querySelector('[data-testid="thread-header-status-bar"]'),
    ).toBeNull();
    expect(renderedProbe.container.querySelector(`[${PROBE_ATTRIBUTE}="thr_solo"]`)).not.toBeNull();
  });

  test("renders ONE unified bar combining captain, scott-tasks, and kitchen-sink by slot precedence", () => {
    const threads = [
      makeThread({ id: "thr_cap", displayTitle: "Plugins", createdAt: 1 }),
      makeThread({
        id: "thr_crew",
        displayTitle: "Fix header",
        parentThreadId: "thr_cap",
        createdAt: 2,
      }),
      makeThread({
        id: "thr_crew_2",
        displayTitle: "Review header",
        parentThreadId: "thr_cap",
        createdAt: 3,
      }),
    ];

    const clicks: string[] = [];
    setHeaderBarSegments("thr_crew", "captain:test", "captain", [
      {
        owner: "captain",
        slot: "lineage",
        priority: 10,
        prefixIcon: "ArrowLeft",
        glyph: { kind: "icon", name: "captain/captain" },
        label: "Plugins",
        tag: "Implement",
        onClick: () => clicks.push("captain"),
      },
      {
        owner: "captain",
        slot: "threads",
        priority: 10,
        menu: {
          triggerLabel: "2 crew",
          ariaLabel: "2 crew",
          items: [
            { id: "thr_crew", label: "Fix header", active: true, onSelect: () => {} },
            { id: "thr_crew_2", label: "Review header", onSelect: () => clicks.push("crew2") },
          ],
        },
      },
    ]);
    setHeaderBarSegments("thr_crew", "tasks:test", "scott-tasks", [
      {
        owner: "scott-tasks",
        slot: "task",
        priority: 10,
        glyph: { kind: "task-status", status: "in_progress" },
        keyText: "BBP-42",
        label: "Unified statusbar",
        shrink: true,
        onClick: () => clicks.push("task"),
      },
      {
        owner: "scott-tasks",
        slot: "meta",
        priority: 10,
        glyph: { kind: "task-priority", priority: "high" },
        label: "Dec 1",
        tone: "muted",
      },
      {
        owner: "scott-tasks",
        slot: "threads",
        priority: 20,
        menu: {
          triggerLabel: "2 threads",
          ariaLabel: "2 threads",
          items: [],
        },
      },
    ]);

    const rendered = renderSlot(
      statusBarSlot,
      { threadId: "thr_crew", projectId: "proj_1", environment: null },
      { sidebarThreads: { threads } },
    );

    expect(
      rendered.container.querySelectorAll('[data-testid="thread-header-status-bar"]').length,
    ).toBe(1);
    expect(
      rendered.container
        .querySelector('[data-header-bar-slot="lineage"]')
        ?.getAttribute("data-header-bar-owner"),
    ).toBe("captain");
    expect(
      rendered.container
        .querySelector('[data-header-bar-slot="task"]')
        ?.getAttribute("data-header-bar-owner"),
    ).toBe("scott-tasks");
    expect(
      rendered.container
        .querySelector('[data-header-bar-slot="meta"]')
        ?.getAttribute("data-header-bar-owner"),
    ).toBe("scott-tasks");
    expect(
      rendered.container
        .querySelector('[data-header-bar-slot="threads"]')
        ?.getAttribute("data-header-bar-owner"),
    ).toBe("captain");

    fireEvent.click(rendered.getByRole("button", { name: "Plugins" }));
    fireEvent.click(rendered.getByRole("button", { name: "Unified statusbar" }));
    expect(clicks).toEqual(["captain", "task"]);
  });

  test("reactively updates when a contributor mounts or unmounts and keeps split panes isolated", () => {
    const threads = [
      makeThread({ id: "thr_left", displayTitle: "Left" }),
      makeThread({ id: "thr_right", displayTitle: "Right" }),
    ];

    const left = renderSlot(
      statusBarSlot,
      { threadId: "thr_left", projectId: "proj_1", environment: null },
      { sidebarThreads: { threads } },
    );
    const right = renderSlot(
      statusBarSlot,
      { threadId: "thr_right", projectId: "proj_1", environment: null },
      { sidebarThreads: { threads } },
    );

    expect(left.container.querySelector('[data-testid="thread-header-status-bar"]')).toBeNull();
    expect(right.container.querySelector('[data-testid="thread-header-status-bar"]')).toBeNull();

    act(() => {
      setHeaderBarSegments("thr_left", "tasks:l", "scott-tasks", [
        {
          owner: "scott-tasks",
          slot: "task",
          priority: 10,
          keyText: "BBP-7",
          label: "Left pane task",
        },
      ]);
    });

    expect(left.container.querySelector('[data-testid="thread-header-status-bar"]')).not.toBeNull();
    expect(right.container.querySelector('[data-testid="thread-header-status-bar"]')).toBeNull();
  });

  test("hides on phone viewports (compact + coarse) and stays visible on desktop, narrow fine, and wide coarse", () => {
    const threads = [
      makeThread({ id: "thr_parent", displayTitle: "Plugins Captain", createdAt: 1 }),
      makeThread({
        id: "thr_child",
        displayTitle: "Child work",
        parentThreadId: "thr_parent",
        createdAt: 2,
      }),
    ];

    setHeaderBarSegments("thr_child", "tasks:m", "scott-tasks", [
      {
        owner: "scott-tasks",
        slot: "task",
        priority: 10,
        keyText: "BBP-148",
        label: "Hide on mobile",
      },
    ]);

    // Phone (compact viewport + coarse pointer): renders nothing at all.
    const media = installMatchMedia({ compact: true, coarse: true });
    const phone = renderSlot(
      statusBarSlot,
      { threadId: "thr_child", projectId: "proj_1", environment: null },
      { sidebarThreads: { threads } },
    );
    expect(phone.container.firstChild).toBeNull();
    expect(phone.container.querySelector('[data-testid="thread-header-status-bar"]')).toBeNull();

    // Switching to narrow desktop (compact + fine pointer): renders normally.
    act(() => {
      media.set({ compact: true, coarse: false });
    });
    expect(
      phone.container.querySelector('[data-testid="thread-header-status-bar"]'),
    ).not.toBeNull();

    // Switching to wide touch / tablet (non-compact + coarse pointer): renders normally.
    act(() => {
      media.set({ compact: false, coarse: true });
    });
    expect(
      phone.container.querySelector('[data-testid="thread-header-status-bar"]'),
    ).not.toBeNull();

    // Switching to standard desktop (non-compact + fine pointer): renders normally.
    act(() => {
      media.set({ compact: false, coarse: false });
    });
    expect(
      phone.container.querySelector('[data-testid="thread-header-status-bar"]'),
    ).not.toBeNull();
    expect(phone.getByRole("button", { name: "Parent: Plugins Captain" })).not.toBeNull();

    // Switching back to phone: unmounts the statusbar cleanly.
    act(() => {
      media.set({ compact: true, coarse: true });
    });
    expect(phone.container.firstChild).toBeNull();
  });

  test("keeps matchMedia subscriptions flat across repeated re-renders", () => {
    const threads = [
      makeThread({ id: "thr_parent", displayTitle: "Plugins Captain", createdAt: 1 }),
      makeThread({
        id: "thr_child",
        displayTitle: "Child work",
        parentThreadId: "thr_parent",
        createdAt: 2,
      }),
    ];

    const media = installMatchMedia({ compact: false, coarse: false });
    const SlotComponent = statusBarSlot.component;
    const rendered = renderSlot(
      statusBarSlot,
      { threadId: "thr_child", projectId: "proj_1", environment: null },
      { sidebarThreads: { threads } },
    );

    const callsAfterMount = media.callCount;
    expect(callsAfterMount).toBeGreaterThan(0);
    expect(callsAfterMount).toBeLessThanOrEqual(3);

    for (let i = 0; i < 100; i += 1) {
      rendered.rerender(
        <SlotComponent threadId="thr_child" projectId="proj_1" environment={null} />,
      );
    }
    expect(media.callCount).toBe(callsAfterMount);

    act(() => {
      media.set({ compact: true, coarse: true });
    });
    expect(rendered.container.firstChild).toBeNull();

    for (let i = 0; i < 100; i += 1) {
      rendered.rerender(
        <SlotComponent threadId="thr_child" projectId="proj_1" environment={null} />,
      );
    }
    expect(media.callCount).toBe(callsAfterMount);
  });
});
