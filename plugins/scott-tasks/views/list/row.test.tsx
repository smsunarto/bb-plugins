// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMPACT_VIEWPORT_QUERY } from "@/components/ui/hooks/use-compact-viewport";
import type { Project, Task, TaskMutationResult, TaskThread } from "../../shared/contract.js";
import { resetTasksCollectionsForTest } from "../../shell/collections.js";
import { LIST_PREFERENCE_STORAGE_KEY } from "./list-preference.js";
import { makeTask, rpcInput } from "../../test-fixtures.js";

const resizeListeners = new Set<{
  target: Element;
  callback: ResizeObserverCallback;
}>();

function emitResize(target: Element, inlineSize: number) {
  for (const listener of resizeListeners) {
    if (listener.target !== target) continue;
    listener.callback(
      [
        {
          target,
          borderBoxSize: [{ inlineSize, blockSize: 0 }],
          contentRect: { width: inlineSize, height: 0 },
        } as unknown as ResizeObserverEntry,
      ],
      {} as ResizeObserver,
    );
  }
}

window.matchMedia = (query: string) => ({
  matches: query === COMPACT_VIEWPORT_QUERY,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
window.ResizeObserver = class {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    resizeListeners.add({ target, callback: this.callback });
  }
  unobserve(target: Element) {
    for (const listener of resizeListeners) {
      if (listener.target === target && listener.callback === this.callback) {
        resizeListeners.delete(listener);
      }
    }
  }
  disconnect() {
    for (const listener of resizeListeners) {
      if (listener.callback === this.callback) resizeListeners.delete(listener);
    }
  }
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));

afterEach(async () => {
  cleanup();
  await resetTasksCollectionsForTest();
  resizeListeners.clear();
  window.localStorage.clear();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const label = {
  id: "01HZZZZZZZZZZZZZZZZZZZZLBL",
  projectId: PROJECT_ID,
  name: "Bug",
  color: "#e5484d",
};

function task(overrides: Partial<Task> & Pick<Task, "id" | "number">): Task {
  return makeTask({
    projectId: PROJECT_ID,
    key: `TSK-${overrides.number}`,
    title: `Task ${overrides.number}`,
    position: overrides.number,
    ...overrides,
  });
}

interface Options {
  subPath?: string;
  updateTask?: (input: Record<string, unknown>) => TaskMutationResult;
  projects?: Project[];
  moveTaskToProject?: (input: Record<string, unknown>) => TaskMutationResult;
  listTasks?: (input: Record<string, unknown>) => Promise<{ tasks: Task[] }> | { tasks: Task[] };
  activeThreads?: TaskThread[];
}

function renderList(tasks: Task[], options: Options = {}) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: options.subPath ?? PROJECT_ID },
    {
      rpc: {
        listProjects: () => ({ projects: options.projects ?? [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: [label] }),
        listTasks: (raw) => {
          const input = rpcInput(raw);
          if (options.listTasks) return options.listTasks(input);
          let matched = tasks;
          if (Array.isArray(input.taskIds)) {
            const ids = new Set(input.taskIds as string[]);
            matched = matched.filter((item) => ids.has(item.id));
          }
          if ("parentTaskId" in input) {
            matched = matched.filter((item) => item.parentTaskId === input.parentTaskId);
          }
          if (Array.isArray(input.statuses) && input.statuses.length > 0) {
            const allowed = new Set(input.statuses);
            matched = matched.filter((item) => allowed.has(item.status));
          }
          return { tasks: matched };
        },
        listActiveTaskThreads: () => ({ taskThreads: options.activeThreads ?? [] }),
        listTaskThreads: () => ({ taskThreads: [] }),
        listComments: () => ({ comments: [] }),
        listAttachments: () => ({ attachments: [] }),
        updateTask: (raw) => {
          const input = rpcInput(raw);
          if (options.updateTask) return options.updateTask(input);
          const current = tasks.find((entry) => entry.id === input.taskId)!;
          return { ok: true, task: { ...current, ...input } };
        },
        moveTaskToProject: (raw) => {
          if (!options.moveTaskToProject) throw new Error("Unexpected move");
          return options.moveTaskToProject(rpcInput(raw));
        },
      },
    },
  );
}

async function rowFor(slot: ReturnType<typeof renderList>, key: string) {
  await slot.findByText(key);
  const row = slot.container.querySelector(`[data-task-key="${key}"]`);
  if (row === null) throw new Error(`row ${key} not found`);
  return row as HTMLElement;
}

describe("inline row editing", () => {
  it("moves a row to another project through its context menu", async () => {
    const current = task({ id: "01HZT1", number: 1 });
    const target = {
      ...project,
      id: "01HZZZZZZZZZZZZZZZZZZZZZP2",
      name: "Personal",
      prefix: "HOME",
    };
    const slot = renderList([current], {
      projects: [project, target],
      moveTaskToProject: () => ({
        ok: true,
        task: { ...current, projectId: target.id, key: "HOME-5", number: 5 },
      }),
    });
    const row = await rowFor(slot, "TSK-1");
    fireEvent.contextMenu(row);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Personal/ }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "moveTaskToProject",
        input: { taskId: current.id, projectId: target.id },
      }),
    );
  });

  it("optimistically applies a status change and persists it", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1 })]);
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Change status, currently Todo/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Change status" });
    fireEvent.click(await within(drawer).findByRole("menuitem", { name: /Done/ }));

    await waitFor(() =>
      expect(
        slot.rpcCalls.some(
          (call) =>
            call.method === "updateTask" && (call.input as { status?: string }).status === "done",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(slot.container.querySelector('[data-task-key="TSK-1"]')!).getByRole("button", {
          name: /Change status, currently Done/,
        }),
      ).toBeTruthy(),
    );
  });

  it("optimistically applies a priority change", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1 })]);
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Set priority, currently No priority/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Set priority" });
    fireEvent.click(await within(drawer).findByRole("menuitem", { name: /Urgent/ }));

    await waitFor(() =>
      expect(
        slot.rpcCalls.some(
          (call) =>
            call.method === "updateTask" &&
            (call.input as { priority?: string }).priority === "urgent",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(slot.container.querySelector('[data-task-key="TSK-1"]')!).getByRole("button", {
          name: /currently Urgent/,
        }),
      ).toBeTruthy(),
    );
  });

  it("rolls back and surfaces an error when the mutation fails", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1 })], {
      updateTask: () => ({
        ok: false,
        error: { code: "task_parent_invalid", message: "Server rejected it" },
      }),
    });
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Change status, currently Todo/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Change status" });
    fireEvent.click(await within(drawer).findByRole("menuitem", { name: /Done/ }));

    await slot.findByText("Server rejected it");
    await waitFor(() =>
      expect(
        within(slot.container.querySelector('[data-task-key="TSK-1"]')!).getByRole("button", {
          name: /Change status, currently Todo/,
        }),
      ).toBeTruthy(),
    );
  });

  it("only issues a mutation when the value actually changes", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1, status: "todo" })]);
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Change status, currently Todo/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Change status" });
    fireEvent.click(await within(drawer).findByRole("menuitem", { name: /Todo/ }));

    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.rpcCalls.some((call) => call.method === "updateTask")).toBe(false);
  });
});

describe("list search and key column", () => {
  it("filters rows by key or title from the search box", async () => {
    const slot = renderList([
      task({ id: "01HZT1ZZZZZZZZZZZZZZZZZZT1", number: 1, title: "Fix login" }),
      task({ id: "01HZT2ZZZZZZZZZZZZZZZZZZT2", number: 2, title: "Ship docs" }),
    ]);
    await rowFor(slot, "TSK-1");
    const search = slot.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "LOGIN" } });
    await waitFor(() => expect(slot.queryByText("TSK-2")).toBeNull());
    expect(slot.getByText("TSK-1")).toBeTruthy();
    fireEvent.change(search, { target: { value: "tsk-2" } });
    await waitFor(() => expect(slot.queryByText("TSK-1")).toBeNull());
    fireEvent.keyDown(search, { key: "Escape" });
    await slot.findByText("TSK-1");
    expect(slot.getByText("TSK-2")).toBeTruthy();
  });

  it("sizes the key column from the widest key per prefix across all loaded tasks", async () => {
    const slot = renderList([
      task({
        id: "01HZT1ZZZZZZZZZZZZZZZZZZT1",
        number: 223,
        key: "AGENTS-223",
      }),
      task({ id: "01HZT2ZZZZZZZZZZZZZZZZZZT2", number: 9, key: "AGENTS-9" }),
      task({ id: "01HZT3ZZZZZZZZZZZZZZZZZZT3", number: 1, key: "OPS-1" }),
    ]);
    const sizedKeys = () =>
      Array.from(
        slot.container.querySelectorAll<HTMLElement>("[data-key-sizer]"),
        (element) => element.dataset.keySizer,
      ).sort();
    const keyCell = await slot.findByText("AGENTS-223");
    expect(keyCell.title).toBe("AGENTS-223");
    expect(sizedKeys()).toEqual(["AGENTS-223", "OPS-1"]);

    const sizer = slot.container.querySelector<HTMLElement>("[data-key-sizer]")!.parentElement!;
    const scope = sizer.parentElement!;
    act(() => emitResize(sizer, 91.2));
    expect(scope.style.getPropertyValue("--task-key-width")).toBe("92px");

    const search = slot.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "ops" } });
    await waitFor(() => expect(slot.queryByText("AGENTS-223")).toBeNull());
    expect(sizedKeys()).toEqual(["AGENTS-223", "OPS-1"]);
  });

  it("shows Clear in the visible toolbar when searching without opening Filter", async () => {
    const slot = renderList([
      task({ id: "01HZT1ZZZZZZZZZZZZZZZZZZT1", number: 1, title: "Fix login" }),
      task({ id: "01HZT2ZZZZZZZZZZZZZZZZZZT2", number: 2, title: "Ship docs" }),
    ]);
    await rowFor(slot, "TSK-1");
    expect(slot.queryByRole("button", { name: /^Clear$/ })).toBeNull();
    const search = slot.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "docs" } });
    await waitFor(() => expect(slot.queryByText("TSK-1")).toBeNull());
    const clearButton = slot.getByRole("button", { name: /^Clear$/ });
    fireEvent.click(clearButton);
    await slot.findByText("TSK-1");
    expect(slot.queryByRole("button", { name: /^Clear$/ })).toBeNull();
  });
});

describe("sub-task nesting", () => {
  const parent = task({
    id: "01HZT1ZZZZZZZZZZZZZZZZZZT1",
    number: 1,
    title: "Parent",
  });
  const child = task({
    id: "01HZT1ZZZZZZZZZZZZZZZZZZT2",
    number: 12,
    parentTaskId: parent.id,
    status: "done",
    title: "Needle",
  });
  const toggle = (row: HTMLElement, name: RegExp) =>
    within(row).getByRole<HTMLButtonElement>("button", { name });
  const childRow = (slot: ReturnType<typeof renderList>) =>
    slot.container.querySelector(`[data-task-key="${child.key}"]`);

  it("starts collapsed and remembers a parent the user expanded", async () => {
    const slot = renderList([parent, child]);
    const row = await rowFor(slot, parent.key);
    expect(within(row).getByText("1/1")).toBeTruthy();
    expect(childRow(slot)).toBeNull();
    fireEvent.click(toggle(row, /Expand sub-tasks/));
    expect((await rowFor(slot, child.key)).dataset.child).toBe("true");
    cleanup();

    const reopened = renderList([parent, child]);
    const reopenedRow = await rowFor(reopened, parent.key);
    expect(await rowFor(reopened, child.key)).toBeTruthy();
    fireEvent.click(toggle(reopenedRow, /Collapse sub-tasks/));
    await waitFor(() => expect(childRow(reopened)).toBeNull());
  });

  it("opens a collapsed parent while searching without changing its saved state", async () => {
    const slot = renderList([parent, child]);
    await rowFor(slot, parent.key);
    expect(childRow(slot)).toBeNull();
    const search = slot.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "needle" } });
    await rowFor(slot, child.key);
    const parentRow = await rowFor(slot, parent.key);
    expect(parentRow.dataset.muted).toBe("true");
    expect(slot.getByText("1 task")).toBeTruthy();
    const locked = toggle(parentRow, /Collapse sub-tasks/);
    expect(locked.disabled).toBe(true);
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(childRow(slot)).toBeNull());
  });

  it("locks an already-expanded parent during search and preserves its saved state", async () => {
    const slot = renderList([parent, child]);
    const row = await rowFor(slot, parent.key);
    fireEvent.click(toggle(row, /Expand sub-tasks/));
    await rowFor(slot, child.key);

    const search = slot.getByRole("searchbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "needle" } });
    const parentRow = await rowFor(slot, parent.key);
    const locked = toggle(parentRow, /Collapse sub-tasks/);
    expect(locked.disabled).toBe(true);
    fireEvent.click(locked);

    fireEvent.change(search, { target: { value: "" } });
    expect(await rowFor(slot, child.key)).toBeTruthy();
  });

  it("moves focus to the next row when ArrowDown is pressed from a sub-task toggle", async () => {
    const first = task({
      id: "01HZT0ZZZZZZZZZZZZZZZZZZT0",
      number: 0,
      title: "First",
      position: 0,
    });
    const slot = renderList([first, parent, child]);
    const parentRow = await rowFor(slot, parent.key);
    const expandButton = toggle(parentRow, /Expand sub-tasks/);
    fireEvent.click(expandButton);
    await rowFor(slot, child.key);
    const collapseButton = toggle(await rowFor(slot, parent.key), /Collapse sub-tasks/);
    collapseButton.focus();
    fireEvent.keyDown(collapseButton, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      slot.getByRole("button", { name: new RegExp(`Open ${child.key}`) }),
    );
  });

  it("drops bulk selection for tasks hidden by search or collapsed under a parent", async () => {
    const updateTask = vi.fn((input: Record<string, unknown>) => ({
      ok: true as const,
      task: { ...parent, ...input },
    }));
    const other = task({ id: "01HZT3ZZZZZZZZZZZZZZZZZZT3", number: 3, title: "Ship docs" });
    const slot = renderList([parent, child, other], { updateTask });
    await rowFor(slot, parent.key);

    fireEvent.click(slot.getByRole("checkbox", { name: `Select ${parent.key}` }));
    expect(slot.getByText("1 selected")).toBeTruthy();
    fireEvent.change(slot.getByRole("searchbox", { name: "Search tasks" }), {
      target: { value: "docs" },
    });
    await waitFor(() => expect(slot.queryByText(/selected$/)).toBeNull());
    fireEvent.change(slot.getByRole("searchbox", { name: "Search tasks" }), {
      target: { value: "" },
    });

    const parentRow = await rowFor(slot, parent.key);
    fireEvent.click(toggle(parentRow, /Expand sub-tasks/));
    await rowFor(slot, child.key);
    fireEvent.click(slot.getByRole("checkbox", { name: `Select ${child.key}` }));
    expect(slot.getByText("1 selected")).toBeTruthy();
    fireEvent.click(toggle(await rowFor(slot, parent.key), /Collapse sub-tasks/));
    await waitFor(() => expect(slot.queryByText(/selected$/)).toBeNull());
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("keeps Backlog view single-status with collapsible sub-tasks", async () => {
    const backlogParent = task({
      id: "01HZTBPZZZZZZZZZZZZZZZZZBP",
      number: 1,
      status: "backlog",
      title: "Backlog parent",
    });
    const backlogChild = task({
      id: "01HZTBCZZZZZZZZZZZZZZZZZBC",
      number: 2,
      parentTaskId: backlogParent.id,
      status: "backlog",
      title: "Backlog child",
    });
    const activeParent = task({
      id: "01HZTIPZZZZZZZZZZZZZZZZZIP",
      number: 3,
      status: "in_progress",
      title: "In progress parent",
    });
    const strayBacklogChild = task({
      id: "01HZTSBZZZZZZZZZZZZZZZZZSB",
      number: 4,
      parentTaskId: activeParent.id,
      status: "backlog",
      title: "Stray backlog child",
    });
    const slot = renderList([backlogParent, backlogChild, activeParent, strayBacklogChild], {
      subPath: `${PROJECT_ID}?scope=backlog`,
    });
    const row = await rowFor(slot, backlogParent.key);
    expect(slot.queryByText(activeParent.key)).toBeNull();
    expect(slot.queryByText(backlogChild.key)).toBeNull();
    expect(slot.getByText("1 task")).toBeTruthy();
    const expandButton = toggle(row, /Expand sub-tasks/);
    expect(expandButton.disabled).toBe(false);
    fireEvent.click(expandButton);
    expect(await rowFor(slot, backlogChild.key)).toBeTruthy();
  });

  it("does not flash an empty state while closed tasks are still loading for a closed-status filter", async () => {
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: {
          [`project:${PROJECT_ID}`]: {
            filters: { statuses: ["done"], priorities: [], labelNames: [] },
            sort: "manual",
            expandedTaskIds: [],
          },
        },
      }),
    );
    const doneTask = task({ id: "01HZTD1ZZZZZZZZZZZZZZZZZD1", number: 2, status: "done" });
    let resolveClosed!: (value: { tasks: Task[] }) => void;
    const closedPromise = new Promise<{ tasks: Task[] }>((resolve) => {
      resolveClosed = resolve;
    });
    const slot = renderList([parent, doneTask], {
      listTasks: (input) => {
        const statuses = input.statuses as string[] | undefined;
        if (statuses?.includes("done")) return closedPromise;
        return { tasks: [parent] };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByText("No tasks match these filters")).toBeNull();
    expect(slot.queryByText("0 tasks")).toBeNull();

    await act(async () => {
      resolveClosed({ tasks: [doneTask] });
      await closedPromise;
    });
    expect(await rowFor(slot, doneTask.key)).toBeTruthy();
    expect(slot.getByText("1 task")).toBeTruthy();
  });

  it("loads sub-task progress pills for active parents without scanning all projects", async () => {
    const activeParent = task({
      id: "01HZTAPZZZZZZZZZZZZZZZZZAP",
      number: 1,
      status: "in_progress",
      title: "Active parent",
    });
    const idleChildA = task({
      id: "01HZTCAZZZZZZZZZZZZZZZZZCA",
      number: 2,
      parentTaskId: activeParent.id,
      status: "todo",
      title: "Idle child A",
    });
    const idleChildB = task({
      id: "01HZTCBZZZZZZZZZZZZZZZZZCB",
      number: 3,
      parentTaskId: activeParent.id,
      status: "done",
      title: "Idle child B",
    });
    const listTasksCalls: Record<string, unknown>[] = [];
    const slot = renderList([activeParent, idleChildA, idleChildB], {
      subPath: "active",
      activeThreads: [
        {
          id: "01HZTTHZZZZZZZZZZZZZZZZZ01",
          taskId: activeParent.id,
          threadId: "thr_active_parent",
          presetName: "Worker",
          title: "Running",
          liveStatus: "working",
          attachedAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      listTasks: (input) => {
        listTasksCalls.push(input);
        if (Array.isArray(input.taskIds)) {
          const ids = new Set(input.taskIds as string[]);
          return { tasks: [activeParent, idleChildA, idleChildB].filter((t) => ids.has(t.id)) };
        }
        if (input.parentTaskId === activeParent.id) {
          return { tasks: [idleChildA, idleChildB] };
        }
        return { tasks: [] };
      },
    });
    const row = await rowFor(slot, activeParent.key);
    await waitFor(() => expect(within(row).getByText("1/2")).toBeTruthy());
    expect(listTasksCalls.some((call) => Array.isArray(call.statuses))).toBe(false);
  });

  it("sizes the key column from sub-task keys too", async () => {
    const slot = renderList([parent, child]);
    await rowFor(slot, parent.key);
    expect(
      Array.from(
        slot.container.querySelectorAll<HTMLElement>("[data-key-sizer]"),
        (element) => element.dataset.keySizer,
      ),
    ).toEqual([child.key]);
  });
});
