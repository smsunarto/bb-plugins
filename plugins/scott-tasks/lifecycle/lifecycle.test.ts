import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "../api";
import type { TaskThreadLiveStatus } from "../db";
import {
  registerLifecycle,
  THREAD_STATUS_IDLE_INTERVAL_MS,
  THREAD_STATUS_RECONCILE_CONCURRENCY,
  THREAD_STATUS_RECONCILE_INTERVAL_MS,
} from ".";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

/** Start the reconcile service and let its startup sweep's reads settle. */
async function startReconcile(harness: Harness) {
  const service = harness.runService("thread-status-reconcile");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return async () => {
    service.controller.abort();
    await service.done;
  };
}

interface TrackedThreadFixture {
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  harness: ReturnType<typeof createFakePluginHost>["harness"];
  store: ReturnType<typeof createStore>;
  taskId: string;
  taskThreadId: string;
}

function trackedThreadFixture(
  liveStatus: TaskThreadLiveStatus,
  sdkStatus: "idle" | "starting" | "active" | "stopping" | "error",
): TrackedThreadFixture {
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "thr_worker",
            title: "Lifecycle worker",
            status: sdkStatus,
          }),
      },
    },
  });
  const store = createStore(host.bb);
  const project = store.tasks.createProject({
    name: "Tasks plugin",
    prefix: "TASK",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Track lifecycle",
  });
  const taskThread = store.tasks.upsertTaskThread({
    taskId: task.id,
    threadId: "thr_worker",
    presetName: "GPT-5.6 · high",
    title: "Lifecycle worker",
    liveStatus,
  });

  return {
    ...host,
    store,
    taskId: task.id,
    taskThreadId: taskThread.id,
  };
}

describe("task thread lifecycle", () => {
  it("registers without reading bb, then reconciles each non-terminal thread in the service", async () => {
    const fixture = trackedThreadFixture("working", "active");

    registerLifecycle(fixture.bb, fixture.store);
    expect(fixture.harness.sdk.callsTo("threads.get")).toEqual([]);

    const stop = await startReconcile(fixture.harness);
    expect(fixture.harness.sdk.callsTo("threads.get")).toEqual([[{ threadId: "thr_worker" }]]);

    await stop();
    await fixture.harness.dispose();
  });

  it("finishes plugin load while bb's thread reads hang", async () => {
    const { default: plugin } = await import("../server");
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { get: () => new Promise(() => {}) } },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Hang", prefix: "HANG", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Slow host" });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_hanging",
      presetName: "Default",
      title: "Hanging worker",
      liveStatus: "working",
    });

    await plugin(host.bb);
    expect(host.harness.sdk.callsTo("threads.get")).toEqual([]);
    await expect(host.harness.callRpc("ping", null)).resolves.toMatchObject({ ok: true });

    const service = host.harness.runService("thread-status-reconcile");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.harness.sdk.callsTo("threads.get")).toEqual([[{ threadId: "thr_hanging" }]]);
    service.controller.abort();
    await host.harness.dispose();
  });

  it("reads only starting, working, and idle rows, from one query and never per task", async () => {
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: "active" }),
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Scope", prefix: "SCP", color: "blue" });
    const statuses: TaskThreadLiveStatus[] = [
      "starting",
      "working",
      "idle",
      "archived",
      "failed",
      "completed",
    ];
    for (const liveStatus of statuses) {
      const task = store.tasks.createTask({ projectId: project.id, title: liveStatus });
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: `thr_${liveStatus}`,
        presetName: "Default",
        title: liveStatus,
        liveStatus,
      });
    }
    registerLifecycle(host.bb, store);
    const listTasks = vi.spyOn(store.tasks, "listTasks");
    const listTaskThreads = vi.spyOn(store.tasks, "listTaskThreads");

    const stop = await startReconcile(host.harness);

    expect(
      host.harness.sdk
        .callsTo("threads.get")
        .map(([input]) => (input as { threadId: string }).threadId)
        .sort(),
    ).toEqual(["thr_idle", "thr_starting", "thr_working"]);
    expect(listTasks).not.toHaveBeenCalled();
    expect(listTaskThreads).not.toHaveBeenCalled();
    await stop();
    await host.harness.dispose();
  });

  it("stops starting reads once the service is aborted", async () => {
    const pending: Array<() => void> = [];
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: ({ threadId }) =>
            new Promise((resolve) => {
              pending.push(() => resolve(makeThreadResponse({ id: threadId, status: "active" })));
            }),
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Abort", prefix: "ABT", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Many workers" });
    for (let index = 0; index < 10; index += 1) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: `thr_abort_${index}`,
        presetName: "Default",
        title: `Worker ${index}`,
        liveStatus: "working",
      });
    }
    registerLifecycle(host.bb, store);
    const service = host.harness.runService("thread-status-reconcile");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(
      THREAD_STATUS_RECONCILE_CONCURRENCY,
    );

    service.controller.abort();
    for (const resolve of pending.splice(0)) resolve();
    await service.done;
    expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(
      THREAD_STATUS_RECONCILE_CONCURRENCY,
    );
    await host.harness.dispose();
  });

  it("moves a working thread to completed, comments, and publishes", async () => {
    const fixture = trackedThreadFixture("working", "active");
    registerLifecycle(fixture.bb, fixture.store);

    await fixture.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        deletedAt: Date.now(),
      }),
    });

    expect(fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus).toBe("completed");
    expect(fixture.store.tasks.listComments(fixture.taskId)).toContainEqual(
      expect.objectContaining({
        source: {
          kind: "system",
          origin: { presetName: "GPT-5.6 · high", threadId: "thr_worker" },
        },
        authorName: "Tasks",
        body: 'Thread "Lifecycle worker" completed — final message posted · thr_worker',
      }),
    );
    expect(fixture.harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: fixture.taskId } },
      { channel: "comments:changed", payload: { taskId: fixture.taskId } },
    ]);

    await fixture.harness.dispose();
  });

  it("recovers a failed thread without recording failure as terminal", async () => {
    const fixture = trackedThreadFixture("working", "active");
    registerLifecycle(fixture.bb, fixture.store);

    await fixture.harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        status: "error",
      }),
      error: "provider exited",
    });

    expect(fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus).toBe("failed");
    const commentsAfterFailure = fixture.store.tasks.listComments(fixture.taskId);
    expect(commentsAfterFailure).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({ kind: "system" }),
        body: 'Thread "Lifecycle worker" failed · thr_worker',
      }),
    );
    expect(fixture.harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: fixture.taskId } },
      { channel: "comments:changed", payload: { taskId: fixture.taskId } },
    ]);

    await fixture.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        status: "active",
      }),
    });
    expect(fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus).toBe("working");
    expect(fixture.store.tasks.listComments(fixture.taskId)).toEqual(commentsAfterFailure);

    await fixture.harness.dispose();
  });

  it("sets archived on thread.archived and restores the run status on thread.unarchived", async () => {
    const fixture = trackedThreadFixture("idle", "idle");
    registerLifecycle(fixture.bb, fixture.store);
    const status = () => fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus;

    await fixture.harness.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_worker", status: "idle", archivedAt: Date.now() }),
    });
    expect(status()).toBe("archived");

    await fixture.harness.emitThreadEvent("thread.unarchived", {
      thread: makeThreadResponse({ id: "thr_worker", status: "idle", archivedAt: null }),
    });
    expect(status()).toBe("idle");
    expect(fixture.store.tasks.listComments(fixture.taskId)).toEqual([]);

    await fixture.harness.dispose();
  });

  it("leaves archived rows to thread events instead of re-reading them", async () => {
    vi.useFakeTimers();
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ id: "thr_archived", status: "idle" }),
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Archive", prefix: "ARC", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Finished crew" });
    const tracked = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_archived",
      presetName: "Implement",
      title: "Finished crew",
      liveStatus: "archived",
    });

    try {
      registerLifecycle(host.bb, store);
      const service = host.harness.runService("thread-status-reconcile");
      await vi.advanceTimersByTimeAsync(THREAD_STATUS_RECONCILE_INTERVAL_MS * 2);
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([]);
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("archived");

      await host.harness.emitThreadEvent("thread.unarchived", {
        thread: makeThreadResponse({ id: "thr_archived", status: "idle", archivedAt: null }),
      });
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("idle");

      service.controller.abort();
      await service.done;
    } finally {
      vi.useRealTimers();
      await host.harness.dispose();
    }
  });

  it("reconciles a stale non-terminal row on load", async () => {
    const fixture = trackedThreadFixture("starting", "idle");

    registerLifecycle(fixture.bb, fixture.store);
    const stop = await startReconcile(fixture.harness);

    expect(fixture.harness.sdk.callsTo("threads.get")).toEqual([[{ threadId: "thr_worker" }]]);
    expect(fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus).toBe("idle");
    expect(fixture.harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: fixture.taskId } },
      { channel: "comments:changed", payload: { taskId: fixture.taskId } },
    ]);

    await stop();
    await fixture.harness.dispose();
  });

  it("registers all lifecycle listeners before startup reconciliation", async () => {
    let handlersAtFirstRead:
      | ReturnType<typeof createFakePluginHost>["harness"]["registrations"]["threadEventHandlers"]
      | undefined;
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => {
            handlersAtFirstRead = host.harness.registrations.threadEventHandlers;
            return makeThreadResponse({
              id: "thr_fast",
              status: "starting",
            });
          },
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({
      name: "Fast lifecycle",
      prefix: "FAST",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Catch active",
    });
    const tracked = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_fast",
      presetName: "Default",
      title: "Fast worker",
      liveStatus: "starting",
    });

    registerLifecycle(host.bb, store);
    const stop = await startReconcile(host.harness);

    expect(handlersAtFirstRead).toMatchObject({
      "thread.created": 1,
      "thread.active": 1,
      "thread.idle": 1,
      "thread.failed": 1,
      "thread.deleted": 1,
      "interaction.pending": 0,
      "message.queued": 0,
      "message.dispatched": 0,
      "turn.failed": 0,
      "message.cancelled": 0,
      "thread.archived": 1,
      "thread.unarchived": 1,
    });
    expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(1);
    expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("starting");

    await stop();
    await host.harness.dispose();
  });

  it("moves a starting thread to working from thread.active without an SDK subscription", async () => {
    const fixture = trackedThreadFixture("starting", "starting");
    registerLifecycle(fixture.bb, fixture.store);

    await fixture.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_worker",
        title: "Lifecycle worker",
        status: "active",
      }),
    });

    expect(fixture.store.tasks.getTaskThread(fixture.taskThreadId)?.liveStatus).toBe("working");
    expect(fixture.harness.sdk.callsTo("threads.get")).toEqual([]);
    expect(fixture.harness.sdk.callsTo("subscribe")).toEqual([]);

    await fixture.harness.dispose();
  });

  it("sweeps active threads every five minutes as a missed-event safety net", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => {
            reads += 1;
            return makeThreadResponse({
              id: "thr_safety_net",
              status: reads === 1 ? "starting" : "active",
            });
          },
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({
      name: "Safety net lifecycle",
      prefix: "SAFE",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Recover a missed event",
    });
    const tracked = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_safety_net",
      presetName: "Default",
      title: "Safety net worker",
      liveStatus: "starting",
    });

    try {
      registerLifecycle(host.bb, store);
      const service = host.harness.runService("thread-status-reconcile");

      await vi.advanceTimersByTimeAsync(THREAD_STATUS_RECONCILE_INTERVAL_MS - 1);
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("starting");

      await vi.advanceTimersByTimeAsync(1);
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("working");
      expect(host.harness.sdk.callsTo("subscribe")).toEqual([]);
      service.controller.abort();
      await service.done;
    } finally {
      vi.useRealTimers();
      await host.harness.dispose();
    }
  });

  it("backs off reconciliation while no non-terminal task threads exist", async () => {
    vi.useFakeTimers();
    const host = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => makeThreadResponse({ id: "thr_later", status: "active" }),
        },
      },
    });
    const store = createStore(host.bb);
    const project = store.tasks.createProject({
      name: "Idle polling",
      prefix: "IDLE",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach later",
    });

    try {
      registerLifecycle(host.bb, store);
      const service = host.harness.runService("thread-status-reconcile");
      // The startup sweep finds nothing, so the service settles into its idle wait.
      await vi.advanceTimersByTimeAsync(0);
      const tracked = store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: "thr_later",
        presetName: "Default",
        title: "Later worker",
        liveStatus: "starting",
      });

      await vi.advanceTimersByTimeAsync(THREAD_STATUS_IDLE_INTERVAL_MS);
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([]);

      await vi.advanceTimersByTimeAsync(THREAD_STATUS_RECONCILE_INTERVAL_MS - 1);
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(host.harness.sdk.callsTo("threads.get")).toEqual([[{ threadId: "thr_later" }]]);
      expect(store.tasks.getTaskThread(tracked.id)?.liveStatus).toBe("working");

      service.controller.abort();
      await service.done;
    } finally {
      vi.useRealTimers();
      await host.harness.dispose();
    }
  });

  it("ignores lifecycle events for non-tracked threads", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerLifecycle(bb, store);

    await harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_untracked", status: "error" }),
      error: "not ours",
    });

    expect(harness.realtimeSignals).toEqual([]);
    expect(store.tasks.listTasks()).toEqual([]);

    await harness.dispose();
  });

  it("looks up an unrelated lifecycle event without scanning tasks", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Lookup scope",
      prefix: "SCOPE",
      color: "blue",
    });
    for (let index = 0; index < 3; index += 1) {
      store.tasks.createTask({
        projectId: project.id,
        title: `Unrelated task ${index}`,
      });
    }
    registerLifecycle(bb, store);
    const listTasks = vi.spyOn(store.tasks, "listTasks");
    const listTaskThreads = vi.spyOn(store.tasks, "listTaskThreads");

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_untracked", status: "idle" }),
      lastAssistantText: null,
    });

    expect({
      listTasks: listTasks.mock.calls.length,
      listTaskThreads: listTaskThreads.mock.calls.length,
    }).toEqual({ listTasks: 0, listTaskThreads: 0 });

    await harness.dispose();
  });
});
