// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMPACT_VIEWPORT_QUERY } from "@/components/ui/hooks/use-compact-viewport";
import type { Task } from "../../shared/contract.js";
import { LIST_PREFERENCE_STORAGE_KEY } from "./list-preference.js";
import { EMPTY_FILTERS } from "./filter-bar.js";
import { listScrollScopeKey, writeListScroll } from "./scroll-restoration.js";
import { makeTask, rpcInput } from "../../test-fixtures.js";

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
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROJECT_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PROJECT_B = "01HZZZZZZZZZZZZZZZZZZZZZP2";

const projectA = {
  id: PROJECT_A,
  name: "Alpha",
  prefix: "ALP",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const projectB = {
  id: PROJECT_B,
  name: "Beta",
  prefix: "BET",
  nextTaskNumber: 5,
  color: "green",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function task(
  projectId: string,
  number: number,
  status: Task["status"],
  priority: Task["priority"] = "none",
): Task {
  const prefix = projectId === PROJECT_A ? "ALP" : "BET";
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZT${projectId.slice(-2)}${number}`,
    projectId,
    number,
    key: `${prefix}-${number}`,
    title: `Task ${number}`,
    status,
    priority,
    position: number,
  });
}

const tasksA = [
  task(PROJECT_A, 1, "todo", "none"),
  task(PROJECT_A, 2, "todo", "urgent"),
  task(PROJECT_A, 3, "done", "low"),
];

const tasksB = [task(PROJECT_B, 1, "todo"), task(PROJECT_B, 2, "in_progress")];

function applyListFilters(tasks: Task[], input: Record<string, unknown>): Task[] {
  let next = tasks;
  if ("parentTaskId" in input) {
    next = next.filter((item) => item.parentTaskId === input.parentTaskId);
  }
  if (Array.isArray(input.statuses) && input.statuses.length > 0) {
    const allowed = new Set(input.statuses);
    next = next.filter((item) => allowed.has(item.status));
  }
  if (Array.isArray(input.priorities) && input.priorities.length > 0) {
    const allowed = new Set(input.priorities);
    next = next.filter((item) => allowed.has(item.priority));
  }
  return next;
}

const LABEL_BUG = "01HZZZZZZZZZZZZZZZZZZZZLB1";
const LABEL_UX = "01HZZZZZZZZZZZZZZZZZZZZLB2";

const labelsA = [
  {
    id: LABEL_BUG,
    projectId: PROJECT_A,
    name: "Bug",
    color: "#ef4444",
  },
  {
    id: LABEL_UX,
    projectId: PROJECT_A,
    name: "UX",
    color: "#3b82f6",
  },
];

const activeTasks = [
  task(PROJECT_A, 9, "in_progress", "high"),
  task(PROJECT_B, 9, "in_progress", "high"),
];

function workingThread(item: Task) {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZH${item.id.slice(-3)}`,
    taskId: item.id,
    threadId: `thr_${item.key}`,
    presetName: "Sonnet · high",
    title: "Worker",
    liveStatus: "working" as const,
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function baseRpc(
  overrides: Record<string, unknown> = {},
  listTasksCalls: Record<string, unknown>[] = [],
) {
  return {
    listProjects: () => ({ projects: [projectA, projectB] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listLabels: (input: unknown) => {
      const { projectId } = rpcInput(input);
      return { labels: projectId === undefined || projectId === PROJECT_A ? labelsA : [] };
    },
    listActiveTaskThreads: () => ({ taskThreads: activeTasks.map(workingThread) }),
    listTasks: (raw: unknown) => {
      const input = rpcInput(raw);
      listTasksCalls.push(input);
      let tasks: Task[];
      if (Array.isArray(input.taskIds)) {
        tasks = activeTasks.filter((item) => (input.taskIds as string[]).includes(item.id));
      } else if (input.projectId === PROJECT_A) {
        tasks = tasksA.map((item, index) =>
          index === 0
            ? { ...item, labelIds: [LABEL_BUG] }
            : index === 1
              ? { ...item, labelIds: [LABEL_UX] }
              : item,
        );
      } else if (input.projectId === PROJECT_B) {
        tasks = tasksB;
      } else {
        tasks = [...tasksA, ...tasksB];
      }
      let next = applyListFilters(tasks, input);
      const labelIds = input.labelIds;
      if (Array.isArray(labelIds)) {
        if (labelIds.length === 0) next = [];
        else {
          const allowed = new Set(labelIds);
          next = next.filter((item) => item.labelIds.some((id) => allowed.has(id)));
        }
      }
      return { tasks: next };
    },
    listTaskThreads: () => ({ taskThreads: [] }),
    listComments: () => ({ comments: [] }),
    listAttachments: () => ({ attachments: [] }),
    ...overrides,
  };
}

function renderProject(projectId: string) {
  return renderSlot(app.navPanels[0]!, { subPath: projectId }, { rpc: baseRpc() });
}

async function selectSort(slot: ReturnType<typeof renderProject>, label: string) {
  fireEvent.click(slot.getByRole("button", { name: /Sort/ }));
  const drawer = await slot.findByRole("dialog", { name: "Sort tasks" });
  fireEvent.click(await within(drawer).findByRole("menuitemradio", { name: label }));
}

describe("list filter/sort preference persistence", () => {
  it("restores focus when the anchor's row mounts in a 250-task virtual list", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-task-key")) return 36;
        return this.hasAttribute("data-status-group-header") ? 32 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(450);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(9032);
    const rows = Array.from({ length: 250 }, (_, index) => task(PROJECT_A, index + 1, "todo"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_A },
      {
        rpc: baseRpc({
          listTasks: (input: unknown) => ({ tasks: applyListFilters(rows, rpcInput(input)) }),
          getTaskByKey: () => ({ task: rows[233] }),
        }),
      },
    );
    const region = slot.getByRole("region", { name: "Task list" });
    await slot.findByRole("button", { name: /Open ALP-1:/ });
    region.scrollTop = 32 + 36 * 230;
    fireEvent.scroll(region);
    const opened = await slot.findByRole("button", { name: /Open ALP-234:/ });
    fireEvent.click(opened);
    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(<Panel subPath="task/ALP-234" />);
    writeListScroll(
      listScrollScopeKey({
        projectId: PROJECT_A,
        activeOnly: false,
        filters: EMPTY_FILTERS,
        sort: "manual",
      }),
      0,
    );
    slot.lifecycle.rerender(<Panel subPath={PROJECT_A} />);
    const restored = slot.getByRole("region", { name: "Task list" });
    await waitFor(() => expect(restored.scrollTop).toBeGreaterThan(8000));
    expect(slot.queryByRole("button", { name: /Open ALP-234:/ })).toBeNull();
    fireEvent.scroll(restored);
    const restoredRow = await slot.findByRole("button", { name: /Open ALP-234:/ });
    expect(document.activeElement).toBe(restoredRow);
    fireEvent.keyDown(restoredRow, { key: "j" });
    expect(document.activeElement).toBe(slot.getByRole("button", { name: /Open ALP-235:/ }));
  });

  it("skips a queued bulk write when a later individual edit changes that task", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => task(PROJECT_A, index + 1, "todo"));
    const releases: (() => void)[] = [];
    let holdBatch = true;
    const updateTask = vi.fn(async (raw: unknown) => {
      const { taskId, status } = rpcInput(raw);
      const original = rows.find(({ id }) => id === taskId)!;
      if (status === "done" && holdBatch)
        await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true, task: { ...original, status } };
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_A },
      {
        rpc: baseRpc({
          listTasks: (input: unknown) => ({ tasks: applyListFilters(rows, rpcInput(input)) }),
          updateTask,
        }),
      },
    );
    for (const row of rows) {
      fireEvent.click(await slot.findByRole("checkbox", { name: `Select ${row.key}` }));
    }
    fireEvent.click(slot.getByRole("button", { name: "Set status" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Done" }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(4));
    try {
      const edited = slot.getByRole("button", { name: /Open ALP-5:/ });
      edited.focus();
      fireEvent.keyDown(edited, { key: "s" });
      const menu = await slot.findByRole("dialog", { name: "Change status" });
      const inProgress = await within(menu).findByRole("menuitem", { name: /In Progress/ });
      await act(async () => fireEvent.click(inProgress));
      expect(updateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: rows[4]!.id,
          status: "in_progress",
        }),
      );
    } finally {
      holdBatch = false;
      await act(async () => releases.splice(0).forEach((release) => release()));
    }
    await slot.findByText("ALP-5: Skipped because the task changed");
    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(8));
    expect(
      updateTask.mock.calls
        .map(([input]) => rpcInput(input))
        .filter(({ taskId }) => taskId === rows[4]!.id),
    ).toEqual([expect.objectContaining({ status: "in_progress" })]);
  });

  it("restores the originating list's collapsed groups, selection, and row focus", async () => {
    const slot = renderProject(PROJECT_A);
    const Panel = app.navPanels[0]!.component;
    const done = await slot.findByRole("button", { name: /Done 1/ });
    fireEvent.click(done);
    fireEvent.click(slot.getByRole("checkbox", { name: "Select ALP-2" }));
    fireEvent.click(slot.getByRole("button", { name: /Open ALP-1/ }));
    slot.lifecycle.rerender(<Panel subPath="task/ALP-1" />);
    slot.lifecycle.rerender(<Panel subPath={PROJECT_A} />);
    const opened = await slot.findByRole("button", { name: /Open ALP-1/ });
    await waitFor(() => expect(document.activeElement).toBe(opened));
    expect(slot.getByRole("button", { name: /Done 1/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(slot.queryByRole("button", { name: /Open ALP-3/ })).toBeNull();
    expect(slot.getByText("1 selected")).toBeDefined();
  });

  it("limits bulk status writes to four and reports a failure without stopping the queue", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => task(PROJECT_A, index + 1, "todo"));
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const updateTask = vi.fn(
      (input: unknown) =>
        new Promise((resolve, reject) => {
          const edited = rows.find(({ id }) => id === rpcInput(input).taskId)!;
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            if (edited.number === 1) reject(new Error("Write refused"));
            else resolve({ ok: true, task: { ...edited, status: "done" } });
          });
        }),
    );
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_A },
      {
        rpc: baseRpc({
          listTasks: (input: unknown) => ({ tasks: applyListFilters(rows, rpcInput(input)) }),
          updateTask,
        }),
      },
    );
    for (const row of rows) {
      fireEvent.click(await slot.findByRole("checkbox", { name: `Select ${row.key}` }));
    }
    fireEvent.click(slot.getByRole("button", { name: "Set status" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Done" }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(4));
    await act(async () => releases.splice(0, 4).forEach((release) => release()));
    await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(8));
    await act(async () => releases.splice(0, 4).forEach((release) => release()));
    expect(peak).toBe(4);
    await slot.findByText(/ALP-1:.*Write refused/);
  });

  it("resumes row navigation after closing a keyboard-opened property menu", async () => {
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchMedia(query),
      matches: false,
    }));
    const slot = renderProject(PROJECT_A);
    const first = await slot.findByRole("button", { name: /Open ALP-1/ });
    first.focus();
    fireEvent.keyDown(first, { key: "s" });
    const menu = await slot.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-keyshortcuts")).toBe("S"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "l" });
    const labels = await slot.findByRole("menu");
    expect(within(labels).getByRole("menuitemcheckbox", { name: "Bug" })).toBeDefined();
    fireEvent.keyDown(labels, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-keyshortcuts")).toBe("L"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(document.activeElement).toBe(slot.getByRole("button", { name: /Open ALP-2/ }));
  });

  it("discards selections when switching between project and workspace lists", async () => {
    const slot = renderProject(PROJECT_A);
    const Panel = app.navPanels[0]!.component;
    fireEvent.click(await slot.findByRole("checkbox", { name: "Select ALP-1" }));
    expect(slot.getByText("1 selected")).toBeDefined();
    slot.lifecycle.rerender(<Panel subPath={PROJECT_B} />);
    fireEvent.click(await slot.findByRole("checkbox", { name: "Select BET-1" }));
    expect(slot.getByText("1 selected")).toBeDefined();
    slot.lifecycle.rerender(<Panel subPath="all" />);
    await slot.findByRole("button", { name: /Open ALP-1/ });
    expect(slot.queryByText(/selected$/)).toBeNull();
    for (const key of ["ALP-1", "BET-1"]) {
      expect(
        slot.getByRole("checkbox", { name: `Select ${key}` }).getAttribute("aria-checked"),
      ).toBe("false");
    }
  });

  it("isolates project Active filters from other projects and workspace Active", async () => {
    const slot = renderProject(PROJECT_A + "?scope=active");
    const Panel = app.navPanels[0]!.component;
    await slot.findByText("ALP-9");
    fireEvent.click(slot.getByRole("button", { name: "Filter" }));
    fireEvent.click(slot.getByRole("button", { name: /^Priority/ }));
    fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: /Urgent/ }));
    pageKeyboardEscape(slot);
    await slot.findByText("No tasks match these filters");
    slot.lifecycle.rerender(<Panel subPath={PROJECT_B + "?scope=active"} />);
    await slot.findByText("BET-9");
    slot.lifecycle.rerender(<Panel subPath="active" />);
    await slot.findByText("ALP-9");
    await slot.findByText("BET-9");
    slot.lifecycle.rerender(<Panel subPath={PROJECT_A + "?scope=active"} />);
    await slot.findByText("No tasks match these filters");
  });

  // get-bb/bb#7056: one list instance serves All, Active, and every project.
  it("shows cached lists across project, all, and active navigation", async () => {
    const registration = app.navPanels[0]!;
    const Component = registration.component;
    const rpc = baseRpc();
    let suspendReads = false;
    const pendingForever = () => new Promise<never>(() => {});
    const slot = renderSlot(
      registration,
      { subPath: "all" },
      {
        rpc: {
          ...rpc,
          listTasks: (raw: unknown) => (suspendReads ? pendingForever() : rpc.listTasks(raw)),
          listActiveTaskThreads: () =>
            suspendReads ? pendingForever() : rpc.listActiveTaskThreads(),
        },
      },
    );
    await slot.findByText("BET-1");
    slot.lifecycle.rerender(<Component subPath="active" />);
    await slot.findByText("ALP-9");
    slot.lifecycle.rerender(<Component subPath={PROJECT_B} />);
    await slot.findByText("BET-1");
    slot.lifecycle.rerender(<Component subPath={PROJECT_A} />);
    await slot.findByText("ALP-1");

    // All keeps every task the shared collection holds, so it has no absent row here.
    suspendReads = true;
    for (const [subPath, visible, absent] of [
      ["all", "BET-1", null],
      ["active", "ALP-9", "ALP-1"],
      ["all", "BET-1", null],
      [PROJECT_B, "BET-1", "ALP-1"],
      [PROJECT_A, "ALP-1", "BET-1"],
    ] as const) {
      slot.lifecycle.rerender(<Component subPath={subPath} />);
      await slot.findByText(visible);
      if (absent !== null) expect(slot.queryByText(absent)).toBeNull();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "hides the old scope while a destination request is pending and can %s",
    async (outcome) => {
      const registration = app.navPanels[0]!;
      const Component = registration.component;
      let resolveThreads!: (value: { taskThreads: unknown[] }) => void;
      let rejectThreads!: (error: Error) => void;
      const pending = new Promise<{ taskThreads: unknown[] }>((resolve, reject) => {
        resolveThreads = resolve;
        rejectThreads = reject;
      });
      const rpc = baseRpc();
      const slot = renderSlot(
        registration,
        { subPath: PROJECT_A },
        { rpc: { ...rpc, listActiveTaskThreads: () => pending } },
      );
      await slot.findByText("ALP-1");
      slot.lifecycle.rerender(<Component subPath="active" />);
      await waitFor(() => expect(slot.queryByText("ALP-1")).toBeNull());
      expect(slot.queryByText("ALP-9")).toBeNull();
      expect(slot.queryByText("Couldn't load tasks")).toBeNull();

      if (outcome === "resolve") {
        resolveThreads({ taskThreads: [workingThread(activeTasks[0]!)] });
        await slot.findByText("ALP-9");
      } else {
        rejectThreads(new Error("Destination request failed"));
        await slot.findByText("Destination request failed");
      }
      expect(slot.queryByText("ALP-1")).toBeNull();
    },
  );

  it("restores sort and filters after unmount (navigation / remount)", async () => {
    const registration = app.navPanels[0]!;
    const slot = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await slot.findByText("ALP-1");

    await selectSort(slot, "Priority");
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority"),
    );

    fireEvent.click(slot.getByRole("button", { name: "Filter" }));
    fireEvent.click(slot.getByRole("button", { name: /^Status/ }));
    const doneOption = await slot.findByRole("menuitemcheckbox", {
      name: /Done/,
    });
    fireEvent.click(doneOption);

    await waitFor(() => {
      expect(window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY)).not.toBeNull();
    });

    slot.lifecycle.unmount();

    const remounted = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await remounted.findByText("ALP-3");
    expect(remounted.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority");
    expect(remounted.getByRole("button", { name: /^Status/ }).textContent).toContain("Done");
    expect(remounted.queryByText("ALP-1")).toBeNull();
    expect(remounted.queryByText("ALP-2")).toBeNull();
    expect(remounted.getByText("ALP-3")).toBeDefined();
  });

  it("keeps project A and project B preferences independent", async () => {
    const registration = app.navPanels[0]!;
    const slotA = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await slotA.findByText("ALP-1");
    await selectSort(slotA, "Priority");
    await waitFor(() =>
      expect(slotA.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority"),
    );
    slotA.lifecycle.unmount();

    const slotB = renderSlot(registration, { subPath: PROJECT_B }, { rpc: baseRpc() });
    await slotB.findByText("BET-1");
    expect(slotB.getByRole("button", { name: /Sort/ }).textContent).not.toContain("Priority");
    await selectSort(slotB, "Due date");
    await waitFor(() =>
      expect(slotB.getByRole("button", { name: /Sort/ }).textContent).toContain("Due date"),
    );
    slotB.lifecycle.unmount();

    const backToA = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await backToA.findByText("ALP-1");
    expect(backToA.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority");
    expect(backToA.getByRole("button", { name: /Sort/ }).textContent).not.toContain("Due date");
  });

  it("reads the next scope's preference when the panel switches projects in place", async () => {
    const registration = app.navPanels[0]!;
    const Panel = registration.component;
    const slot = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await slot.findByText("ALP-1");
    await selectSort(slot, "Priority");
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority"),
    );

    slot.lifecycle.rerender(<Panel subPath={PROJECT_B} />);
    await slot.findByText("BET-1");
    expect(slot.getByRole("button", { name: /Sort/ }).textContent).not.toContain("Priority");

    slot.lifecycle.rerender(<Panel subPath={PROJECT_A} />);
    await slot.findByText("ALP-1");
    expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority");
    slot.lifecycle.unmount();
  });

  it("remembers an explicit clear across remount", async () => {
    const registration = app.navPanels[0]!;
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: {
          [`project:${PROJECT_A}`]: {
            filters: {
              statuses: ["done"],
              priorities: [],
              labelNames: [],
            },
            sort: "priority",
          },
        },
      }),
    );

    const slot = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await slot.findByText("ALP-3");
    fireEvent.click(slot.getByRole("button", { name: /Clear/ }));
    await waitFor(() => {
      expect(slot.queryByText("ALP-1")).not.toBeNull();
    });
    expect(slot.queryByRole("button", { name: /Clear/ })).toBeNull();

    slot.lifecycle.unmount();
    const remounted = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await remounted.findByText("ALP-1");
    expect(remounted.queryByRole("button", { name: /Clear/ })).toBeNull();
    expect(remounted.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority");
    expect(remounted.getByText("ALP-2")).toBeDefined();
  });

  it("keeps filtering usable when storage rejects writes", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    const slot = renderProject(PROJECT_A);
    await slot.findByText("ALP-1");
    await selectSort(slot, "Priority");
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain("Priority"),
    );
    expect(slot.getByText("ALP-2")).toBeDefined();
  });

  it("isolates All tasks preference from Active", async () => {
    const registration = app.navPanels[0]!;
    const allSlot = renderSlot(registration, { subPath: "all" }, { rpc: baseRpc() });
    await allSlot.findByText("ALP-1");
    await selectSort(allSlot, "Priority");
    allSlot.lifecycle.unmount();

    const activeSlot = renderSlot(registration, { subPath: "active" }, { rpc: baseRpc() });
    await activeSlot.findByText("ALP-9");
    expect(activeSlot.getByRole("button", { name: /Sort/ }).textContent).not.toContain("Priority");
  });

  it("persists priority and label filters and filters the list with them", async () => {
    const registration = app.navPanels[0]!;
    const rpc = baseRpc();
    const slot = renderSlot(registration, { subPath: PROJECT_A }, { rpc });
    await slot.findByText("ALP-1");

    fireEvent.click(slot.getByRole("button", { name: "Filter" }));
    fireEvent.click(slot.getByRole("button", { name: /^Priority/ }));
    fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: /Urgent/ }));
    pageKeyboardEscape(slot);

    await waitFor(() => expect(slot.queryByText("ALP-1")).toBeNull());
    expect(slot.getByText("ALP-2")).toBeTruthy();
    await waitFor(() => expect(slot.queryByText("ALP-3")).toBeNull());

    fireEvent.click(slot.getByRole("button", { name: /^Label/ }));
    fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: /Bug/ }));
    pageKeyboardEscape(slot);

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY)!);
      expect(stored.scopes[`project:${PROJECT_A}`].filters.priorities).toEqual(["urgent"]);
      expect(stored.scopes[`project:${PROJECT_A}`].filters.labelNames).toEqual(["Bug"]);
    });

    await waitFor(() => expect(slot.queryByText("ALP-2")).toBeNull());

    slot.lifecycle.unmount();
    const remounted = renderSlot(registration, { subPath: PROJECT_A }, { rpc: baseRpc() });
    await remounted.findByRole("button", { name: /Priority/ });
    expect(remounted.getByRole("button", { name: /^Priority/ }).textContent).toContain("Urgent");
    expect(remounted.getByRole("button", { name: /^Label/ }).textContent).toContain("Bug");
  });

  it("matches nothing for stale label names once the catalog is loaded", async () => {
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: {
          [`project:${PROJECT_A}`]: {
            filters: {
              statuses: [],
              priorities: [],
              labelNames: ["DeletedLabel"],
            },
            sort: "manual",
          },
        },
      }),
    );
    const rpc = baseRpc();
    const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_A }, { rpc });
    await slot.findByRole("button", { name: /^Label/ });
    expect(slot.getByRole("button", { name: /^Label/ }).textContent).toContain("DeletedLabel");
    await slot.findByText("No tasks match these filters");
    expect(slot.queryByText("ALP-1")).toBeNull();
    expect(slot.queryByText("ALP-2")).toBeNull();
  });
});

function pageKeyboardEscape(slot: ReturnType<typeof renderProject>): void {
  fireEvent.keyDown(slot.container.ownerDocument, { key: "Escape" });
}
