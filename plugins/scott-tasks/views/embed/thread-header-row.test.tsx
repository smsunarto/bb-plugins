// @vitest-environment jsdom
import { getResolvedHeaderBar, resetHeaderBarRegistry } from "@bb-plugins/header-bar";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Task, TaskThread } from "../../shared/contract.js";
import { makeTask, rpcInput } from "../../test-fixtures.js";
import { formatDueDate } from "../list/lib.js";

const app = await loadPluginApp(() => import("../../app"));

afterEach(() => {
  cleanup();
  resetHeaderBarRegistry();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_1_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const TASK_2_ID = "01HZZZZZZZZZZZZZZZZZZZZZT2";

const task1 = makeTask({
  id: TASK_1_ID,
  projectId: PROJECT_ID,
  number: 42,
  key: "BBP-42",
  title: "Surface linked task header row",
  status: "in_progress",
  priority: "high",
  dueDate: "2099-07-18",
  position: 100,
});

const task2 = makeTask({
  id: TASK_2_ID,
  projectId: PROJECT_ID,
  number: 43,
  key: "BBP-43",
  title: "Handle multiple linked tasks cleanly",
  status: "todo",
  priority: "none",
  dueDate: null,
  position: 200,
});

function makeLink(overrides: Partial<TaskThread> = {}): TaskThread {
  return {
    id: "01HZZZZZZZZZZZZZZZZZZZZZH1",
    taskId: TASK_1_ID,
    threadId: "thr_worker1",
    presetName: "Sonnet · high",
    title: "Worker 1",
    liveStatus: "working",
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeSidebarThread(
  overrides: Partial<PluginSidebarThread> & { id: string; displayTitle: string },
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
    providerId: "claude-code",
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
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    environment: null,
    ...overrides,
  } as PluginSidebarThread;
}

function listTasksFrom(allTasks: readonly Task[]) {
  return (input: unknown) => {
    const { taskIds } = rpcInput(input);
    return {
      tasks: allTasks.filter((entry) => !Array.isArray(taskIds) || taskIds.includes(entry.id)),
    };
  };
}

describe("Tasks thread header bar publisher", () => {
  it("registers experimental_threadHeaderRow at order 30", () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task");
    expect(slot).toBeDefined();
    expect(slot?.order).toBe(30);
  });

  it("publishes nothing on unlinked threads without querying tasks or sibling threads", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const listTasks = vi.fn(() => ({ tasks: [] }));
    const listTaskThreads = vi.fn(() => ({ taskThreads: [] }));
    const listTaskThreadsByThread = vi.fn(() => ({ taskThreads: [] }));

    const rendered = renderSlot(
      slot,
      { threadId: "thr_unlinked", projectId: "proj_1", environment: null },
      { rpc: { listTaskThreadsByThread, listTasks, listTaskThreads } },
    );

    await waitFor(() => expect(listTaskThreadsByThread).toHaveBeenCalledTimes(1));
    expect(rendered.container.innerHTML).toBe("");
    expect(getResolvedHeaderBar("thr_unlinked").isEmpty).toBe(true);
    expect(listTasks).not.toHaveBeenCalled();
    expect(listTaskThreads).not.toHaveBeenCalled();
  });

  it("publishes task and meta segments, opens Task side-panel tab, and clears on unmount", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const link1 = makeLink({ threadId: "thr_meta" });
    const openTab = vi.fn(() => true);
    const rendered = renderSlot(
      slot,
      { threadId: "thr_meta", projectId: "proj_1", environment: null },
      {
        experimental_panel: { openTab },
        rpc: {
          listTaskThreadsByThread: () => ({ taskThreads: [link1] }),
          listTasks: listTasksFrom([task1]),
          listTaskThreads: () => ({ taskThreads: [link1] }),
        },
        sidebarThreads: {
          status: "ready",
          threads: [makeSidebarThread({ id: "thr_meta", displayTitle: "Worker 1" })],
        },
      },
    );

    await waitFor(() => {
      expect(getResolvedHeaderBar("thr_meta").slots.task?.keyText).toBe("BBP-42");
    });

    expect(rendered.container.innerHTML).toBe("");
    const resolved = getResolvedHeaderBar("thr_meta");
    expect(resolved.slots.task?.label).toBe("Surface linked task header row");
    expect(resolved.slots.task?.glyph).toEqual({ kind: "task-status", status: "in_progress" });
    expect(resolved.slots.meta?.glyph).toEqual({ kind: "task-priority", priority: "high" });
    expect(resolved.slots.meta?.label).toBe(formatDueDate("2099-07-18"));
    expect(resolved.slots.meta?.tone).toBe("muted");
    expect(resolved.slots.threads).toBeUndefined();

    act(() => {
      resolved.slots.task?.onClick?.();
    });
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "task", context: { kind: "thread" }, availability: "action" },
      title: "BBP-42",
      params: { taskKey: "BBP-42" },
    });

    rendered.unmount();
    expect(getResolvedHeaderBar("thr_meta").isEmpty).toBe(true);
  });

  it("falls back to Tasks nav panel if side panel refuses openTab and omits meta when unset", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const link2 = makeLink({
      id: "01HZZZZZZZZZZZZZZZZZZZZZH2",
      taskId: TASK_2_ID,
      threadId: "thr_fallback",
    });

    const rendered = renderSlot(
      slot,
      { threadId: "thr_fallback", projectId: "proj_1", environment: null },
      {
        experimental_panel: { openTab: () => false },
        rpc: {
          listTaskThreadsByThread: () => ({ taskThreads: [link2] }),
          listTasks: listTasksFrom([task2]),
          listTaskThreads: () => ({ taskThreads: [link2] }),
        },
      },
    );

    await waitFor(() => {
      expect(getResolvedHeaderBar("thr_fallback").slots.task?.keyText).toBe("BBP-43");
    });

    const resolved = getResolvedHeaderBar("thr_fallback");
    expect(resolved.slots.meta).toBeUndefined();

    act(() => {
      resolved.slots.task?.onClick?.();
    });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/BBP-43" },
    });
  });

  it("publishes secondaryMenu for multi-task threads and switches active task", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const links = [
      makeLink({
        id: "01HZZZZZZZZZZZZZZZZZZZZZH1",
        taskId: TASK_1_ID,
        threadId: "thr_multi",
        attachedAt: "2026-07-15T00:00:00.000Z",
      }),
      makeLink({
        id: "01HZZZZZZZZZZZZZZZZZZZZZH2",
        taskId: TASK_2_ID,
        threadId: "thr_multi",
        attachedAt: "2026-07-16T00:00:00.000Z",
      }),
    ];

    renderSlot(
      slot,
      { threadId: "thr_multi", projectId: "proj_1", environment: null },
      {
        rpc: {
          listTaskThreadsByThread: () => ({ taskThreads: links }),
          listTasks: listTasksFrom([task1, task2]),
          listTaskThreads: () => ({ taskThreads: [links[0]!] }),
        },
      },
    );

    await waitFor(() => {
      expect(getResolvedHeaderBar("thr_multi").slots.task?.secondaryMenu?.triggerLabel).toBe("+1");
    });

    const menu = getResolvedHeaderBar("thr_multi").slots.task?.secondaryMenu!;
    const secondItem = menu.items.find((item) => item.id === TASK_2_ID)!;
    act(() => {
      secondItem.onSelect();
    });

    await waitFor(() => {
      expect(getResolvedHeaderBar("thr_multi").slots.task?.keyText).toBe("BBP-43");
    });
  });

  it("publishes threads dropdown at priority 20 for visible sibling worker threads", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const link1 = makeLink({ threadId: "thr_sib1" });
    const link2 = makeLink({
      id: "01HZZZZZZZZZZZZZZZZZZZZZH2",
      threadId: "thr_sib2",
      title: "Review thread",
      liveStatus: "working",
      attachedAt: "2026-07-16T00:00:00.000Z",
    });

    const rendered = renderSlot(
      slot,
      { threadId: "thr_sib1", projectId: "proj_1", environment: null },
      {
        rpc: {
          listTaskThreadsByThread: () => ({ taskThreads: [link1] }),
          listTasks: listTasksFrom([task1]),
          listTaskThreads: () => ({ taskThreads: [link1, link2] }),
        },
        sidebarThreads: {
          status: "ready",
          threads: [
            makeSidebarThread({ id: "thr_sib1", displayTitle: "Primary worker" }),
            makeSidebarThread({ id: "thr_sib2", displayTitle: "Review sibling" }),
          ],
        },
      },
    );

    await waitFor(() => {
      expect(getResolvedHeaderBar("thr_sib1").slots.threads?.menu?.triggerLabel).toBe("2 threads");
    });

    const threadsSeg = getResolvedHeaderBar("thr_sib1").slots.threads!;
    expect(threadsSeg.priority).toBe(20);
    const siblingItem = threadsSeg.menu!.items.find((item) => item.id === "thr_sib2")!;
    act(() => {
      siblingItem.onSelect();
    });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({
      method: "toThread",
      threadId: "thr_sib2",
    });
  });

  it("highlights overdue due dates on open tasks and not on done tasks", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const OVERDUE_ID = "01HZZZZZZZZZZZZZZZZZZZZZT3";
    const DONE_ID = "01HZZZZZZZZZZZZZZZZZZZZZT4";
    const overdueTask = makeTask({
      id: OVERDUE_ID,
      projectId: PROJECT_ID,
      key: "BBP-99",
      title: "Overdue item",
      status: "in_progress",
      priority: "urgent",
      dueDate: "2020-01-01",
    });
    const doneTask = makeTask({
      id: DONE_ID,
      projectId: PROJECT_ID,
      key: "BBP-100",
      title: "Done item",
      status: "done",
      priority: "none",
      dueDate: "2020-01-01",
    });

    const overdueLink = makeLink({
      id: "01HZZZZZZZZZZZZZZZZZZZZZH3",
      threadId: "thr_overdue",
      taskId: OVERDUE_ID,
    });
    const doneLink = makeLink({
      id: "01HZZZZZZZZZZZZZZZZZZZZZH4",
      threadId: "thr_done",
      taskId: DONE_ID,
    });
    const sharedRpc = {
      listTaskThreadsByThread: (input: unknown) => {
        const { threadId } = rpcInput(input);
        return { taskThreads: threadId === "thr_overdue" ? [overdueLink] : [doneLink] };
      },
      listTasks: listTasksFrom([overdueTask, doneTask]),
      listTaskThreads: () => ({ taskThreads: [] }),
    };

    renderSlot(
      slot,
      { threadId: "thr_overdue", projectId: "proj_1", environment: null },
      { rpc: sharedRpc },
    );
    renderSlot(
      slot,
      { threadId: "thr_done", projectId: "proj_1", environment: null },
      { rpc: sharedRpc },
    );

    await waitFor(() => {
      expect(getResolvedHeaderBar("thr_overdue").slots.meta?.tone).toBe("warning");
      expect(getResolvedHeaderBar("thr_done").slots.meta?.tone).toBe("muted");
    });
  });

  it("reuses cached listTaskThreadsByThread on A -> B -> A revisit within staleTime", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const listTaskThreadsByThread = vi.fn(() => ({ taskThreads: [] }));
    const rpc = {
      listTaskThreadsByThread,
      listTasks: () => ({ tasks: [] }),
      listTaskThreads: () => ({ taskThreads: [] }),
    };

    const firstA = renderSlot(
      slot,
      { threadId: "thr_a", projectId: "proj_1", environment: null },
      { rpc },
    );
    await waitFor(() => expect(listTaskThreadsByThread).toHaveBeenCalledTimes(1));
    firstA.unmount();

    const visitB = renderSlot(
      slot,
      { threadId: "thr_b", projectId: "proj_1", environment: null },
      { rpc },
    );
    await waitFor(() => expect(listTaskThreadsByThread).toHaveBeenCalledTimes(2));
    visitB.unmount();

    const secondA = renderSlot(
      slot,
      { threadId: "thr_a", projectId: "proj_1", environment: null },
      { rpc },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listTaskThreadsByThread).toHaveBeenCalledTimes(2);
    secondA.unmount();
  });

  it("does not re-render unlinked or single-thread tasks when sidebar threads update", async () => {
    const slot = app.threadHeaderRows.find((entry) => entry.id === "linked-task")!;
    const listTaskThreadsByThread = vi.fn(() => ({ taskThreads: [] }));
    const rendered = renderSlot(
      slot,
      { threadId: "thr_plain", projectId: "proj_1", environment: null },
      {
        rpc: {
          listTaskThreadsByThread,
          listTasks: () => ({ tasks: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
        },
        sidebarThreads: {
          status: "ready",
          threads: [makeSidebarThread({ id: "thr_plain", displayTitle: "Plain" })],
        },
      },
    );

    await waitFor(() => expect(listTaskThreadsByThread).toHaveBeenCalledTimes(1));
    expect(getResolvedHeaderBar("thr_plain").isEmpty).toBe(true);
    expect(rendered.container.innerHTML).toBe("");
  });
});
