import {
  EMPTY_STATE,
  type Task,
  type TaskState,
  type TaskStatus,
} from "../../shared/rpiv-todo-types.ts";

function isStatus(value: unknown): value is TaskStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "deleted"
  );
}

const LEGAL: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["pending", "in_progress", "completed", "deleted"],
  in_progress: ["in_progress", "pending", "completed", "deleted"],
  completed: ["completed", "pending", "in_progress", "deleted"],
  deleted: ["deleted"],
};

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asNumberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const item of value) {
    const n = asNumber(item);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Replay completed `todo` tool arguments through the same state machine as
 * `@juicesharp/rpiv-todo`. Failed mutations are skipped so ids stay aligned
 * with the extension's `nextId`.
 */
export function replayTodoArgs(
  calls: readonly Record<string, unknown>[],
  initial?: TaskState,
): TaskState {
  let state: TaskState = initial ?? { tasks: [], nextId: EMPTY_STATE.nextId };
  for (const args of calls) {
    const next = applyArgs(state, args);
    if (next) state = next;
  }
  return state;
}

function applyArgs(state: TaskState, args: Record<string, unknown>): TaskState | null {
  const action = args.action;
  switch (action) {
    case "create":
      return applyCreate(state, args);
    case "update":
      return applyUpdate(state, args);
    case "delete":
      return applyDelete(state, args);
    case "clear":
      return { tasks: [], nextId: 1 };
    case "list":
    case "get":
      return state;
    default:
      return null;
  }
}

function applyCreate(state: TaskState, args: Record<string, unknown>): TaskState | null {
  const subject = asOptionalString(args.subject)?.trim();
  if (!subject) return null;
  const blockedBy = asNumberList(args.blockedBy);
  if (args.blockedBy !== undefined && blockedBy === undefined) return null;
  if (blockedBy) {
    for (const dep of blockedBy) {
      const depTask = state.tasks.find((task) => task.id === dep);
      if (!depTask || depTask.status === "deleted") return null;
    }
  }
  const task: Task = {
    id: state.nextId,
    subject,
    status: "pending",
  };
  const description = asOptionalString(args.description);
  const activeForm = asOptionalString(args.activeForm);
  const owner = asOptionalString(args.owner);
  if (description) task.description = description;
  if (activeForm) task.activeForm = activeForm;
  if (blockedBy?.length) task.blockedBy = blockedBy;
  if (owner) task.owner = owner;
  return { tasks: [...state.tasks, task], nextId: state.nextId + 1 };
}

function applyUpdate(state: TaskState, args: Record<string, unknown>): TaskState | null {
  const id = asNumber(args.id);
  if (id === undefined) return null;
  const idx = state.tasks.findIndex((task) => task.id === id);
  if (idx === -1) return null;
  const current = state.tasks[idx];
  if (!current) return null;

  const hasMutation =
    args.subject !== undefined ||
    args.description !== undefined ||
    args.activeForm !== undefined ||
    args.status !== undefined ||
    args.owner !== undefined ||
    (Array.isArray(args.addBlockedBy) && args.addBlockedBy.length > 0) ||
    (Array.isArray(args.removeBlockedBy) && args.removeBlockedBy.length > 0);
  if (!hasMutation) return null;

  let status = current.status;
  if (args.status !== undefined) {
    if (!isStatus(args.status)) return null;
    const nextStatus = args.status;
    if (!LEGAL[current.status].includes(nextStatus)) return null;
    status = nextStatus;
  }

  let blockedBy = current.blockedBy ? [...current.blockedBy] : [];
  const removeBlockedBy = asNumberList(args.removeBlockedBy);
  if (args.removeBlockedBy !== undefined && removeBlockedBy === undefined) return null;
  if (removeBlockedBy?.length) {
    const drop = new Set(removeBlockedBy);
    blockedBy = blockedBy.filter((dep) => !drop.has(dep));
  }
  const addBlockedBy = asNumberList(args.addBlockedBy);
  if (args.addBlockedBy !== undefined && addBlockedBy === undefined) return null;
  if (addBlockedBy?.length) {
    for (const dep of addBlockedBy) {
      if (dep === current.id) return null;
      const depTask = state.tasks.find((task) => task.id === dep);
      if (!depTask || depTask.status === "deleted") return null;
      if (!blockedBy.includes(dep)) blockedBy.push(dep);
    }
  }

  const updated: Task = { ...current, status };
  if (args.subject !== undefined) {
    const subject = asOptionalString(args.subject);
    if (subject === undefined) return null;
    updated.subject = subject;
  }
  if (args.description !== undefined) {
    const description = asOptionalString(args.description);
    if (description === undefined) return null;
    updated.description = description;
  }
  if (args.activeForm !== undefined) {
    const activeForm = asOptionalString(args.activeForm);
    if (activeForm === undefined) return null;
    updated.activeForm = activeForm;
  }
  if (args.owner !== undefined) {
    const owner = asOptionalString(args.owner);
    if (owner === undefined) return null;
    updated.owner = owner;
  }
  if (blockedBy.length) updated.blockedBy = blockedBy;
  else updated.blockedBy = undefined;

  const tasks = [...state.tasks];
  tasks[idx] = updated;
  return { tasks, nextId: state.nextId };
}

function applyDelete(state: TaskState, args: Record<string, unknown>): TaskState | null {
  const id = asNumber(args.id);
  if (id === undefined) return null;
  const idx = state.tasks.findIndex((task) => task.id === id);
  if (idx === -1) return null;
  const current = state.tasks[idx];
  if (!current) return null;
  if (current.status === "deleted") return null;
  const tasks = [...state.tasks];
  tasks[idx] = { ...current, status: "deleted" };
  return { tasks, nextId: state.nextId };
}
