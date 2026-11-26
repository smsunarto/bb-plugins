// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Label, Task, TaskThread } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";

window.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
Element.prototype.scrollIntoView ??= () => {};
if (typeof window.PointerEvent === "undefined") {
  class JsdomPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = JsdomPointerEvent as unknown as typeof PointerEvent;
}

function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: PointerEventInit,
) {
  act(() => {
    target.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  });
}

const app = await loadPluginApp(() => import("../../app"));
const { resetTasksCollectionsForTest } = await import("../../shell/collections.js");

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const project = {
  id: PROJECT_ID,
  name: "Board Test",
  prefix: "BRD",
  nextTaskNumber: 10,
  color: "#88c0d0",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const makeLabels = (count: number): Label[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `01HZZZZZZZZZZZZZZZZZZZZL${String(index).padStart(2, "0")}`,
    projectId: PROJECT_ID,
    name: `label-${index + 1}`,
    color: "#88c0d0",
  }));

const taskA: Task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT1",
  projectId: PROJECT_ID,
  number: 1,
  key: "BRD-1",
  title: "First backlog task",
  status: "backlog",
  priority: "high",
  position: 1,
});

const taskB: Task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT2",
  projectId: PROJECT_ID,
  number: 2,
  key: "BRD-2",
  title: "Second backlog task",
  status: "backlog",
  priority: "none",
  position: 2,
});

const taskC: Task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT3",
  projectId: PROJECT_ID,
  number: 3,
  key: "BRD-3",
  title: "Todo column task",
  status: "todo",
  priority: "urgent",
  position: 1,
});

function renderBoard(overrides: Record<string, unknown> = {}) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: `${PROJECT_ID}?view=board` },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: [] }),
        listTasks: () => ({ tasks: [taskA, taskB, taskC], nextCursor: null }),
        countTaskAttachments: () => ({ counts: [] }),
        listActiveTaskThreads: () => ({ taskThreads: [] }),
        boardMove: (rawInput: unknown) => {
          const input = rawInput as { taskId: string; status: Task["status"] };
          const base = [taskA, taskB, taskC].find((t) => t.id === input.taskId) ?? taskA;
          return {
            ok: true,
            task: { ...base, status: input.status, updatedAt: "2026-07-16T00:00:00.000Z" },
          };
        },
        ...overrides,
      },
    },
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await resetTasksCollectionsForTest();
  vi.restoreAllMocks();
});

describe("BoardView", () => {
  it("renders semantic column sections, headings, list roles, and hides empty Canceled", async () => {
    const slot = renderBoard();
    await slot.findByText("First backlog task");

    const headings = slot.getAllByRole("heading", { level: 2 }).map((el) => el.textContent);
    expect(headings).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done"]);

    const backlogList = slot.getByRole("list", { name: "Backlog, 2 tasks" });
    expect(within(backlogList).getAllByRole("listitem")).toHaveLength(2);

    const todoList = slot.getByRole("list", { name: "Todo, 1 task" });
    expect(within(todoList).getAllByRole("listitem")).toHaveLength(1);

    const doneList = slot.getByRole("list", { name: "Done, 0 tasks" });
    expect(within(doneList).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("caps card labels to 3 with a +N overflow badge and exposes full metadata via aria-describedby", async () => {
    const labels = makeLabels(6);
    const heavyTask: Task = {
      ...taskA,
      labelIds: labels.map((label) => label.id),
    };
    const subDone: Task = makeTask({
      id: "01HZZZZZZZZZZZZZZZZZZZZZS1",
      projectId: PROJECT_ID,
      number: 4,
      key: "BRD-4",
      title: "Subtask done",
      status: "done",
      parentTaskId: heavyTask.id,
      position: 1,
    });
    const subOpen: Task = makeTask({
      id: "01HZZZZZZZZZZZZZZZZZZZZZS2",
      projectId: PROJECT_ID,
      number: 5,
      key: "BRD-5",
      title: "Subtask open",
      status: "todo",
      parentTaskId: heavyTask.id,
      position: 2,
    });
    const worker: TaskThread = {
      id: "01HZZZZZZZZZZZZZZZZZZZZZH1",
      taskId: heavyTask.id,
      threadId: "thr_W1",
      presetName: "Implementer",
      title: "Implementer",
      liveStatus: "working",
      attachedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };

    const slot = renderBoard({
      listLabels: () => ({ labels }),
      listTasks: () => ({ tasks: [heavyTask, subDone, subOpen], nextCursor: null }),
      countTaskAttachments: () => ({ counts: [{ taskId: heavyTask.id, count: 1 }] }),
      listActiveTaskThreads: () => ({ taskThreads: [worker] }),
    });

    const card = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    expect(within(card).getByText("label-1")).toBeDefined();
    expect(within(card).getByText("label-3")).toBeDefined();
    expect(within(card).queryByText("label-4")).toBeNull();
    const overflow = within(card).getByText("+3");
    expect(overflow.getAttribute("title")).toBe("label-4, label-5, label-6");
    expect(within(card).getByText("1/2")).toBeDefined();
    expect(within(card).getByText("1")).toBeDefined();
    expect(within(card).getByText("Implementer")).toBeDefined();

    // Respects prefers-reduced-motion via StatusDot pulse variant
    const dot = card.querySelector('[data-slot="status-dot"]');
    expect(dot?.className).toContain("motion-reduce:animate-none");

    // Full metadata exposed via aria-describedby (including singular "1 attachment")
    const describedBy = card.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const descEl = document.getElementById(describedBy!);
    expect(descEl?.textContent).toContain("High priority");
    expect(descEl?.textContent).toContain("Agent working");
    expect(descEl?.textContent).toContain("1 of 2 sub-tasks done");
    expect(descEl?.textContent).toContain("1 attachment");
    expect(descEl?.textContent).not.toContain("1 attachments");
  });

  it("omits the metadata footer on bare cards and wraps unbreakable titles with dir=auto", async () => {
    const bareTask: Task = {
      ...taskB,
      title: "https://example.com/very_long_unbreakable_identifier_1234567890",
    };
    const slot = renderBoard({
      listTasks: () => ({ tasks: [bareTask], nextCursor: null }),
    });

    const card = await slot.findByRole("button", {
      name: `Open BRD-2: ${bareTask.title}`,
    });
    const titleEl = within(card).getByText(bareTask.title);
    expect(titleEl.getAttribute("dir")).toBe("auto");
    expect(titleEl.className).toContain("wrap-anywhere");
    expect(card.getAttribute("aria-describedby")).toBeNull();
    // Only header span + title span (no empty footer span)
    expect(card.children).toHaveLength(2);
  });

  it("opens a task when clicking a card and supports arrow-key navigation across cards and columns", async () => {
    const slot = renderBoard();
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    const card2 = slot.getByRole("button", { name: "Open BRD-2: Second backlog task" });
    const card3 = slot.getByRole("button", { name: "Open BRD-3: Todo column task" });

    card1.focus();
    fireEvent.keyDown(card1, { key: "ArrowDown" });
    expect(document.activeElement).toBe(card2);

    fireEvent.keyDown(card2, { key: "ArrowRight" });
    expect(document.activeElement).toBe(card3);

    fireEvent.keyDown(card3, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card1);

    fireEvent.click(card3);
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/BRD-3" },
    });
  });

  it("moves cards across columns with Alt+ArrowRight and announces the move", async () => {
    const boardMove = vi.fn((rawInput: unknown) => {
      const input = rawInput as { taskId: string; status: Task["status"] };
      return {
        ok: true,
        task: { ...taskA, status: input.status, updatedAt: "2026-07-16T00:00:00.000Z" },
      };
    });
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });

    card1.focus();
    fireEvent.keyDown(card1, { key: "ArrowRight", altKey: true });

    await waitFor(() =>
      expect(boardMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: taskA.id, status: "todo" }),
      ),
    );
    expect(slot.getByRole("status").textContent).toBe("Moved BRD-1 to Todo");
  });

  it("surfaces a toast error when a boardMove mutation is refused", async () => {
    const slot = renderBoard({
      boardMove: () => ({
        ok: false,
        error: { code: "task_parent_invalid", message: "Move rejected by server" },
      }),
    });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });

    card1.focus();
    fireEvent.keyDown(card1, { key: "ArrowRight", altKey: true });

    await slot.findByText("Move rejected by server");
  });

  it("drags a card across columns and cancels an active pointer drag on Escape", async () => {
    const boardMove = vi.fn((rawInput: unknown) => {
      const input = rawInput as { taskId: string; status: Task["status"] };
      return {
        ok: true,
        task: { ...taskA, status: input.status, updatedAt: "2026-07-16T00:00:00.000Z" },
      };
    });
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    const todoCol = slot.container.querySelector('[data-board-column="todo"]') as HTMLElement;
    const boardEl = todoCol.parentElement!.parentElement as HTMLElement;

    vi.spyOn(boardEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
    vi.spyOn(todoCol, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 40, 256, 500));
    vi.spyOn(card1, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 256, 80));

    dispatchPointer(card1, "pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 80,
    });
    dispatchPointer(window, "pointermove", { pointerId: 1, clientX: 360, clientY: 100 });
    expect(
      slot.container.querySelector('[aria-hidden="true"][data-task-key="BRD-1"]'),
    ).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(slot.container.querySelector('[aria-hidden="true"][data-task-key="BRD-1"]')).toBeNull();
    dispatchPointer(window, "pointerup", { pointerId: 1, clientX: 360, clientY: 100 });
    expect(boardMove).not.toHaveBeenCalled();

    dispatchPointer(card1, "pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 2,
      pointerType: "mouse",
      clientX: 100,
      clientY: 80,
    });
    dispatchPointer(window, "pointermove", { pointerId: 2, clientX: 360, clientY: 100 });
    dispatchPointer(window, "pointerup", { pointerId: 2, clientX: 360, clientY: 100 });
    await waitFor(() =>
      expect(boardMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: taskA.id, status: "todo" }),
      ),
    );
  });

  it("skips boardMove RPC on a no-op drop back into the card's original slot", async () => {
    const boardMove = vi.fn();
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    const card2 = slot.getByRole("button", { name: "Open BRD-2: Second backlog task" });
    const backlogCol = slot.container.querySelector('[data-board-column="backlog"]') as HTMLElement;
    const boardEl = backlogCol.parentElement!.parentElement as HTMLElement;

    vi.spyOn(boardEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
    vi.spyOn(backlogCol, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 256, 500));
    vi.spyOn(card1, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 256, 80));
    vi.spyOn(card2, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 126, 256, 80));

    dispatchPointer(card1, "pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 60,
    });
    dispatchPointer(window, "pointermove", { pointerId: 1, clientX: 112, clientY: 60 });
    dispatchPointer(window, "pointerup", { pointerId: 1, clientX: 112, clientY: 60 });
    expect(boardMove).not.toHaveBeenCalled();
  });

  it("renders an alert error state with Retry when loading tasks fails", async () => {
    let fail = true;
    const slot = renderBoard({
      listTasks: () => {
        if (fail) return Promise.reject(new Error("Offline"));
        return { tasks: [taskA], nextCursor: null };
      },
    });

    const alert = await slot.findByRole("alert");
    expect(within(alert).getByText("Couldn't load board")).toBeDefined();
    expect(within(alert).getByText("Offline")).toBeDefined();

    fail = false;
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    });
    await slot.findByText("First backlog task");
  });
});
