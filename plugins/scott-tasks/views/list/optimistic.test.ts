import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/contract.js";
import {
  applyEdit,
  beginEdit,
  editedTasks,
  matchesFilters,
  pendingIds,
  reconcileEntries,
  settleFailure,
  settleSuccess,
  type TaskEntries,
} from "./optimistic.js";
import { makeTask } from "../../test-fixtures.js";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return makeTask({
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

const empty: TaskEntries = new Map();
const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-01T00:00:01.000Z";
const T2 = "2026-07-01T00:00:02.000Z";

describe("applyEdit / editedTasks", () => {
  it("overlays only the edited fields, including dueDate:null and position", () => {
    const base = task({ id: "T1", status: "todo", dueDate: "2026-07-20" });
    expect(applyEdit(base, undefined)).toBe(base);
    expect(applyEdit(base, {})).toBe(base);
    expect(applyEdit(base, { status: "done" }).status).toBe("done");
    expect(applyEdit(base, { dueDate: null }).dueDate).toBeNull();
    expect(applyEdit(base, { position: 42 }).position).toBe(42);
    expect(applyEdit(base, { status: "done" }).dueDate).toBe("2026-07-20");
  });

  it("returns a copy when there are no entries, overlays otherwise", () => {
    const tasks = [task({ id: "T1", status: "todo" }), task({ id: "T2" })];
    expect(editedTasks(tasks, empty)).not.toBe(tasks);
    const entries = beginEdit(empty, "T1", { status: "done" }, 1);
    const result = editedTasks(tasks, entries);
    expect(result[0]?.status).toBe("done");
    expect(result[1]).toBe(tasks[1]);
  });
});

describe("matchesFilters", () => {
  const t = task({
    id: "T1",
    status: "in_progress",
    priority: "high",
    labelIds: ["A"],
  });

  it("passes with no filters", () => {
    expect(matchesFilters(t, [], [], [])).toBe(true);
  });

  it("filters by status, priority, and label any-of", () => {
    expect(matchesFilters(t, ["in_progress"], [], [])).toBe(true);
    expect(matchesFilters(t, ["todo"], [], [])).toBe(false);
    expect(matchesFilters(t, [], ["low"], [])).toBe(false);
    expect(matchesFilters(t, [], [], ["A"])).toBe(true);
    expect(matchesFilters(t, [], [], ["B"])).toBe(false);
    expect(matchesFilters(t, [], [], ["B", "A"])).toBe(true);
  });
});

describe("begin / settle lifecycle", () => {
  it("reverts a solo failed edit and drops the now-empty entry", () => {
    let e = beginEdit(empty, "T1", { status: "done" }, 1);
    expect(e.get("T1")?.inFlight).toBe(1);
    expect([...pendingIds(e)]).toEqual(["T1"]);
    e = settleFailure(e, "T1", { status: "done" }, 1);
    expect(e.has("T1")).toBe(false);
  });

  it("keeps the optimistic value on success and clears pending", () => {
    let e = beginEdit(empty, "T1", { priority: "high" }, 1);
    e = settleSuccess(e, "T1", { priority: "high" }, 1, task({ id: "T1", priority: "high" }));
    expect(e.get("T1")?.edit.priority).toBe("high");
    expect(pendingIds(e).size).toBe(0);
  });

  it("captures the server position on a successful status change only", () => {
    let statusEdit = beginEdit(empty, "T1", { status: "todo" }, 1);
    statusEdit = settleSuccess(
      statusEdit,
      "T1",
      { status: "todo" },
      1,
      task({ id: "T1", status: "todo", position: 4096 }),
    );
    expect(statusEdit.get("T1")?.edit.position).toBe(4096);

    let priorityEdit = beginEdit(empty, "T2", { priority: "high" }, 1);
    priorityEdit = settleSuccess(
      priorityEdit,
      "T2",
      { priority: "high" },
      1,
      task({ id: "T2", position: 4096 }),
    );
    expect(priorityEdit.get("T2")?.edit.position).toBeUndefined();
  });
});

describe("concurrent / out-of-order edits to one task", () => {
  it("a stale failure never reverts a newer edit, and pending survives it", () => {
    let e = beginEdit(empty, "T1", { status: "done" }, 1);
    e = beginEdit(e, "T1", { status: "canceled" }, 2);
    expect(e.get("T1")?.edit.status).toBe("canceled");
    expect(e.get("T1")?.inFlight).toBe(2);

    e = settleFailure(e, "T1", { status: "done" }, 1);
    expect(e.get("T1")?.edit.status).toBe("canceled");
    expect(e.get("T1")?.inFlight).toBe(1);
    expect(pendingIds(e).has("T1")).toBe(true);

    e = settleSuccess(
      e,
      "T1",
      { status: "canceled" },
      2,
      task({ id: "T1", status: "canceled", position: 900 }),
    );
    expect(e.get("T1")?.edit.status).toBe("canceled");
    expect(e.get("T1")?.edit.position).toBe(900);
    expect(pendingIds(e).size).toBe(0);
  });

  it("a stale success does not clobber a newer pending field", () => {
    let e = beginEdit(empty, "T1", { labelIds: ["A"] }, 1);
    e = beginEdit(e, "T1", { labelIds: ["A", "B"] }, 2);
    e = settleSuccess(e, "T1", { labelIds: ["A"] }, 1, task({ id: "T1", labelIds: ["A"] }));
    expect(e.get("T1")?.edit.labelIds).toEqual(["A", "B"]);
    expect(e.get("T1")?.inFlight).toBe(1);
  });
});

describe("reconcileEntries", () => {
  it("drops confirmed fields, keeps unsettled, and drops orphans", () => {
    let e = beginEdit(empty, "T1", { status: "done", priority: "high" }, 1);
    e = settleSuccess(
      e,
      "T1",
      { status: "done", priority: "high" },
      1,
      task({ id: "T1", status: "done", position: 50, updatedAt: T1 }),
    );
    const server = [
      task({ id: "T1", status: "done", priority: "low", position: 50, updatedAt: T0 }),
    ];
    expect(reconcileEntries(e, server).get("T1")?.edit).toEqual({
      priority: "high",
    });
    expect(reconcileEntries(e, [task({ id: "T2" })]).size).toBe(0);
  });

  it("returns the same reference when nothing settles and keeps in-flight entries", () => {
    const e = beginEdit(empty, "T1", { status: "done" }, 1);
    expect(reconcileEntries(e, [task({ id: "T1", status: "todo" })])).toBe(e);
  });
});

describe("confirmed edits against later server changes", () => {
  function confirmedTitle(): TaskEntries {
    const e = beginEdit(empty, "T1", { title: "B" }, 1);
    return settleSuccess(e, "T1", { title: "B" }, 1, task({ id: "T1", title: "B", updatedAt: T1 }));
  }

  it("shows a newer server value instead of the confirmed edit", () => {
    const e = confirmedTitle();
    for (const updatedAt of [T1, T2]) {
      const server = [task({ id: "T1", title: "C", updatedAt })];
      const next = reconcileEntries(e, server);
      expect(next.has("T1")).toBe(false);
      expect(editedTasks(server, next)[0]?.title).toBe("C");
      expect(reconcileEntries(next, server)).toBe(next);
    }
  });

  it("keeps the confirmed edit over a fetch older than its write", () => {
    const e = confirmedTitle();
    const stale = [task({ id: "T1", title: "A", updatedAt: T0 })];
    expect(reconcileEntries(e, stale)).toBe(e);
    expect(editedTasks(stale, e)[0]?.title).toBe("B");
  });

  it("retires an older confirmed field but keeps a newer pending one", () => {
    let e = beginEdit(confirmedTitle(), "T1", { status: "done" }, 2);
    e = beginEdit(e, "T1", { priority: "high" }, 3);
    e = settleSuccess(e, "T1", { priority: "high" }, 3, task({ id: "T1", updatedAt: T1 }));
    const server = [task({ id: "T1", title: "C", status: "todo", priority: "low", updatedAt: T2 })];
    const next = reconcileEntries(e, server);
    expect(next.get("T1")?.edit).toEqual({ status: "done" });
    expect(editedTasks(server, next)[0]).toMatchObject({
      title: "C",
      status: "done",
      priority: "low",
    });
  });

  it("keeps a newer pending write to a field an older write confirmed", () => {
    const e = beginEdit(confirmedTitle(), "T1", { title: "D" }, 2);
    const server = [task({ id: "T1", title: "C", updatedAt: T2 })];
    expect(reconcileEntries(e, server).get("T1")?.edit).toEqual({ title: "D" });
  });

  it("retires the captured position with its status once the server moves on", () => {
    let e = beginEdit(empty, "T1", { status: "done" }, 1);
    e = settleSuccess(
      e,
      "T1",
      { status: "done" },
      1,
      task({ id: "T1", status: "done", position: 50, updatedAt: T1 }),
    );
    const moved = [task({ id: "T1", status: "in_progress", position: 70, updatedAt: T2 })];
    expect(reconcileEntries(e, moved).has("T1")).toBe(false);
  });
});
