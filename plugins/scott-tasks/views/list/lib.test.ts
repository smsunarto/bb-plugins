import { describe, expect, it, vi } from "vitest";
import type { Label, Task } from "../../shared/contract.js";
import {
  activeWorkLabel,
  childrenByParent,
  childrenForList,
  displayRows,
  formatDueDate,
  groupTasksByStatus,
  labelFilterOptions,
  listTaskCount,
  parentIsOpen,
  partitionLabels,
  selectedLabelIds,
  widestKeysByPrefix,
  type TaskMatchCriteria,
} from "./lib.js";
import { makeTask } from "../../test-fixtures.js";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const ULID_B = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const ULID_C = "01ARZ3NDEKTSV4RRFFQ69G5FAC";

it("formats update instants in the viewer's timezone and keeps due dates on their calendar day", async () => {
  vi.stubEnv("TZ", "America/Los_Angeles");
  vi.resetModules();
  try {
    const { formatDueDate, formatUpdatedAt } = await import("./lib.js");
    const today = new Date("2026-11-26T12:00:00.000Z");
    expect(formatUpdatedAt("2026-11-25T01:00:00.000Z", today)).toBe("Nov 24");
    expect(formatDueDate("2026-11-25", today)).toBe("Nov 25");
  } finally {
    vi.unstubAllEnvs();
  }
});

function task(overrides: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return makeTask({
    projectId: ULID_A,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("groupTasksByStatus", () => {
  it("orders groups canonically and hides empty ones", () => {
    const groups = groupTasksByStatus([
      task({ id: ULID_A, status: "done" }),
      task({ id: ULID_B, status: "todo" }),
      task({ id: ULID_C, status: "todo" }),
    ]);
    expect(groups.map((g) => g.status)).toEqual(["todo", "done"]);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual([ULID_B, ULID_C]);
  });

  it("returns nothing for no tasks", () => {
    expect(groupTasksByStatus([])).toEqual([]);
  });
});

describe("label filter options", () => {
  const label = (id: string, projectId: string, name: string): Label => ({
    id,
    projectId,
    name,
    color: "#5e6ad2",
  });

  it("merges same-named labels across projects and resolves ids", () => {
    const options = labelFilterOptions([
      label(ULID_A, ULID_A, "Bug"),
      label(ULID_B, ULID_B, "Bug"),
      label(ULID_C, ULID_A, "Feature"),
    ]);
    expect(options.map((o) => o.name)).toEqual(["Bug", "Feature"]);
    expect(selectedLabelIds(options, ["Bug"])).toEqual([ULID_A, ULID_B]);
    expect(selectedLabelIds(options, [])).toEqual([]);
  });
});

describe("formatDueDate", () => {
  it("omits the current year and shows other years", () => {
    const today = new Date("2026-07-15T12:00:00");
    expect(formatDueDate("2026-07-18", today)).toBe("Jul 18");
    expect(formatDueDate("2027-01-02", today)).toBe("Jan 2, 2027");
  });
});

describe("activeWorkLabel", () => {
  it("distinguishes starting from working for a single agent", () => {
    expect(activeWorkLabel([{ liveStatus: "starting" }])).toBe("Agent starting");
    expect(activeWorkLabel([{ liveStatus: "working" }])).toBe("Agent working");
  });

  it("counts multiple live agents", () => {
    expect(activeWorkLabel([{ liveStatus: "working" }, { liveStatus: "starting" }])).toBe(
      "2 agents working",
    );
  });
});

describe("partitionLabels", () => {
  const label = (name: string): Label => ({
    id: name,
    projectId: ULID_A,
    name,
    color: "#5e6ad2",
  });

  it("keeps everything visible at or under the cap", () => {
    const labels = [label("a"), label("b")];
    expect(partitionLabels(labels, 2)).toEqual({
      visible: labels,
      hidden: [],
    });
    expect(partitionLabels([], 2)).toEqual({ visible: [], hidden: [] });
  });

  it("moves the tail into hidden above the cap", () => {
    const labels = [label("a"), label("b"), label("c")];
    expect(partitionLabels(labels, 1)).toEqual({
      visible: [labels[0]],
      hidden: [labels[1], labels[2]],
    });
  });
});

describe("sub-task matching and widest keys", () => {
  const emptyCriteria: TaskMatchCriteria = {
    statuses: [],
    priorities: [],
    labelIds: null,
    search: "",
    activeIds: null,
  };

  it("keeps a non-matching parent when a sub-task matches and counts only matching rows", () => {
    const parent = task({ id: ULID_A, status: "todo", title: "Parent", key: "TSK-1" });
    const doneChild = task({
      id: ULID_B,
      parentTaskId: parent.id,
      status: "done",
      title: "Needle",
      key: "TSK-12",
    });
    const otherChild = task({
      id: ULID_C,
      parentTaskId: parent.id,
      status: "todo",
      title: "Other",
      key: "TSK-13",
    });
    const grouped = childrenByParent([parent, doneChild, otherChild]);
    const criteria: TaskMatchCriteria = { ...emptyCriteria, search: "needle" };
    const { visible, totals } = childrenForList(grouped, criteria, "manual");

    expect(totals.get(parent.id)).toEqual({ done: 1, total: 2 });
    expect(visible.get(parent.id)?.map((t) => t.id)).toEqual([doneChild.id]);
    expect(displayRows([parent], criteria, visible).map((t) => t.id)).toEqual([parent.id]);
    expect(parentIsOpen(parent.id, [], criteria, visible)).toBe(true);
    expect(listTaskCount([parent], criteria, visible)).toBe(1);
    expect(listTaskCount([parent], emptyCriteria, visible)).toBe(1);
    expect(widestKeysByPrefix([parent, doneChild, otherChild])).toEqual(["TSK-12"]);
  });
});
