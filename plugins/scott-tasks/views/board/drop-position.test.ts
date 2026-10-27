import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../../shared/contract.js";
import {
  dropIndexForPointer,
  dropNeighborsForIndex,
  visibleBoardStatuses,
} from "./drop-position.js";

describe("visibleBoardStatuses", () => {
  const columns = (canceled: number): Record<TaskStatus, unknown[]> => ({
    backlog: [],
    todo: ["t1"],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: Array.from({ length: canceled }, (_, index) => `c${index}`),
  });

  it("hides the Canceled column while it is empty", () => {
    expect(visibleBoardStatuses(columns(0))).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
    ]);
  });

  it("appends Canceled at the end once it holds cards", () => {
    expect(visibleBoardStatuses(columns(2))).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]);
  });
});

describe("dropNeighborsForIndex", () => {
  const column = ["a", "b", "c"];

  it("returns both neighbors for a drop between cards in another column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 1)).toEqual({
      beforeTaskId: "a",
      afterTaskId: "b",
    });
  });

  it("returns only an after neighbor at the top of a column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 0)).toEqual({
      beforeTaskId: null,
      afterTaskId: "a",
    });
  });

  it("returns only a before neighbor at the bottom of a column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 3)).toEqual({
      beforeTaskId: "c",
      afterTaskId: null,
    });
  });

  it("returns no neighbors for an empty column", () => {
    expect(dropNeighborsForIndex([], "dragged", 0)).toEqual({
      beforeTaskId: null,
      afterTaskId: null,
    });
  });

  it("excludes the dragged card on a same-column reorder", () => {
    expect(dropNeighborsForIndex(column, "a", 1)).toEqual({
      beforeTaskId: "b",
      afterTaskId: "c",
    });
  });

  it("clamps out-of-range indexes into the column", () => {
    expect(dropNeighborsForIndex(column, "dragged", 99)).toEqual({
      beforeTaskId: "c",
      afterTaskId: null,
    });
    expect(dropNeighborsForIndex(column, "dragged", -1)).toEqual({
      beforeTaskId: null,
      afterTaskId: "a",
    });
  });
});

describe("dropIndexForPointer", () => {
  const centers = [10, 30, 50];

  it("maps a pointer above every card to the top slot", () => {
    expect(dropIndexForPointer(centers, 5)).toBe(0);
  });

  it("maps a pointer between card centers to the slot between them", () => {
    expect(dropIndexForPointer(centers, 20)).toBe(1);
    expect(dropIndexForPointer(centers, 40)).toBe(2);
  });

  it("maps a pointer below every card to the end slot", () => {
    expect(dropIndexForPointer(centers, 100)).toBe(3);
  });

  it("returns 0 for an empty column", () => {
    expect(dropIndexForPointer([], 42)).toBe(0);
  });
});
