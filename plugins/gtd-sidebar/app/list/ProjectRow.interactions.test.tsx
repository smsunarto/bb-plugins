// @vitest-environment jsdom

import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import { Provider, createStore } from "jotai";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { SectionThreadDndState } from "../dnd/useSectionThreadDnd.js";
import type { ProjectThreadListState } from "./ProjectRow.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import { buildSidebarEntitySectionId } from "../model/sidebar-section-order.js";
import {
  makeSidebarEnvironment,
  makeSidebarProject,
  makeSidebarThread,
  sdkResult,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.js";

installTestPluginRuntime();
const { ProjectRow, PinnedEnvironmentThreadGroupRow, ThreadTreeNodeRow } =
  await import("./ProjectRow.js");
const { ThreadCreationPlacementScope } = await import("./ThreadCreationPlacement.js");
const { SidebarHeaderControls } = await import("./SidebarHeaderControls.js");
const { SidebarDraftPresenceSync } = await import("./sidebarDraftPresence.js");

function makeThread(overrides: SidebarThreadOverrides = {}): SidebarThread {
  return makeSidebarThread({
    id: "thr_test",
    title: "Test thread",
    titleFallback: "Test thread",
    lastReadAt: 100,
    latestAttentionAt: 100,
    createdAt: 0,
    updatedAt: 100,
    ...overrides,
  });
}

function makeSectionDnd(overrides: Partial<SectionThreadDndState> = {}): SectionThreadDndState {
  return {
    activeItemId: null,
    draggedThreadIds: null,
    activeThread: makeThread({
      id: "thr_dragged",
      title: "Dragged",
      titleFallback: "Dragged",
    }),
    consumeClickSuppression: () => false,
    dndContextProps: {},
    dragOverParentKey: null,
    unchangedParentKey: null,
    itemIdsByParentKey: new Map(),
    nestTarget: null,
    nestPreviewBeforeKey: null,
    onClickCapture: () => undefined,
    pinnedItemIds: [],
    pinnedReorderPending: false,
    reorderTarget: null,
    ...overrides,
  };
}

interface HarnessProps {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}

function Harness({ children, store }: HarnessProps) {
  return (
    <TooltipProvider>
      <SidebarDraftPresenceSync />
      <Provider store={store}>
        <ThreadRowNavigationProvider>
          <SidebarRenameProvider>{children}</SidebarRenameProvider>
        </ThreadRowNavigationProvider>
      </Provider>
    </TooltipProvider>
  );
}

interface RenderTreeOptions {
  threads?: readonly SidebarThread[];
  draftThreadIds?: readonly string[];
  sdk?: PluginSdkTestFakes;
  store?: ReturnType<typeof createStore>;
}

function renderTree(
  children: ReactNode,
  { threads = [], draftThreadIds = [], sdk, store }: RenderTreeOptions = {},
): RenderedSlot {
  return renderSlot(
    { component: Harness },
    { children, store: store ?? createStore() },
    {
      sidebarThreads: {
        threads,
        projects: [makeSidebarProject()],
      },
      sidebarDraftThreadIds: draftThreadIds,
      sdk,
    },
  );
}

function renderPinnedParentWithChild({
  isCollapsed,
  sectionDnd,
}: {
  isCollapsed: boolean;
  sectionDnd: SectionThreadDndState;
}) {
  const parent = makeThread({
    id: "thr_parent",
    title: "Parent",
    titleFallback: "Parent",
    pinnedAt: 1,
  });
  const child = makeThread({
    id: "thr_child",
    title: "Child",
    titleFallback: "Child",
    parentThreadId: "thr_parent",
  });
  const node = buildPinnedSidebarState({ threads: [parent, child] }).rootNodes[0];
  const { container } = renderTree(
    <ThreadTreeNodeRow
      projectId="proj_test"
      node={node}
      depthOffset={0}
      isEnvGrouped={false}
      collapsedThreadIds={isCollapsed ? new Set(["thr_parent"]) : new Set()}
      collapsedEnvironmentIds={new Set()}
      onToggleThreadCollapsed={vi.fn()}
      onToggleEnvironmentCollapsed={vi.fn()}
      sectionDnd={sectionDnd}
      sortableRef={() => undefined}
    />,
    { threads: [parent, child] },
  );
  return container;
}

function rowOfThread(container: ParentNode, id: string): Element | null | undefined {
  return container
    .querySelector(`[data-sidebar-thread-id="${id}"]`)
    ?.closest(".bb-sidebar-hover-actions-row");
}

/** A row's tree guides as "<left>[ last][ below]", in drawing order. */
function renderedGuides(row: Element | null | undefined): string[] {
  return [
    ...(row?.querySelectorAll<HTMLElement>("[data-gtd-tree-guides] .gtd-tree-line") ?? []),
  ].map((line) =>
    [
      line.style.left,
      line.classList.contains("gtd-tree-line-last") ? "last" : null,
      line.classList.contains("gtd-tree-line-below") ? "below" : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function renderProjectRow(
  onToggleProjectCollapsed = vi.fn(),
  threadListState: ProjectThreadListState = { status: "ready", threads: [] },
  isActive = false,
  collapsedEnvironmentIds: Set<string> = new Set(),
  isCollapsed = false,
  options: Omit<RenderTreeOptions, "threads"> = {},
) {
  const onToggleEnvironmentCollapsed = vi.fn();
  const store = createStore();
  store.set(sidebarOrganizationModeAtom, "project");
  const result = renderTree(
    <ProjectRow
      // GTD draws every project as a folder under its shelf.
      tier="project"
      project={makeSidebarProject()}
      threadListState={threadListState}
      isActive={isActive}
      isCollapsed={isCollapsed}
      compareThreads={() => 0}
      collapsedThreadIds={new Set()}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      onToggleProjectCollapsed={onToggleProjectCollapsed}
      onToggleThreadCollapsed={vi.fn()}
      onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
    />,
    {
      threads: threadListState.status === "ready" ? threadListState.threads : [],
      store,
      ...options,
    },
  );
  return { ...result, onToggleEnvironmentCollapsed, onToggleProjectCollapsed };
}

function renderedIndicators(): Array<string | null> {
  return Array.from(document.querySelectorAll("[data-thread-status-glyph]"), (glyph) =>
    glyph.getAttribute("data-thread-status-glyph"),
  );
}

function expectCollapsedActivityAtSidebarEdge(indicator: string) {
  const edgeSlot = Array.from(
    document.querySelectorAll(`[data-thread-status-glyph="${indicator}"]`),
  )
    .map((indicator) => indicator.closest("[data-sidebar-collapsed-activity-edge]"))
    .find((slot) => slot !== null);

  expect(edgeSlot).toBeInstanceOf(HTMLElement);
}

const ENVIRONMENT_THREADS = [
  makeThread({
    id: "thr_worktree_a",
    environment: makeSidebarEnvironment({
      id: "env_test",
      name: "Feature workspace",
      branchName: "feat/menu-close",
      providerId: "git-worktree",
      isWorktree: true,
    }),
    queuedWork: "none",
  }),
  makeThread({
    id: "thr_worktree_b",
    environment: makeSidebarEnvironment({
      id: "env_test",
      name: "Feature workspace",
      branchName: "feat/menu-close",
      providerId: "git-worktree",
      isWorktree: true,
    }),
    queuedWork: "none",
  }),
];

describe("ProjectRow interactions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews the dragged thread as a child of a valid nest target", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        nestTarget: { threadId: "thr_parent", state: "valid" },
        nestPreviewBeforeKey: "thread:thr_child",
      }),
    });

    const rows = [
      ...container.querySelectorAll("[data-sidebar-thread-id], [data-sidebar-nest-drop-preview]"),
    ];
    expect(
      rows.map((row) => row.getAttribute("data-sidebar-thread-id") ?? row.textContent),
    ).toEqual(["thr_parent", "Dragged", "thr_child"]);
    // The preview carries the parent's line on to the child below it.
    expect(
      renderedGuides(container.querySelector("[data-sidebar-nest-drop-preview]")?.parentElement),
    ).toEqual(["12px"]);
    expect(renderedGuides(rowOfThread(container, "thr_child"))).toEqual(["12px last"]);
  });

  it("previews the dragged thread after the last child when it sorts last", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        nestTarget: { threadId: "thr_parent", state: "valid" },
        nestPreviewBeforeKey: null,
      }),
    });

    const rows = [
      ...container.querySelectorAll("[data-sidebar-thread-id], [data-sidebar-nest-drop-preview]"),
    ];
    expect(
      rows.map((row) => row.getAttribute("data-sidebar-thread-id") ?? row.textContent),
    ).toEqual(["thr_parent", "thr_child", "Dragged"]);
    // The parent's line runs past its last child to end at the preview.
    expect(renderedGuides(rowOfThread(container, "thr_child"))).toEqual(["12px"]);
    expect(
      renderedGuides(container.querySelector("[data-sidebar-nest-drop-preview]")?.parentElement),
    ).toEqual(["12px last"]);
  });

  it("starts a line under a childless nest target for its preview", () => {
    const target = makeThread({ id: "thr_target", title: "Target", pinnedAt: 1 });
    const node = buildPinnedSidebarState({ threads: [target] }).rootNodes[0];
    const { container } = renderTree(
      <ThreadTreeNodeRow
        projectId="proj_test"
        node={node}
        depthOffset={0}
        isEnvGrouped={false}
        collapsedThreadIds={new Set()}
        collapsedEnvironmentIds={new Set()}
        onToggleThreadCollapsed={vi.fn()}
        onToggleEnvironmentCollapsed={vi.fn()}
        sectionDnd={makeSectionDnd({
          nestTarget: { threadId: "thr_target", state: "valid" },
          nestPreviewBeforeKey: null,
        })}
        sortableRef={() => undefined}
      />,
      { threads: [target] },
    );

    expect(renderedGuides(rowOfThread(container, "thr_target"))).toEqual(["12px below"]);
    expect(
      renderedGuides(container.querySelector("[data-sidebar-nest-drop-preview]")?.parentElement),
    ).toEqual(["12px last"]);
  });

  it("leaves a blocked nest target without a child preview", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        nestTarget: { threadId: "thr_parent", state: "blocked" },
        nestPreviewBeforeKey: null,
      }),
    });

    expect(container.querySelector("[data-sidebar-nest-drop-preview]")).toBeNull();
  });

  it("anchors a pinned insert line below the subtree, not between parent and child", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: false,
      sectionDnd: makeSectionDnd({
        reorderTarget: { threadId: "thr_parent", placement: "after" },
      }),
    });

    expect(screen.getByText("Child")).not.toBeNull();
    expect(container.querySelector("[data-sidebar-reorder-placement]")).toBeNull();
    const group = container.querySelector<HTMLElement>("[data-sidebar-sticky-group]");
    expect(group?.className).toContain("after:-bottom-px");
    expect(group?.contains(screen.getByText("Child"))).toBe(true);
  });

  it("anchors a pinned insert line on the row when the subtree is collapsed", () => {
    const container = renderPinnedParentWithChild({
      isCollapsed: true,
      sectionDnd: makeSectionDnd({
        reorderTarget: { threadId: "thr_parent", placement: "after" },
      }),
    });

    expect(screen.queryByText("Child")).toBeNull();
    expect(
      container
        .querySelector("[data-sidebar-reorder-placement]")
        ?.getAttribute("data-sidebar-reorder-placement"),
    ).toBe("after");
  });

  it("keeps project header controls touch-accessible when their menu opens and closes", async () => {
    renderProjectRow();
    const trigger = screen.getByRole("button", {
      name: /^Test project actions(?:;|$)/,
    });
    const actions = trigger.closest(".bb-sidebar-hover-actions");
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe("always");
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe("always");
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBe("true");

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe("always");
    expect(actions?.getAttribute("data-sidebar-hover-actions-open")).toBeNull();
  });

  it("renames a project from its menu without collapsing its threads", async () => {
    const update = vi.fn(sdkResult({ ok: true }));
    const { onToggleProjectCollapsed, sdkCalls } = renderProjectRow(
      vi.fn(),
      { status: "ready", threads: [] },
      false,
      new Set(),
      false,
      { sdk: { projects: { update } } },
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Test project actions" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "  Renamed project  " } });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(input);
    expect(update).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sdkCalls).toContainEqual({
        method: "projects.update",
        args: [{ projectId: "proj_test", name: "Renamed project" }],
      }),
    );
    expect(onToggleProjectCollapsed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("links project settings and confirms removal through the SDK", async () => {
    const remove = vi.fn(sdkResult({ ok: true }));
    const { sdkCalls } = renderProjectRow(
      vi.fn(),
      { status: "ready", threads: [] },
      false,
      new Set(),
      false,
      { sdk: { projects: { delete: remove } } },
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Test project actions" }), {
      button: 0,
    });
    const settings = await screen.findByRole("menuitem", {
      name: "Project settings",
    });
    expect(settings.getAttribute("href")).toBe("/settings/projects/proj_test");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));
    await waitFor(() =>
      expect(sdkCalls).toContainEqual({
        method: "projects.delete",
        args: [{ projectId: "proj_test" }],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("puts the folder toggle in the tree's disclosure column and root titles on the title column", () => {
    const result = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [makeThread()],
    });

    const disclosure = screen.getByRole("button", {
      name: "Collapse Test project section",
    });
    const label = screen.getByTitle("Test project");
    const threadLink = result.container.querySelector('[data-sidebar-thread-id="thr_test"]');
    const projectGroup = result.container.querySelector("[data-sidebar-sticky-project-item]");

    expect(label.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(
      0,
    );
    expect(disclosure.classList.contains("gtd-folder-glyph")).toBe(true);
    expect(
      threadLink?.closest<HTMLElement>(".bb-sidebar-hover-actions-row")?.style.paddingLeft,
    ).toBe("28px");
    expect(projectGroup?.getAttribute("data-sidebar-project-id")).toBe("proj_test");
    expect(projectGroup?.hasAttribute("data-sidebar-section-id")).toBe(false);
  });

  it("indents a nested environment group one level below its parent", () => {
    const environment = makeSidebarEnvironment({
      id: "env_nested",
      name: "Nested workspace",
      providerId: "git-worktree",
      isWorktree: true,
    });
    const { container } = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [
        makeThread({ id: "thr_parent", title: "Parent" }),
        makeThread({
          id: "thr_child_a",
          parentThreadId: "thr_parent",
          environment,
        }),
        makeThread({
          id: "thr_child_b",
          parentThreadId: "thr_parent",
          environment,
        }),
      ],
    });

    const group = screen
      .getByRole("button", { name: "Collapse Nested workspace threads" })
      .closest("[data-sidebar-sticky-group]");
    const header = group?.querySelector<HTMLElement>(".bb-sidebar-hover-actions-row");
    const child = group?.querySelector<HTMLElement>('[data-sidebar-thread-id="thr_child_a"]');

    expect(container.querySelector('[data-sidebar-thread-id="thr_parent"]')).not.toBeNull();
    // Depth 1: the icon sits in the column 16px in, the name on the 44px title
    // column, and the children a step in. The header carries its parent's
    // guide down the root column; each child its stretch of the header's
    // guide, the last ending at its middle.
    expect(header?.style.paddingLeft).toBe("20px");
    const rowOf = (id: string) =>
      group
        ?.querySelector(`[data-sidebar-thread-id="${id}"]`)
        ?.closest(".bb-sidebar-hover-actions-row");
    expect(renderedGuides(header)).toEqual(["12px last", "28px below"]);
    // Its chevron turns on GTD's fold ease.
    expect(
      screen
        .getByRole("button", { name: "Collapse Nested workspace threads" })
        .querySelector(".gtd-chevron-motion"),
    ).not.toBeNull();
    expect(renderedGuides(rowOf("thr_child_a"))).toEqual(["28px"]);
    expect(renderedGuides(rowOf("thr_child_b"))).toEqual(["28px last"]);
    expect(child?.closest<HTMLElement>(".bb-sidebar-hover-actions-row")?.style.paddingLeft).toBe(
      "60px",
    );
  });

  it("runs a parent's guide past an open grandchild to its last child", () => {
    const { container } = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [
        makeThread({ id: "thr_root", title: "Root" }),
        makeThread({ id: "thr_first", parentThreadId: "thr_root", title: "First" }),
        makeThread({ id: "thr_grandchild", parentThreadId: "thr_first", title: "Grandchild" }),
        makeThread({ id: "thr_last", parentThreadId: "thr_root", title: "Last" }),
      ],
    });
    const guides = (id: string) =>
      renderedGuides(
        container
          .querySelector(`[data-sidebar-thread-id="${id}"]`)
          ?.closest(".bb-sidebar-hover-actions-row"),
      );

    // An open parent starts its children's line in the gap below it; Root's
    // line passes the grandchild on its way to Last.
    expect(guides("thr_root")).toEqual(["12px below"]);
    expect(guides("thr_first")).toEqual(["12px", "28px below"]);
    expect(guides("thr_grandchild")).toEqual(["12px", "28px last"]);
    expect(guides("thr_last")).toEqual(["12px last"]);
  });

  it("shows generic runtime activity before a named workflow rollup", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_worktree_workflow",
            status: "active",
            environment: makeSidebarEnvironment({
              id: "env_test",
              name: "Feature workspace",
              branchName: "feat/menu-close",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
            activity: {
              workflows: 1,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 0,
              goals: 0,
            },
            runtimeStatus: "active",
          }),
          makeThread({
            id: "thr_worktree_sibling",
            environment: makeSidebarEnvironment({
              id: "env_test",
              name: "Feature workspace",
              branchName: "feat/menu-close",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
        ],
      },
      false,
      new Set(["env_test"]),
    );

    expect(
      screen.getByRole("button", {
        name: "Expand Feature workspace threads",
      }),
    ).not.toBeNull();
    expect(renderedIndicators()).toEqual(["runtime"]);
  });

  it.each([
    { isCollapsed: true, expectedHoverReveal: false },
    { isCollapsed: false, expectedHoverReveal: true },
  ])(
    "sets environment disclosure hover reveal to $expectedHoverReveal when collapsed is $isCollapsed",
    ({ expectedHoverReveal, isCollapsed }) => {
      const environment = makeSidebarEnvironment({
        id: "env_disclosure",
        name: "Disclosure workspace",
        providerId: "git-worktree",
        isWorktree: true,
      });
      renderProjectRow(
        vi.fn(),
        {
          status: "ready",
          threads: [
            makeThread({ id: "thr_disclosure_one", environment }),
            makeThread({ id: "thr_disclosure_two", environment }),
          ],
        },
        false,
        new Set(isCollapsed ? ["env_disclosure"] : []),
      );

      const toggle = screen.getByRole("button", {
        name: `${isCollapsed ? "Expand" : "Collapse"} Disclosure workspace threads`,
      });
      expect(toggle.classList.contains("bb-sidebar-hover-actions")).toBe(expectedHoverReveal);
    },
  );

  it("shows a working draft before named work for a collapsed environment", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_worktree_plan",
            environment: makeSidebarEnvironment({
              id: "env_draft",
              name: "Draft workspace",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 1,
              goals: 0,
            },
          }),
          makeThread({
            id: "thr_worktree_draft",
            environment: makeSidebarEnvironment({
              id: "env_draft",
              name: "Draft workspace",
              providerId: "git-worktree",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
        ],
      },
      false,
      new Set(["env_draft"]),
      false,
      { draftThreadIds: ["thr_worktree_draft"] },
    );

    expect(renderedIndicators()).toEqual(["working-draft"]);
  });

  it("folds a folder from anywhere on its row but not from its actions", () => {
    const { onToggleProjectCollapsed } = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [makeThread()],
    });

    fireEvent.click(screen.getByTitle("Test project"));
    expect(onToggleProjectCollapsed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Test project section" }));
    expect(onToggleProjectCollapsed).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Test project actions" }));
    expect(onToggleProjectCollapsed).toHaveBeenCalledTimes(2);
  });

  it("shows a folded folder's family count in place of its rows", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({ id: "thr_parent", isUnread: false }),
          makeThread({ id: "thr_child", parentThreadId: "thr_parent", isUnread: false }),
          makeThread({ id: "thr_other", isUnread: false }),
        ],
      },
      false,
      new Set(),
      true,
    );

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(renderedIndicators()).toEqual([]);
    const count = document.querySelector("[data-gtd-fold-count]");
    expect(count?.textContent).toBe("2");
    expect(count?.classList.contains("text-muted-foreground")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Expand Test project section" })
        .getAttribute("aria-describedby"),
    ).not.toBeNull();
    expect(screen.getByText("2 threads").classList.contains("sr-only")).toBe(true);
  });

  it("keeps a folded folder's work glyph beside its family count", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_working",
            status: "active",
            runtimeStatus: "active",
            queuedWork: "none",
            isUnread: false,
          }),
        ],
      },
      false,
      new Set(),
      true,
    );

    expect(document.querySelector("[data-gtd-fold-count]")?.textContent).toBe("1");
    expect(
      document.querySelector("[data-sidebar-collapsed-activity-edge] [data-thread-status-glyph]"),
    ).not.toBeNull();
  });

  it("counts the families that need the user in a folded folder", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({ id: "thr_unread", lastReadAt: 100, latestAttentionAt: 200 }),
          makeThread({ id: "thr_quiet", isUnread: false }),
        ],
      },
      false,
      new Set(),
      true,
    );

    const count = document.querySelector("[data-gtd-fold-count]");
    expect(count?.textContent).toBe("1 / 2");
    expect(count?.classList.contains("text-attention")).toBe(true);
  });

  it("excludes hidden side-chat activity from a collapsed project", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_side_chat",
            isHidden: true,
            activity: {
              workflows: 0,
              backgroundAgents: 0,
              backgroundCommands: 0,
              planMode: 1,
              goals: 0,
            },
          }),
        ],
      },
      false,
      new Set(),
      true,
      { draftThreadIds: ["thr_side_chat"] },
    );

    expect(renderedIndicators()).toEqual([]);
  });

  it.each([false, true])(
    "keeps environment actions touch-accessible when collapsed=%s",
    async (isCollapsed) => {
      const update = vi.fn(sdkResult({ ok: true }));
      const { navigateCalls, sdkCalls } = renderProjectRow(
        vi.fn(),
        { status: "ready", threads: ENVIRONMENT_THREADS },
        false,
        isCollapsed ? new Set(["env_test"]) : new Set(),
        false,
        { sdk: { environments: { update } } },
      );

      const createButton = screen.getByRole("button", {
        name: "New thread in environment",
      });
      const actions = createButton.closest(".bb-sidebar-hover-actions");
      expect(actions?.getAttribute("data-sidebar-hover-actions-mobile")).toBe("always");
      const menu = screen.getByRole("button", { name: "Environment actions" });
      expect(actions?.contains(menu)).toBe(true);
      expect(menu.nextElementSibling).toBe(createButton);
      fireEvent.click(createButton);
      expect(navigateCalls).toEqual([
        {
          method: "toCompose",
          options: {
            projectId: "proj_test",
            environmentId: "env_test",
            placement: { sectionId: null, pinned: false },
            focusPrompt: true,
          },
        },
      ]);

      fireEvent.pointerDown(screen.getByRole("button", { name: "Environment actions" }), {
        button: 0,
      });
      const rename = await screen.findByRole("menuitem", { name: "Rename" });
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "Rename",
        "Archive",
      ]);
      fireEvent.click(rename);

      const input = await screen.findByRole("textbox", {
        name: "Environment name",
      });
      expect(input.getAttribute("placeholder")).toBe("feat/menu-close");
      expect(input).toHaveProperty("value", "Feature workspace");
      await waitFor(() => expect(document.activeElement).toBe(input));
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => {
        expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
      });
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(sdkCalls).toContainEqual({
          method: "environments.update",
          args: [{ environmentId: "env_test", name: null }],
        }),
      );
    },
  );

  it("leaves threads sharing the project checkout ungrouped", () => {
    renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [
        makeThread({
          id: "thr_checkout_a",
          environment: makeSidebarEnvironment({
            id: "env_checkout",
            branchName: "main",
            providerId: null,
          }),
          queuedWork: "none",
        }),
        makeThread({
          id: "thr_checkout_b",
          environment: makeSidebarEnvironment({
            id: "env_checkout",
            branchName: "main",
            providerId: null,
          }),
          queuedWork: "none",
        }),
      ],
    });

    expect(screen.queryByRole("button", { name: "Collapse main threads" })).toBeNull();
  });

  it("archives and renames an environment group from any provider", async () => {
    const archiveThreads = vi.fn(sdkResult({ ok: true, archivedThreadIds: [] }));
    const update = vi.fn(sdkResult({ ok: true }));
    const { sdkCalls, experimental_environmentArchiveCalls } = renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_plain_a",
            environment: makeSidebarEnvironment({
              id: "env_plain",
              branchName: "main",
              providerId: "personal-workspace",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
          makeThread({
            id: "thr_plain_b",
            environment: makeSidebarEnvironment({
              id: "env_plain",
              branchName: "main",
              providerId: "personal-workspace",
              isWorktree: true,
            }),
            queuedWork: "none",
          }),
        ],
      },
      false,
      new Set(),
      false,
      { sdk: { environments: { archiveThreads, update } } },
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment actions" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(experimental_environmentArchiveCalls).toEqual(["env_plain"]);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment actions" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", {
      name: "Environment name",
    });
    fireEvent.change(input, { target: { value: "  Release workspace  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(sdkCalls).toContainEqual({
        method: "environments.update",
        args: [{ environmentId: "env_plain", name: "Release workspace" }],
      }),
    );
  });
});

describe("environment creation placement", () => {
  afterEach(cleanup);
  it.each([
    ["pinned", "sec_managers", true],
    ["pinned-mixed", null, true],
    ["section:sec_visible", "sec_visible", false],
    ["project:proj_test", null, false],
    ["machine:host_test", null, false],
    ["threads", null, false],
  ] as const)("creates in the containing %s group", (groupId, sectionId, pinned) => {
    const threads = ENVIRONMENT_THREADS.map((thread) => ({
      ...thread,
      sectionId:
        groupId === "pinned-mixed" && thread.id === ENVIRONMENT_THREADS[0].id
          ? "sec_other"
          : "sec_managers",
      pinnedAt: 1,
    }));
    const group = buildPinnedSidebarState({
      threads,
      groupEnvironmentThreads: true,
    }).rootItems[0];
    if (group.kind !== "environment") throw new Error("Expected environment group");
    const { navigateCalls } = renderTree(
      <ThreadCreationPlacementScope group={groupId === "pinned-mixed" ? "pinned" : groupId}>
        <PinnedEnvironmentThreadGroupRow
          group={group.group}
          collapsedThreadIds={new Set()}
          collapsedEnvironmentIds={new Set()}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={vi.fn()}
        />
      </ThreadCreationPlacementScope>,
      { threads },
    );
    fireEvent.click(screen.getByRole("button", { name: "New thread in environment" }));
    expect(navigateCalls).toEqual([
      {
        method: "toCompose",
        options: {
          projectId: "proj_test",
          environmentId: "env_test",
          focusPrompt: true,
          placement: { sectionId, pinned },
        },
      },
    ]);
  });
});
