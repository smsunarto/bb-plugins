import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComment, createStore } from "../api";
import { deliverParentNotification, registerParentNotifyRedelivery } from ".";

type Thread = ReturnType<typeof makeThreadResponse>;

const CREW = makeThreadResponse({ id: "thr_crew", parentThreadId: "thr_captain" });
const CAPTAIN = makeThreadResponse({ id: "thr_captain", status: "idle" });

function notFound(threadId: string): Error {
  return Object.assign(new Error(`thread not found: ${threadId}`), { code: "thread_not_found" });
}

interface SetupOptions {
  threads?: Thread[];
  send?: () => Promise<void>;
}

function setup(options: SetupOptions = {}) {
  vi.useFakeTimers({ now: new Date("2026-11-16T10:00:00.000Z") });
  const threads = new Map(
    (options.threads ?? [CREW, CAPTAIN]).map((thread) => [thread.id, thread]),
  );
  const sends: string[] = [];
  const host = createFakePluginHost({
    pluginId: "scott-tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw notFound(threadId);
          return thread;
        },
        send: async () => {
          sends.push(new Date().toISOString());
          await options.send?.();
        },
      },
    },
  });
  const store = createStore(host.bb);
  registerParentNotifyRedelivery(host.bb, store.tasks);
  const project = store.tasks.createProject({ name: "Plugins", prefix: "PLUG", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Unity check" });
  store.tasks.upsertTaskThread({
    taskId: task.id,
    threadId: "thr_crew",
    presetName: "Implement",
    title: "Unity check",
    liveStatus: "working",
  });
  const report = (body: string, threadId = "thr_crew") =>
    createComment(host.bb, store, {
      taskId: task.id,
      source: { kind: "agent", threadId },
      authorName: threadId,
      body,
      notify: false,
      awaitDelivery: true,
      notifyParent: true,
    });
  return { ...host, store, task, sends, report };
}

function failingSend(): Promise<void> {
  return Promise.reject(new Error("server busy"));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parent wake lines", () => {
  it("sends one compact line to the commenting thread's parent and records delivery", async () => {
    const { harness, store, task, report } = setup();
    const { comment, parentNotification } = await report(
      "Final: PR opened\n\nChecks: unit tests pass.",
    );

    expect(parentNotification).toEqual({
      state: "delivered",
      targetThreadId: "thr_captain",
      attempts: 1,
      deliveredAt: "2026-11-16T10:00:00.000Z",
    });
    expect(store.tasks.getParentNotification(comment.id)).toEqual(parentNotification);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        {
          threadId: "thr_captain",
          input: [
            {
              type: "text",
              text: "[tasks] PLUG-1 Final: PR opened · thr_crew Implement",
              mentions: [],
            },
          ],
          mode: "steer-if-active",
        },
      ],
    ]);
    expect(store.tasks.listComments(task.id)).toHaveLength(1);

    await harness.dispose();
  });

  it("names the comment's own attachments in the line", async () => {
    const { bb, harness, store, task } = setup();
    const comment = store.tasks.createComment({
      taskId: task.id,
      source: { kind: "agent", threadId: "thr_crew" },
      authorName: "crew",
      body: "Blocked: Pick the Unity account for cloud crew\nDetails in unity-check.md.",
    });
    const report = store.tasks.createAttachment({
      owner: { kind: "comment", commentId: comment.id },
      fileName: "unity-check.md",
      mime: "text/markdown",
      sizeBytes: 1,
      blobPath: "blobs/unity-check.md",
      isImage: false,
    });
    store.tasks.createAttachment({
      owner: { kind: "task", taskId: task.id },
      fileName: "elsewhere.png",
      mime: "image/png",
      sizeBytes: 1,
      blobPath: "blobs/elsewhere.png",
      isImage: true,
    });
    store.tasks.startParentNotification(comment.id, null);

    await deliverParentNotification(bb, store.tasks, comment.id);

    expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
      input: [
        {
          text: `[tasks] PLUG-1 Blocked: Pick the Unity account for cloud crew · thr_crew Implement · ${report.id} unity-check.md`,
        },
      ],
    });
    await harness.dispose();
  });

  it("retries a failed send on the 1, 2, 5, 15 minute backoff and gives up after six attempts", async () => {
    const { harness, store, sends, report } = setup({ send: failingSend });
    const { comment, parentNotification } = await report("Final: done");
    expect(parentNotification).toEqual({
      state: "pending",
      targetThreadId: "thr_captain",
      attempts: 1,
      nextAttemptAt: "2026-11-16T10:01:00.000Z",
      lastError: "server busy",
    });

    const service = harness.runService("parent-notify-redelivery");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sends).toEqual([
      "2026-11-16T10:00:00.000Z",
      "2026-11-16T10:01:00.000Z",
      "2026-11-16T10:03:00.000Z",
      "2026-11-16T10:08:00.000Z",
      "2026-11-16T10:23:00.000Z",
      "2026-11-16T10:38:00.000Z",
    ]);
    expect(store.tasks.getParentNotification(comment.id)).toEqual({
      state: "undeliverable",
      targetThreadId: "thr_captain",
      attempts: 6,
      reason: "gave up after 6 attempts: server busy",
    });

    service.controller.abort();
    await service.done;
    await harness.dispose();
  });

  it("marks a wake undeliverable at once when the parent is archived, deleted or missing", async () => {
    const { harness, store, sends, report } = setup({
      threads: [
        makeThreadResponse({ id: "thr_crew", parentThreadId: "thr_captain" }),
        makeThreadResponse({ id: "thr_captain", archivedAt: Date.now() }),
        makeThreadResponse({ id: "thr_deleted_parent", parentThreadId: "thr_gone" }),
        makeThreadResponse({ id: "thr_orphan", parentThreadId: null }),
      ],
    });

    const archived = await report("Final: done");
    const deleted = await report("Final: done", "thr_deleted_parent");
    const orphan = await report("Final: done", "thr_orphan");

    expect([archived, deleted, orphan].map((posted) => posted.parentNotification)).toEqual([
      {
        state: "undeliverable",
        targetThreadId: "thr_captain",
        attempts: 1,
        reason: "parent thread thr_captain is archived",
      },
      {
        state: "undeliverable",
        targetThreadId: "thr_gone",
        attempts: 1,
        reason: "thread thr_gone was not found",
      },
      {
        state: "undeliverable",
        targetThreadId: null,
        attempts: 1,
        reason: "thread thr_orphan has no parent thread",
      },
    ]);
    expect(sends).toEqual([]);
    expect(store.tasks.listDueParentNotifications(10)).toEqual([]);
    await harness.dispose();
  });

  it("gives up without sending when a crash left the last attempt unrecorded", async () => {
    const { bb, harness, store, task, sends } = setup();
    const comment = store.tasks.createComment({
      taskId: task.id,
      source: { kind: "agent", threadId: "thr_crew" },
      authorName: "crew",
      body: "Final: done",
    });
    store.tasks.startParentNotification(comment.id, "thr_captain");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      store.tasks.claimParentNotificationAttempt(comment.id, attempt, new Date().toISOString());
    }

    await deliverParentNotification(bb, store.tasks, comment.id);

    expect(sends).toEqual([]);
    expect(store.tasks.getParentNotification(comment.id)).toEqual({
      state: "undeliverable",
      targetThreadId: "thr_captain",
      attempts: 6,
      reason: "gave up after 6 attempts",
    });
    await harness.dispose();
  });

  it("sends a claimed attempt once when the CLI and the timer race", async () => {
    let release = () => {};
    const { bb, harness, store, task, sends } = setup({
      send: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const comment = store.tasks.createComment({
      taskId: task.id,
      source: { kind: "agent", threadId: "thr_crew" },
      authorName: "crew",
      body: "Final: done",
    });
    store.tasks.startParentNotification(comment.id, "thr_captain");

    const first = deliverParentNotification(bb, store.tasks, comment.id);
    const second = deliverParentNotification(bb, store.tasks, comment.id);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await second;
    release();
    await Promise.all([first, second]);

    expect(sends).toHaveLength(1);
    expect(store.tasks.getParentNotification(comment.id)).toMatchObject({
      state: "delivered",
      attempts: 1,
    });
    await harness.dispose();
  });

  it("resumes an undelivered wake after a restart", async () => {
    const { harness, report } = setup({ send: failingSend });
    const { comment } = await report("Final: done");

    let reloadedStore: ReturnType<typeof createStore> | undefined;
    const reloaded = await harness.reload((bb) => {
      reloadedStore = createStore(bb);
      registerParentNotifyRedelivery(bb, reloadedStore.tasks);
    });
    reloaded.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      threadId === "thr_captain" ? CAPTAIN : CREW,
    );
    reloaded.harness.sdk.stub("threads.send", async () => undefined);

    await vi.advanceTimersByTimeAsync(60_000);
    const service = reloaded.harness.runService("parent-notify-redelivery");
    await vi.advanceTimersByTimeAsync(0);

    expect(reloaded.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(reloadedStore?.tasks.getParentNotification(comment.id)).toEqual({
      state: "delivered",
      targetThreadId: "thr_captain",
      attempts: 2,
      deliveredAt: "2026-11-16T10:01:00.000Z",
    });

    service.controller.abort();
    await service.done;
    await reloaded.harness.dispose();
  });
});

describe("expired wake attempts", () => {
  // Review's deterministic repro for BBP-13: the first attempt's thread lookup
  // stalls past its deadline, a retry delivers, then the stalled lookup resumes.
  it("does not send after a retry delivered when an expired lookup resumes", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-18T10:00:00Z") });
    let release!: (thread: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let gets = 0;
    const sends: unknown[] = [];
    let row = {
      state: "pending",
      targetThreadId: null as string | null,
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      lastError: null as string | null,
    };
    const store = {
      getParentNotification: () => row,
      claimParentNotificationAttempt: (_id: string, attempts: number, next: string) => {
        if (row.attempts !== attempts) return false;
        row = { ...row, attempts: attempts + 1, nextAttemptAt: next };
        return true;
      },
      getComment: () => ({
        id: "comment",
        taskId: "task",
        source: { kind: "agent", threadId: "thr_crew" },
        body: "Final: done",
      }),
      getTask: () => ({ id: "task", key: "T-1" }),
      setParentNotificationTarget: (_id: string, target: string) => {
        row.targetThreadId = target;
      },
      getTaskThreadByThreadId: () => ({ presetName: "Crew" }),
      listAttachmentsForComment: () => [],
      recordParentNotificationFailure: (_id: string, error: string) =>
        (row = { ...row, lastError: error }),
      recordParentNotificationDelivered: (_id: string, target: string) =>
        (row = { ...row, state: "delivered", targetThreadId: target }),
    };
    const bb = {
      log: { warn: () => {} },
      sdk: {
        threads: {
          get: async () => {
            gets += 1;
            if (gets === 1) return blocked;
            return { parentThreadId: "thr_parent", archivedAt: null, deletedAt: null };
          },
          send: async (input: unknown) => {
            sends.push(input);
          },
        },
      },
    };
    const deliver = () =>
      deliverParentNotification(
        bb as unknown as Parameters<typeof deliverParentNotification>[0],
        store as unknown as Parameters<typeof deliverParentNotification>[1],
        "comment",
      );

    const first = deliver();
    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    expect(sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await deliver();
    expect(sends).toHaveLength(1);
    expect(row.state).toBe("delivered");

    release({ parentThreadId: "thr_parent", archivedAt: null, deletedAt: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
  });
});
