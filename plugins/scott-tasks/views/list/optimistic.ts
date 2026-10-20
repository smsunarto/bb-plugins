import type { Task, TaskPriority, TaskStatus } from "../../shared/contract.js";

export interface TaskEdit {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  labelIds?: string[];
  position?: number;
}

type EditField = keyof TaskEdit;
const EDIT_FIELDS: readonly EditField[] = [
  "title",
  "status",
  "priority",
  "dueDate",
  "labelIds",
  "position",
];

interface TaskEntry {
  edit: TaskEdit;
  gens: Partial<Record<EditField, number>>;
  // The server's updatedAt (ms) from the write that confirmed each field. A
  // field without one is still in flight.
  confirmedAt: Partial<Record<EditField, number>>;
  inFlight: number;
}

export type TaskEntries = ReadonlyMap<string, TaskEntry>;

function sameIds(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

function hasFields(edit: TaskEdit): boolean {
  return EDIT_FIELDS.some((field) => edit[field] !== undefined);
}

function fieldSettled(task: Task, fetchedAt: number, field: EditField, entry: TaskEntry): boolean {
  const carried =
    field === "labelIds"
      ? sameIds(entry.edit.labelIds, task.labelIds)
      : task[field] === entry.edit[field];
  if (carried) return true;
  // A confirmed field also settles once the fetched task is at or past the
  // write that confirmed it, so a later change by someone else shows through.
  const confirmedAt = entry.confirmedAt[field];
  return confirmedAt !== undefined && fetchedAt >= confirmedAt;
}

export function applyEdit(task: Task, edit: TaskEdit | undefined): Task {
  if (edit === undefined || !hasFields(edit)) return task;
  return {
    ...task,
    ...(edit.title !== undefined ? { title: edit.title } : {}),
    ...(edit.status !== undefined ? { status: edit.status } : {}),
    ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
    ...(edit.dueDate !== undefined ? { dueDate: edit.dueDate } : {}),
    ...(edit.labelIds !== undefined ? { labelIds: edit.labelIds } : {}),
    ...(edit.position !== undefined ? { position: edit.position } : {}),
  };
}

export function editedTasks(serverTasks: readonly Task[], entries: TaskEntries): Task[] {
  if (entries.size === 0) return [...serverTasks];
  return serverTasks.map((task) => applyEdit(task, entries.get(task.id)?.edit));
}

export function matchesFilters(
  task: Task,
  statuses: readonly TaskStatus[],
  priorities: readonly TaskPriority[],
  labelIds: readonly string[],
): boolean {
  return (
    (statuses.length === 0 || statuses.includes(task.status)) &&
    (priorities.length === 0 || priorities.includes(task.priority)) &&
    (labelIds.length === 0 || task.labelIds.some((id) => labelIds.includes(id)))
  );
}

function makeEntry(prev: TaskEntry | undefined): Omit<TaskEntry, "inFlight"> {
  return {
    edit: { ...prev?.edit },
    gens: { ...prev?.gens },
    confirmedAt: { ...prev?.confirmedAt },
  };
}

export function beginEdit(
  entries: TaskEntries,
  taskId: string,
  patch: TaskEdit,
  gen: number,
): TaskEntries {
  const prev = entries.get(taskId);
  const { gens, confirmedAt } = makeEntry(prev);
  const edit: TaskEdit = { ...prev?.edit, ...patch };
  for (const field of EDIT_FIELDS) {
    if (patch[field] === undefined) continue;
    gens[field] = gen;
    delete confirmedAt[field];
  }
  const next = new Map(entries);
  next.set(taskId, { edit, gens, confirmedAt, inFlight: (prev?.inFlight ?? 0) + 1 });
  return next;
}

function finalize(
  entries: TaskEntries,
  taskId: string,
  { edit, gens, confirmedAt }: Omit<TaskEntry, "inFlight">,
  inFlight: number,
): TaskEntries {
  const next = new Map(entries);
  if (!hasFields(edit) && inFlight <= 0) next.delete(taskId);
  else next.set(taskId, { edit, gens, confirmedAt, inFlight: Math.max(0, inFlight) });
  return next;
}

export function settleSuccess(
  entries: TaskEntries,
  taskId: string,
  patch: TaskEdit,
  gen: number,
  serverTask: Task,
): TaskEntries {
  const prev = entries.get(taskId);
  if (prev === undefined) return entries;
  const next = makeEntry(prev);
  const { edit, gens, confirmedAt } = next;
  if (patch.status !== undefined && gens.status === gen) {
    edit.position = serverTask.position;
    gens.position = gen;
  }
  // Fields a newer write took over stay in flight; the rest keep showing
  // until a fetched task carries them or moves past this write.
  const stamp = Date.parse(serverTask.updatedAt);
  if (!Number.isNaN(stamp)) {
    for (const field of EDIT_FIELDS) {
      if (gens[field] === gen) confirmedAt[field] = stamp;
    }
  }
  return finalize(entries, taskId, next, prev.inFlight - 1);
}

export function settleFailure(
  entries: TaskEntries,
  taskId: string,
  patch: TaskEdit,
  gen: number,
): TaskEntries {
  const prev = entries.get(taskId);
  if (prev === undefined) return entries;
  const next = makeEntry(prev);
  for (const field of EDIT_FIELDS) {
    if (patch[field] !== undefined && next.gens[field] === gen) {
      delete next.edit[field];
      delete next.gens[field];
      delete next.confirmedAt[field];
    }
  }
  return finalize(entries, taskId, next, prev.inFlight - 1);
}

function sameEntry(a: TaskEntry, b: TaskEntry): boolean {
  if (a.inFlight !== b.inFlight) return false;
  for (const field of EDIT_FIELDS) {
    if (a.gens[field] !== b.gens[field]) return false;
    if (a.confirmedAt[field] !== b.confirmedAt[field]) return false;
    if (field === "labelIds") {
      if (!sameIds(a.edit.labelIds, b.edit.labelIds)) return false;
    } else if (a.edit[field] !== b.edit[field]) {
      return false;
    }
  }
  return true;
}

function sameEntries(a: TaskEntries, b: TaskEntries): boolean {
  if (a.size !== b.size) return false;
  for (const [id, entryA] of a) {
    const entryB = b.get(id);
    if (entryB === undefined || !sameEntry(entryA, entryB)) return false;
  }
  return true;
}

export function reconcileEntries(entries: TaskEntries, tasks: readonly Task[]): TaskEntries {
  if (entries.size === 0) return entries;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const next = new Map<string, TaskEntry>();
  for (const [id, entry] of entries) {
    const task = byId.get(id);
    if (task === undefined) continue;
    const fetchedAt = Date.parse(task.updatedAt);
    const edit: TaskEdit = {};
    const gens: Partial<Record<EditField, number>> = {};
    const confirmedAt: Partial<Record<EditField, number>> = {};
    for (const field of EDIT_FIELDS) {
      const value = entry.edit[field];
      if (value === undefined || fieldSettled(task, fetchedAt, field, entry)) continue;
      Object.assign(edit, { [field]: value });
      gens[field] = entry.gens[field];
      if (entry.confirmedAt[field] !== undefined) confirmedAt[field] = entry.confirmedAt[field];
    }
    if (hasFields(edit) || entry.inFlight > 0) {
      next.set(id, { edit, gens, confirmedAt, inFlight: entry.inFlight });
    }
  }
  return sameEntries(entries, next) ? entries : next;
}

export function pendingIds(entries: TaskEntries): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, entry] of entries) {
    if (entry.inFlight > 0) ids.add(id);
  }
  return ids;
}
