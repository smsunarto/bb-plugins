import { describe, expect, it } from "vitest";
import {
  createLiveQueryCollection,
  eq,
  inArray,
  isNull,
  or,
  type InitialQueryBuilder,
  type QueryBuilder,
  type Context,
} from "@tanstack/react-db";
import { makeTask } from "../test-fixtures.js";
import {
  ACTIVE_THREAD_STATUSES,
  attachmentCountsCollection,
  editTask,
  showsAttachmentCount,
  TaskGoneError,
  taskThreadsCollection,
  tasksCollection,
  writeServerTask,
} from "./collections.js";
import { setTasksRpc, tasksQueryClient, type TasksRpc } from "./query.js";

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT1", projectId: PROJECT_ID, key: "TSK-1" });

type Calls = { method: string; input: unknown }[];

function fakeRpc(handlers: Record<string, (input: never) => unknown>): Calls {
  const calls: Calls = [];
  setTasksRpc({
    call: async (method: string, input: unknown) => {
      calls.push({ method, input });
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`unexpected ${method}`);
      return handler(input as never);
    },
  } as unknown as TasksRpc);
  return calls;
}

async function load<TContext extends Context>(
  query: (q: InitialQueryBuilder) => QueryBuilder<TContext>,
) {
  const live = createLiveQueryCollection({ query, startSync: true });
  await live.preload();
  const rows = live.toArray;
  await live.cleanup();
  return rows;
}

describe("tasks collection loads only what a live query names", () => {
  it("pushes project, top-level, status, priority, and label filters into one listTasks read", async () => {
    const match = {
      ...TASK,
      status: "todo" as const,
      priority: "urgent" as const,
      labelIds: ["lbl_2"],
    };
    const calls = fakeRpc({ listTasks: () => ({ tasks: [match], nextCursor: null }) });
    const rows = await load((q) =>
      q
        .from({ task: tasksCollection })
        .where(({ task }) => isNull(task.parentTaskId))
        .where(({ task }) => eq(task.projectId, PROJECT_ID))
        .where(({ task }) => inArray(task.status, ["todo", "in_progress"]))
        .where(({ task }) => inArray(task.priority, ["urgent"]))
        .where(({ task }) => or(inArray("lbl_1", task.labelIds), inArray("lbl_2", task.labelIds))),
    );
    expect(calls).toEqual([
      {
        method: "listTasks",
        input: {
          parentTaskId: null,
          projectId: PROJECT_ID,
          statuses: ["todo", "in_progress"],
          priorities: ["urgent"],
          labelIds: ["lbl_1", "lbl_2"],
          limit: 500,
        },
      },
    ]);
    expect(rows.map((task) => task.id)).toEqual([match.id]);
  });

  it("reads one task by key without listing", async () => {
    const calls = fakeRpc({ getTaskByKey: () => ({ task: TASK }) });
    const rows = await load((q) =>
      q.from({ task: tasksCollection }).where(({ task }) => eq(task.key, "TSK-1")),
    );
    expect(calls).toEqual([{ method: "getTaskByKey", input: { taskKey: "TSK-1" } }]);
    expect(rows.map((task) => task.title)).toEqual([TASK.title]);
  });

  it("needs no read for an empty id set", async () => {
    const calls = fakeRpc({});
    const rows = await load((q) =>
      q.from({ task: tasksCollection }).where(({ task }) => inArray(task.id, [])),
    );
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("refuses a filter the server cannot apply instead of loading everything", async () => {
    const calls = fakeRpc({ listTasks: () => ({ tasks: [], nextCursor: null }) });
    await expect(
      load((q) => q.from({ task: tasksCollection }).where(({ task }) => eq(task.title, "x"))),
    ).rejects.toThrow(/cannot load/);
    expect(calls).toEqual([]);
  });
});

describe("server task versions", () => {
  it("keeps the newest version when an older read or write response lands late", async () => {
    const original = { ...TASK, title: "Original", updatedAt: "2026-07-15T00:00:00.000Z" };
    fakeRpc({ getTaskByKey: () => ({ task: original }) });
    const live = createLiveQueryCollection({
      query: (q) => q.from({ task: tasksCollection }).where(({ task }) => eq(task.key, "TSK-1")),
      startSync: true,
    });
    await live.preload();

    await writeServerTask({ ...TASK, title: "Second edit", updatedAt: "2026-07-15T00:00:02.000Z" });
    await writeServerTask({ ...TASK, title: "First edit", updatedAt: "2026-07-15T00:00:01.000Z" });
    await writeServerTask({ ...original, title: "Stale read" });
    expect(live.toArray.map((task) => task.title)).toEqual(["Second edit"]);

    // The same version is the same server state, so it still applies.
    await writeServerTask({
      ...TASK,
      title: "Second, reread",
      updatedAt: "2026-07-15T00:00:02.000Z",
    });
    expect(live.toArray.map((task) => task.title)).toEqual(["Second, reread"]);
    await live.cleanup();
  });

  // query-db-collection keeps a direct write over a refetch that started before it.
  it("keeps a confirmed write when a list refetch that started before it lands after it", async () => {
    const before = { ...TASK, title: "Before the edit", updatedAt: "2026-07-15T00:00:00.000Z" };
    let answerRefetch: (() => void) | undefined;
    let reads = 0;
    fakeRpc({
      listTasks: () =>
        answerRefetch === undefined && reads++ === 0
          ? { tasks: [before], nextCursor: null }
          : new Promise((resolve) => {
              answerRefetch = () => resolve({ tasks: [before], nextCursor: null });
            }),
    });
    const live = createLiveQueryCollection({
      query: (q) =>
        q.from({ task: tasksCollection }).where(({ task }) => eq(task.projectId, PROJECT_ID)),
      startSync: true,
    });
    await live.preload();
    expect(live.toArray.map((task) => task.title)).toEqual(["Before the edit"]);

    const refetch = tasksQueryClient.invalidateQueries({ queryKey: ["tasks"] });
    await expect.poll(() => answerRefetch).toBeDefined();
    await writeServerTask({ ...TASK, title: "Edited", updatedAt: "2026-07-16T00:00:00.000Z" });
    answerRefetch!();
    await refetch;
    expect(live.toArray.map((task) => task.title)).toEqual(["Edited"]);
    await live.cleanup();
  });

  it("rejects an edit to a task that is gone instead of throwing", async () => {
    await expect(editTask("01HZZZZZZZZZZZZZZZZZZZZZT9", { title: "x" })).rejects.toBeInstanceOf(
      TaskGoneError,
    );
  });
});

describe("relationship collections", () => {
  it("loads a thread's task links and every live agent link in one read each", async () => {
    const link = {
      id: "01HZZZZZZZZZZZZZZZZZZZZZH1",
      taskId: TASK.id,
      threadId: "thr_worker",
      presetName: "Sonnet",
      title: "Worker",
      liveStatus: "working" as const,
      attachedAt: TASK.createdAt,
      updatedAt: TASK.createdAt,
    };
    const calls = fakeRpc({
      listTaskThreadsByThread: () => ({ taskThreads: [link] }),
      listActiveTaskThreads: () => ({ taskThreads: [link] }),
    });
    await load((q) =>
      q.from({ link: taskThreadsCollection }).where(({ link }) => eq(link.threadId, "thr_worker")),
    );
    await load((q) =>
      q
        .from({ link: taskThreadsCollection })
        .where(({ link }) => inArray(link.liveStatus, [...ACTIVE_THREAD_STATUSES])),
    );
    expect(calls).toEqual([
      { method: "listTaskThreadsByThread", input: { threadId: "thr_worker" } },
      { method: "listActiveTaskThreads", input: undefined },
    ]);
  });

  it("counts attachments for many tasks in one read and tolerates its failure", async () => {
    const calls = fakeRpc({
      countTaskAttachments: () => {
        throw new Error("attachments offline");
      },
    });
    const rows = await load((q) =>
      q
        .from({ count: attachmentCountsCollection })
        .where(({ count }) => inArray(count.taskId, [TASK.id, "01HZZZZZZZZZZZZZZZZZZZZZT2"])),
    );
    expect(calls).toEqual([
      {
        method: "countTaskAttachments",
        input: { taskIds: [TASK.id, "01HZZZZZZZZZZZZZZZZZZZZZT2"] },
      },
    ]);
    expect(rows).toEqual([]);
    // The card still counts as shown, so its next signal counts it again.
    expect(showsAttachmentCount(TASK.id)).toBe(true);
  });

  it("keeps counts already shown when a refetch fails", async () => {
    let up = true;
    fakeRpc({
      countTaskAttachments: () => {
        if (!up) throw new Error("attachments offline");
        return { counts: [{ taskId: TASK.id, count: 2 }] };
      },
    });
    const live = createLiveQueryCollection({
      query: (q) =>
        q
          .from({ count: attachmentCountsCollection })
          .where(({ count }) => inArray(count.taskId, [TASK.id])),
      startSync: true,
    });
    await live.preload();
    expect(live.toArray.map((row) => row.count)).toEqual([2]);
    up = false;
    await tasksQueryClient.invalidateQueries({ queryKey: ["attachmentCounts"] });
    expect(live.toArray.map((row) => row.count)).toEqual([2]);
    await live.cleanup();
  });
});
