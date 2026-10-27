import { TASK_PRIORITIES, type Task } from "./contract.js";
import type { TaskSort } from "./pagination.js";

const PRIORITY_RANK = new Map<Task["priority"], number>(
  TASK_PRIORITIES.map((priority, index) => [priority, index]),
);

function byPriority(a: Task, b: Task): number {
  return (
    (PRIORITY_RANK.get(a.priority) ?? TASK_PRIORITIES.length) -
    (PRIORITY_RANK.get(b.priority) ?? TASK_PRIORITIES.length)
  );
}

function byDueDate(a: Task, b: Task): number {
  if (a.dueDate === null) return b.dueDate === null ? 0 : 1;
  if (b.dueDate === null) return -1;
  return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The server's manual order: project, status, then board position. */
export function byManualOrder(a: Task, b: Task): number {
  return (
    compareText(a.projectId, b.projectId) ||
    compareText(a.status, b.status) ||
    a.position - b.position ||
    compareText(a.id, b.id)
  );
}

export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
  if (sort === "manual") return [...tasks].sort(byManualOrder);
  const [primary, secondary] =
    sort === "priority" ? [byPriority, byDueDate] : [byDueDate, byPriority];
  return [...tasks].sort((a, b) => primary(a, b) || secondary(a, b) || byManualOrder(a, b));
}
