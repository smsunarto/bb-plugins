import { createCollection, createOptimisticAction, type IR } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import {
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskThread,
} from "../shared/contract.js";
import { TASKS_PAGE_MAX_LIMIT } from "../shared/pagination.js";
import { tasksQueryClient, tasksRpc, type TasksRpc } from "./query.js";

/**
 * Canonical Tasks entities. Each view's live query names the rows it needs;
 * the collection loads only that subset and every view shares the same rows,
 * so an edit, a realtime patch, or a refetch shows everywhere at once.
 */

type Expression = IR.BasicExpression;

/** The flat filter a live query's `where` can push down to the server. */
export interface TaskSubset {
  taskId?: string;
  taskKey?: string;
  taskIds?: string[];
  projectId?: string;
  parentTaskId?: string | null;
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  labelIds?: string[];
}

class UnsupportedSubsetError extends Error {
  constructor(collection: string, expression: Expression) {
    super(`The ${collection} collection cannot load ${JSON.stringify(expression)}`);
    this.name = "UnsupportedSubsetError";
  }
}

function refName(expression: Expression | undefined): string | null {
  return expression?.type === "ref" && expression.path.length === 1
    ? (expression.path[0] ?? null)
    : null;
}

function value(expression: Expression | undefined): unknown {
  return expression?.type === "val" ? expression.value : undefined;
}

function conjuncts(where: Expression | undefined): Expression[] {
  if (where === undefined) return [];
  if (where.type === "func" && where.name === "and") return where.args.flatMap(conjuncts);
  return [where];
}

function strings(input: unknown): string[] | null {
  return Array.isArray(input) && input.every((entry) => typeof entry === "string")
    ? [...input]
    : null;
}

/** `or(inArray(id, task.labelIds), …)`: the task carries any of these labels. */
function labelIdsOf(expression: Expression): string[] | null {
  const terms =
    expression.type === "func" && expression.name === "or" ? expression.args : [expression];
  const ids: string[] = [];
  for (const term of terms) {
    if (term.type !== "func" || term.name !== "in") return null;
    const [label, field] = term.args;
    if (refName(field) !== "labelIds" || typeof value(label) !== "string") return null;
    ids.push(value(label) as string);
  }
  return ids;
}

export function readTaskSubset(where: Expression | undefined): TaskSubset {
  const subset: TaskSubset = {};
  for (const term of conjuncts(where)) {
    const labelIds = labelIdsOf(term);
    if (labelIds !== null) {
      subset.labelIds = labelIds;
      continue;
    }
    if (term.type !== "func") throw new UnsupportedSubsetError("tasks", term);
    const [left, right] = term.args;
    const field = refName(left);
    if (term.name === "isNull" && field === "parentTaskId") {
      subset.parentTaskId = null;
    } else if (term.name === "eq" && typeof value(right) === "string") {
      const target = value(right) as string;
      if (field === "id") subset.taskId = target;
      else if (field === "key") subset.taskKey = target;
      else if (field === "projectId") subset.projectId = target;
      else if (field === "parentTaskId") subset.parentTaskId = target;
      else throw new UnsupportedSubsetError("tasks", term);
    } else if (term.name === "in" && strings(value(right)) !== null) {
      const targets = strings(value(right))!;
      if (field === "id") subset.taskIds = targets;
      else if (field === "status") subset.statuses = targets as TaskStatus[];
      else if (field === "priority") subset.priorities = targets as TaskPriority[];
      else throw new UnsupportedSubsetError("tasks", term);
    } else {
      throw new UnsupportedSubsetError("tasks", term);
    }
  }
  return subset;
}

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += TASKS_PAGE_MAX_LIMIT) {
    result.push(items.slice(start, start + TASKS_PAGE_MAX_LIMIT));
  }
  return result;
}

type TaskListInput = Omit<TaskSubset, "taskId" | "taskKey">;

/** Every page of one listTasks query. */
export async function listAllTasks(rpc: TasksRpc, input: TaskListInput = {}): Promise<Task[]> {
  if (input.taskIds !== undefined && input.taskIds.length > TASKS_PAGE_MAX_LIMIT) {
    const pages = await Promise.all(
      chunks(input.taskIds).map((taskIds) => listAllTasks(rpc, { ...input, taskIds })),
    );
    return pages.flat();
  }
  const tasks: Task[] = [];
  let cursor: string | undefined;
  do {
    const page = await rpc.call("listTasks", {
      ...input,
      limit: TASKS_PAGE_MAX_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    tasks.push(...page.tasks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return tasks;
}

async function loadTasks(subset: TaskSubset): Promise<Task[]> {
  const rpc = tasksRpc();
  if (subset.taskKey !== undefined) {
    const { task } = await rpc.call("getTaskByKey", { taskKey: subset.taskKey });
    return task === null ? [] : [task];
  }
  if (subset.taskId !== undefined) {
    const { task } = await rpc.call("getTask", { taskId: subset.taskId });
    return task === null ? [] : [task];
  }
  if (subset.taskIds?.length === 0) return [];
  return listAllTasks(rpc, subset);
}

const EDITABLE_TASK_FIELDS = [
  "title",
  "status",
  "priority",
  "dueDate",
  "labelIds",
  "parentTaskId",
] as const;

export type TaskEdit = Partial<Pick<Task, (typeof EDITABLE_TASK_FIELDS)[number]>>;

function taskEdit(changes: Partial<Task>): TaskEdit {
  const edit: TaskEdit = {};
  for (const field of EDITABLE_TASK_FIELDS) {
    if (changes[field] !== undefined) Object.assign(edit, { [field]: changes[field] });
  }
  return edit;
}

export class TaskWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskWriteRefusedError";
  }
}

/**
 * Per task, the newest server version (`updatedAt`) written into the
 * collection, including writes it holds back while an edit is persisting.
 */
const writtenVersions = new Map<string, number>();

function versionOf(task: Pick<Task, "updatedAt"> | undefined): number {
  const version = task === undefined ? Number.NaN : Date.parse(task.updatedAt);
  return Number.isNaN(version) ? Number.NEGATIVE_INFINITY : version;
}

/**
 * Write a task the server returned, unless the collection already holds a
 * newer version: a late realtime read or an out-of-order write response
 * never replaces what a later write or refresh delivered.
 */
export async function writeServerTask(task: Task): Promise<void> {
  const known = Math.max(
    writtenVersions.get(task.id) ?? Number.NEGATIVE_INFINITY,
    versionOf(tasksCollection.get(task.id)),
  );
  const version = versionOf(task);
  if (version < known) return;
  writtenVersions.set(task.id, version);
  await tasksCollection.utils.writeUpsert(task);
}

/** Forget a task the server deleted. */
export async function deleteServerTask(taskId: string): Promise<void> {
  writtenVersions.delete(taskId);
  if (tasksCollection.has(taskId)) await tasksCollection.utils.writeDelete(taskId);
}

export const tasksCollection = createCollection(
  queryCollectionOptions<Task>({
    id: "tasks",
    queryClient: tasksQueryClient,
    queryKey: ["tasks"],
    syncMode: "on-demand",
    getKey: (task) => task.id,
    queryFn: (context) => loadTasks(readTaskSubset(context.meta?.loadSubsetOptions?.where)),
    // A property edit draws on the click and rolls back when the server refuses it.
    onUpdate: async ({ transaction }) => {
      await Promise.all(
        transaction.mutations.map(async (mutation) => {
          const result = await tasksRpc().call("updateTask", {
            taskId: mutation.original.id,
            ...taskEdit(mutation.changes),
          });
          if (!result.ok) throw new TaskWriteRefusedError(result.error.message);
          await writeServerTask(result.task);
        }),
      );
      return { refetch: false };
    },
  }),
);

export class TaskGoneError extends Error {
  constructor() {
    super("This task was deleted");
    this.name = "TaskGoneError";
  }
}

export function editTask(taskId: string, edit: TaskEdit): Promise<unknown> {
  if (!tasksCollection.has(taskId)) return Promise.reject(new TaskGoneError());
  const transaction = tasksCollection.update(taskId, (draft) => {
    Object.assign(draft, edit);
  });
  return transaction.when("settled");
}

export interface BoardMove {
  taskId: string;
  status: TaskStatus;
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

function positionBetween(before: Task | undefined, after: Task | undefined, current: number) {
  if (before && after) return (before.position + after.position) / 2;
  if (before) return before.position + 1;
  if (after) return after.position - 1;
  return current;
}

/** A dropped card lands in its new column at once; the server's position replaces the estimate. */
export const moveBoardTask = createOptimisticAction<BoardMove>({
  onMutate: (move) => {
    const before = move.beforeTaskId ? tasksCollection.get(move.beforeTaskId) : undefined;
    const after = move.afterTaskId ? tasksCollection.get(move.afterTaskId) : undefined;
    tasksCollection.update(move.taskId, (draft) => {
      draft.status = move.status;
      draft.position = positionBetween(before, after, draft.position);
    });
  },
  mutationFn: async (move) => {
    const result = await tasksRpc().call("boardMove", { ...move, authorName: "You" });
    if (!result.ok) throw new TaskWriteRefusedError(result.error.message);
    await writeServerTask(result.task);
  },
});

/** One row per requested task; the board joins these onto its cards. */
export interface AttachmentCount {
  taskId: string;
  count: number;
}

function taskIdsOf(where: Expression | undefined): string[] {
  const ids: string[] = [];
  for (const term of conjuncts(where)) {
    const field = term.type === "func" ? refName(term.args[0]) : null;
    const target = term.type === "func" ? value(term.args[1]) : undefined;
    if (
      field === "taskId" &&
      term.type === "func" &&
      term.name === "eq" &&
      typeof target === "string"
    ) {
      ids.push(target);
    } else if (
      field === "taskId" &&
      term.type === "func" &&
      term.name === "in" &&
      strings(target)
    ) {
      ids.push(...strings(target)!);
    } else {
      throw new UnsupportedSubsetError("attachment counts", term);
    }
  }
  return [...new Set(ids)];
}

/** Tasks a view asked to count whose count read failed. */
const uncountedTaskIds = new Set<string>();

/** Whether a view shows this task's attachment count, or tried to and failed. */
export function showsAttachmentCount(taskId: string): boolean {
  return attachmentCountsCollection.has(taskId) || uncountedTaskIds.has(taskId);
}

export async function countAttachments(taskIds: readonly string[]): Promise<AttachmentCount[]> {
  const pages = await Promise.all(
    chunks(taskIds).map((ids) => tasksRpc().call("countTaskAttachments", { taskIds: ids })),
  );
  return pages.flatMap((page) => page.counts);
}

export const attachmentCountsCollection = createCollection(
  queryCollectionOptions<AttachmentCount>({
    id: "attachment-counts",
    queryClient: tasksQueryClient,
    queryKey: ["attachmentCounts"],
    syncMode: "on-demand",
    getKey: (row) => row.taskId,
    // A card without its count still renders, the way it did before counts
    // were batched: an unavailable count reads as no attachments until a
    // later signal for that task counts it again.
    queryFn: async (context): Promise<AttachmentCount[]> => {
      const taskIds = taskIdsOf(context.meta?.loadSubsetOptions?.where);
      try {
        const counts = await countAttachments(taskIds);
        for (const taskId of taskIds) uncountedTaskIds.delete(taskId);
        return counts;
      } catch {
        // Keep counts a view already shows; mark the rest for the next signal.
        for (const taskId of taskIds) uncountedTaskIds.add(taskId);
        return taskIds.flatMap((taskId): AttachmentCount[] => {
          const shown: AttachmentCount | undefined = attachmentCountsCollection.get(taskId);
          return shown === undefined ? [] : [shown];
        });
      }
    },
  }),
);

export const ACTIVE_THREAD_STATUSES = [
  "starting",
  "working",
] as const satisfies readonly TaskThread["liveStatus"][];

async function loadTaskThreads(where: Expression | undefined): Promise<TaskThread[]> {
  const [term, ...rest] = conjuncts(where);
  if (term?.type !== "func" || rest.length > 0)
    throw new UnsupportedSubsetError("task threads", where!);
  const field = refName(term.args[0]);
  const target = value(term.args[1]);
  const rpc = tasksRpc();
  if (term.name === "eq" && field === "taskId" && typeof target === "string") {
    return (await rpc.call("listTaskThreads", { taskId: target })).taskThreads;
  }
  if (term.name === "eq" && field === "threadId" && typeof target === "string") {
    return (await rpc.call("listTaskThreadsByThread", { threadId: target })).taskThreads;
  }
  const statuses = strings(target);
  if (
    term.name === "in" &&
    field === "liveStatus" &&
    statuses?.length === ACTIVE_THREAD_STATUSES.length &&
    ACTIVE_THREAD_STATUSES.every((status) => statuses.includes(status))
  ) {
    return (await rpc.call("listActiveTaskThreads")).taskThreads;
  }
  throw new UnsupportedSubsetError("task threads", term);
}

/** Task ↔ agent thread links: every task's live ones, one task's all, or one thread's. */
export const taskThreadsCollection = createCollection(
  queryCollectionOptions<TaskThread>({
    id: "task-threads",
    queryClient: tasksQueryClient,
    queryKey: ["taskThreads"],
    syncMode: "on-demand",
    getKey: (link) => link.id,
    queryFn: (context) => loadTaskThreads(context.meta?.loadSubsetOptions?.where),
  }),
);

export const OPEN_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => status !== "done" && status !== "canceled",
);

export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "canceled"];

export async function resetTasksCollectionsForTest(): Promise<void> {
  writtenVersions.clear();
  uncountedTaskIds.clear();
  // A live query still subscribed when its source is cleaned up replays its
  // subsets once the source restarts, so wait for unmounted ones to collect.
  const sources = [tasksCollection, attachmentCountsCollection, taskThreadsCollection];
  for (let waited = 0; waited < 1_000 && sources.some((source) => source.subscriberCount > 0);) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    waited += 5;
  }
  await Promise.all([
    tasksCollection.cleanup(),
    attachmentCountsCollection.cleanup(),
    taskThreadsCollection.cleanup(),
  ]);
}
