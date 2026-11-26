// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Label, Task, TaskThread } from "../../shared/contract.js";
import { makeTask, rpcInput } from "../../test-fixtures.js";

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

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const OTHER_PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP2";

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

const otherProject = {
  id: OTHER_PROJECT_ID,
  name: "Other Board",
  prefix: "OTH",
  nextTaskNumber: 5,
  color: "#a895fe",
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
  title: "Third backlog task",
  status: "backlog",
  priority: "low",
  position: 3,
});

const taskD: Task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT4",
  projectId: PROJECT_ID,
  number: 4,
  key: "BRD-4",
  title: "Todo column task",
  status: "todo",
  priority: "urgent",
  position: 1,
});

const otherTask: Task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT9",
  projectId: OTHER_PROJECT_ID,
  number: 1,
  key: "OTH-1",
  title: "Other project task",
  status: "backlog",
  priority: "medium",
  position: 1,
});

const DEFAULT_TASKS = [taskA, taskB, taskC, taskD];

function renderBoard(
  overrides: Record<string, unknown> = {},
  subPath = `${PROJECT_ID}?view=board`,
) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath },
    {
      rpc: {
        listProjects: () => ({ projects: [project, otherProject] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: [] }),
        listTasks: (raw: unknown) => {
          const { projectId } = rpcInput(raw);
          if (projectId === OTHER_PROJECT_ID) return { tasks: [otherTask], nextCursor: null };
          return { tasks: DEFAULT_TASKS, nextCursor: null };
        },
        countTaskAttachments: () => ({ counts: [] }),
        listActiveTaskThreads: () => ({ taskThreads: [] }),
        boardMove: (raw: unknown) => {
          const input = rpcInput(raw);
          const taskId = String(input.taskId);
          const status = input.status as Task["status"];
          const base = DEFAULT_TASKS.find((t) => t.id === taskId) ?? taskA;
          return {
            ok: true,
            task: { ...base, status, updatedAt: "2026-07-16T00:00:00.000Z" },
          };
        },
        ...overrides,
      },
    },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BoardView", () => {
  it("renders semantic column sections, headings, list roles, and hides empty Canceled", async () => {
    const slot = renderBoard();
    await slot.findByText("First backlog task");

    const headings = slot.getAllByRole("heading", { level: 2 }).map((el) => el.textContent);
    expect(headings).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done"]);

    const backlogList = slot.getByRole("list", { name: "Backlog, 3 tasks" });
    expect(within(backlogList).getAllByRole("listitem")).toHaveLength(3);

    const todoList = slot.getByRole("list", { name: "Todo, 1 task" });
    expect(within(todoList).getAllByRole("listitem")).toHaveLength(1);

    const doneList = slot.getByRole("list", { name: "Done, 0 tasks" });
    expect(within(doneList).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("caps card labels to 3 with a +N tooltip and exposes preset name and metadata via aria-describedby", async () => {
    const labels = makeLabels(6);
    const heavyTask: Task = {
      ...taskA,
      labelIds: labels.map((label) => label.id),
    };
    const subDone: Task = makeTask({
      id: "01HZZZZZZZZZZZZZZZZZZZZZS1",
      projectId: PROJECT_ID,
      number: 5,
      key: "BRD-5",
      title: "Subtask done",
      status: "done",
      parentTaskId: heavyTask.id,
      position: 1,
    });
    const subOpen: Task = makeTask({
      id: "01HZZZZZZZZZZZZZZZZZZZZZS2",
      projectId: PROJECT_ID,
      number: 6,
      key: "BRD-6",
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

    const describedBy = card.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const descEl = document.getElementById(describedBy!);
    expect(descEl?.textContent).toContain("High priority");
    expect(descEl?.textContent).toContain("Implementer: Agent working");
    expect(descEl?.textContent).toContain("1 of 2 sub-tasks done");
    expect(descEl?.textContent).toContain("1 attachment");
    expect(descEl?.textContent).not.toContain("1 attachments");
  });

  it("omits metadata on bare cards and marks titles with dir=auto", async () => {
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
    expect(card.getAttribute("aria-describedby")).toBeNull();
    expect(within(card).queryByText(/^\d+\/\d+$/)).toBeNull();
  });

  it("opens a task on click and supports Arrow navigation in LTR and RTL", async () => {
    const slot = renderBoard();
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    const card2 = slot.getByRole("button", { name: "Open BRD-2: Second backlog task" });
    const card4 = slot.getByRole("button", { name: "Open BRD-4: Todo column task" });

    card1.focus();
    fireEvent.keyDown(card1, { key: "ArrowDown" });
    expect(document.activeElement).toBe(card2);

    fireEvent.keyDown(card2, { key: "ArrowRight" });
    expect(document.activeElement).toBe(card4);

    fireEvent.keyDown(card4, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card1);

    // In RTL, ArrowLeft advances toward Todo and ArrowRight returns toward Backlog
    const scroller = slot.container.querySelector("[data-board-scroller]") as HTMLElement;
    const origGetComputedStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = origGetComputedStyle(el, pseudo);
      if (el === scroller) {
        return new Proxy(style, {
          get(target, prop) {
            return prop === "direction" ? "rtl" : Reflect.get(target, prop);
          },
        });
      }
      return style;
    });
    fireEvent.keyDown(card1, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card4);
    fireEvent.keyDown(card4, { key: "ArrowRight" });
    expect(document.activeElement).toBe(card1);
    vi.restoreAllMocks();

    fireEvent.click(card4);
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/BRD-4" },
    });
  });

  it("prevents Alt+ArrowLeft/Right default at column boundaries to avoid browser Back/Forward", async () => {
    const boardMove = vi.fn();
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });

    card1.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      card1.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(boardMove).not.toHaveBeenCalled();
  });

  it("moves cards with Alt+Arrow, keeps focus on the moved card, and announces distinct positions", async () => {
    const boardMove = vi.fn((raw: unknown) => {
      const input = rpcInput(raw);
      const taskId = String(input.taskId);
      const status = input.status as Task["status"];
      const base = DEFAULT_TASKS.find((t) => t.id === taskId) ?? taskA;
      return {
        ok: true,
        task: { ...base, status, position: 2.5, updatedAt: "2026-07-16T00:00:00.000Z" },
      };
    });
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });

    card1.focus();
    fireEvent.keyDown(card1, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(slot.getByRole("status").textContent).toBe(
        "Moved BRD-1 to position 2 of 3 in Backlog",
      ),
    );
    expect(document.activeElement?.getAttribute("data-task-key")).toBe("BRD-1");

    const movedCard = slot.getByRole("button", { name: "Open BRD-1: First backlog task" });
    fireEvent.keyDown(movedCard, { key: "ArrowRight", altKey: true });
    await waitFor(() =>
      expect(boardMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: taskA.id, status: "todo" }),
      ),
    );
    expect(slot.getByRole("status").textContent).toBe("Moved BRD-1 to Todo, position 2 of 2");
    expect(document.activeElement?.getAttribute("data-task-key")).toBe("BRD-1");
  });

  it("surfaces a toast error and restores focus on the rolled-back card when boardMove is refused", async () => {
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
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("data-task-key")).toBe("BRD-1");
      expect(slot.getByRole("status").textContent).toBe(
        "Could not move BRD-1; returned to Backlog",
      );
    });
  });

  it("cancels drag on Escape, suppresses the delayed release click, and completes cross-column drag", async () => {
    const boardMove = vi.fn((raw: unknown) => {
      const input = rpcInput(raw);
      return {
        ok: true,
        task: {
          ...taskA,
          status: input.status as Task["status"],
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      };
    });
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    const todoCol = slot.container.querySelector('[data-board-column="todo"]') as HTMLElement;
    const boardEl = slot.container.querySelector("[data-board-scroller]") as HTMLElement;

    vi.spyOn(boardEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
    vi.spyOn(todoCol, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 40, 256, 500));
    vi.spyOn(card1, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 256, 80));

    // Drag, cancel with Escape, wait, then release & fire click: task must NOT open
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
    await new Promise((resolve) => setTimeout(resolve, 25));
    dispatchPointer(window, "pointerup", { pointerId: 1, clientX: 100, clientY: 80 });
    fireEvent.click(card1);
    expect(boardMove).not.toHaveBeenCalled();
    expect(slot.navigateCalls).toHaveLength(0);

    // Complete a real cross-column drag into Todo
    dispatchPointer(card1, "pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 2,
      pointerType: "mouse",
      clientX: 100,
      clientY: 80,
    });
    dispatchPointer(window, "pointermove", { pointerId: 2, clientX: 360, clientY: 100 });
    expect(
      slot.container.querySelector('[aria-hidden="true"][data-task-key="BRD-1"]'),
    ).not.toBeNull();
    dispatchPointer(window, "pointerup", { pointerId: 2, clientX: 360, clientY: 100 });
    await waitFor(() =>
      expect(boardMove).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: taskA.id, status: "todo" }),
      ),
    );
  });

  it("picks up a card and skips boardMove RPC on a no-op drop back into its original slot", async () => {
    const boardMove = vi.fn();
    const slot = renderBoard({ boardMove });
    const card1 = await slot.findByRole("button", { name: "Open BRD-1: First backlog task" });
    const card2 = slot.getByRole("button", { name: "Open BRD-2: Second backlog task" });
    const card3 = slot.getByRole("button", { name: "Open BRD-3: Third backlog task" });
    const backlogCol = slot.container.querySelector('[data-board-column="backlog"]') as HTMLElement;
    const boardEl = slot.container.querySelector("[data-board-scroller]") as HTMLElement;

    vi.spyOn(boardEl, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
    vi.spyOn(backlogCol, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 256, 500));
    vi.spyOn(card1, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 40, 256, 80));
    vi.spyOn(card2, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 126, 256, 80));
    vi.spyOn(card3, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 212, 256, 80));

    dispatchPointer(card1, "pointerdown", {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 60,
    });
    dispatchPointer(window, "pointermove", { pointerId: 1, clientX: 112, clientY: 60 });
    // Prove drag pickup actually started before verifying no-op drop skips RPC
    expect(
      slot.container.querySelector('[aria-hidden="true"][data-task-key="BRD-1"]'),
    ).not.toBeNull();
    dispatchPointer(window, "pointerup", { pointerId: 1, clientX: 112, clientY: 60 });
    expect(boardMove).not.toHaveBeenCalled();
  });

  it("preserves board and column scroll across unmount/remount without leaking across projects", async () => {
    const slot = renderBoard();
    await slot.findByText("First backlog task");
    const boardEl = slot.container.querySelector("[data-board-scroller]") as HTMLElement;
    const backlogCol = slot.container.querySelector('[data-board-column="backlog"]') as HTMLElement;

    boardEl.scrollLeft = 64;
    fireEvent.scroll(boardEl);
    backlogCol.scrollTop = 240;
    fireEvent.scroll(backlogCol);

    // Switching directly to another project resets scroll to 0 instead of leaking Project A's offsets
    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(<Panel subPath={`${OTHER_PROJECT_ID}?view=board`} />);
    await slot.findByText("Other project task");
    const otherBoardEl = slot.container.querySelector("[data-board-scroller]") as HTMLElement;
    const otherBacklogCol = slot.container.querySelector(
      '[data-board-column="backlog"]',
    ) as HTMLElement;
    expect(otherBoardEl.scrollLeft).toBe(0);
    expect(otherBacklogCol.scrollTop).toBe(0);

    // Switching back to cached Project A restores Project A's scroll, then switching back to cached Project B resets again
    slot.lifecycle.rerender(<Panel subPath={`${PROJECT_ID}?view=board`} />);
    await slot.findByText("First backlog task");
    const backBoardEl = slot.container.querySelector("[data-board-scroller]") as HTMLElement;
    const backBacklogCol = slot.container.querySelector(
      '[data-board-column="backlog"]',
    ) as HTMLElement;
    expect(backBoardEl.scrollLeft).toBe(64);
    expect(backBacklogCol.scrollTop).toBe(240);

    slot.lifecycle.rerender(<Panel subPath={`${OTHER_PROJECT_ID}?view=board`} />);
    await slot.findByText("Other project task");
    expect((slot.container.querySelector("[data-board-scroller]") as HTMLElement).scrollLeft).toBe(
      0,
    );
    expect(
      (slot.container.querySelector('[data-board-column="backlog"]') as HTMLElement).scrollTop,
    ).toBe(0);

    // Navigating away (unmounting BoardView) and remounting restores Project A's offsets
    slot.lifecycle.unmount();
    const reopened = renderBoard();
    await reopened.findByText("First backlog task");
    const nextBoardEl = reopened.container.querySelector("[data-board-scroller]") as HTMLElement;
    const nextBacklogCol = reopened.container.querySelector(
      '[data-board-column="backlog"]',
    ) as HTMLElement;
    expect(nextBoardEl.scrollLeft).toBe(64);
    expect(nextBacklogCol.scrollTop).toBe(240);
  });

  it("announces load failure via role=alert outside the interactive Retry button", async () => {
    let fail = true;
    const slot = renderBoard({
      listTasks: () => {
        if (fail) return Promise.reject(new Error("Offline"));
        return { tasks: [taskA], nextCursor: null };
      },
    });

    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Offline");
    const retryBtn = slot.getByRole("button", { name: "Retry" });
    expect(alert.contains(retryBtn)).toBe(false);

    fail = false;
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await slot.findByText("First backlog task");
  });
});
