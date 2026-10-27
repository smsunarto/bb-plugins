import type { TaskStatus } from "../../shared/contract.js";

export const BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const satisfies readonly TaskStatus[];

export function visibleBoardStatuses(
  columns: Readonly<Record<TaskStatus, readonly unknown[]>>,
): TaskStatus[] {
  return [...BOARD_STATUSES, ...(columns.canceled.length > 0 ? (["canceled"] as const) : [])];
}

interface BoardDropNeighbors {
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

export function dropNeighborsForIndex(
  columnTaskIds: readonly string[],
  draggedTaskId: string,
  dropIndex: number,
): BoardDropNeighbors {
  const ids = columnTaskIds.filter((id) => id !== draggedTaskId);
  const index = Math.max(0, Math.min(dropIndex, ids.length));
  return {
    beforeTaskId: ids[index - 1] ?? null,
    afterTaskId: ids[index] ?? null,
  };
}

export function dropIndexForPointer(cardCenterYs: readonly number[], pointerY: number): number {
  let index = 0;
  for (const centerY of cardCenterYs) {
    if (pointerY > centerY) index += 1;
  }
  return index;
}
