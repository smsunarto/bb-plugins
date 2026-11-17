import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crewRpcContract } from "../shared/crew-contract";
import { registerCrewApi } from "./crew";
import { createStore } from ".";

function at(time: string): void {
  vi.setSystemTime(new Date(`2026-11-16T${time}.000Z`));
}

function setup() {
  vi.useFakeTimers();
  at("10:00:00");
  const host = createFakePluginHost({ pluginId: "scott-tasks" });
  const store = createStore(host.bb);
  registerCrewApi(host.bb, store);
  const tasks = store.tasks;
  const project = tasks.createProject({ name: "Plugins", prefix: "PLUG", color: "blue" });
  const parent = tasks.createTask({ projectId: project.id, title: "Captain v1", status: "todo" });
  const child = tasks.createTask({
    projectId: project.id,
    title: "Render PR images",
    parentTaskId: parent.id,
    status: "todo",
  });
  const other = tasks.createTask({ projectId: project.id, title: "Unrelated crew" });
  const attach = (taskId: string, threadId: string, presetName: string) =>
    tasks.upsertTaskThread({
      taskId,
      threadId,
      presetName,
      title: threadId,
      liveStatus: "working",
    });
  const implement = attach(child.id, "thr_impl", "Implement");
  attach(child.id, "thr_review", "Review");
  attach(other.id, "thr_other", "Implement");
  tasks.defineField("captain", "review", ["findings", "passed", "skipped"]);

  const comment = (taskId: string, threadId: string, body: string) =>
    tasks.createComment({
      taskId,
      source: { kind: "agent", threadId },
      authorName: threadId,
      body,
    });

  const snapshot = async (threadIds: string[], changedSince?: string) =>
    crewRpcContract.crewSnapshot.output.parse(
      await host.harness.callRpc(
        "crewSnapshot",
        changedSince === undefined ? { threadIds } : { threadIds, changedSince },
        { experimental_caller: { kind: "plugin", pluginId: "captain" } },
      ),
    ).rows;

  return { ...host, tasks, parent, child, other, implement, comment, snapshot };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("crewSnapshot", () => {
  it("joins each attached thread's task, parent, fields, live status and last notifying comment", async () => {
    const { harness, tasks, parent, child, implement, comment, snapshot } = setup();

    at("10:01:00");
    tasks.updateTask(child.id, { status: "in_progress" });
    at("10:02:00");
    tasks.setTaskField({ taskId: child.id, key: "review", value: "findings", head: "abc123" });
    at("10:03:00");
    tasks.updateTaskThreadStatus(implement.id, "failed");
    at("10:04:00");
    const report = comment(child.id, "thr_impl", "Final: PR opened");
    tasks.startParentNotification(report.id, "thr_captain");
    tasks.claimParentNotificationAttempt(report.id, 0, "2026-11-16T10:05:00.000Z");
    tasks.recordParentNotificationDelivered(report.id, "thr_captain");
    at("10:05:00");
    // A later plain comment from the same thread, and another thread's notifying one.
    comment(child.id, "thr_impl", "Milestone: tests pass");
    const review = comment(child.id, "thr_review", "Final: 0 findings");
    tasks.startParentNotification(review.id, null);
    at("10:06:00");
    // Re-attaching with the same status leaves the live status's change time alone.
    tasks.upsertTaskThread({
      taskId: child.id,
      threadId: "thr_impl",
      presetName: "Implement",
      title: "thr_impl",
      liveStatus: "failed",
    });

    const rows = await snapshot(["thr_impl", "thr_review"]);
    expect(rows).toEqual([
      {
        threadId: "thr_impl",
        presetName: "Implement",
        liveStatus: "failed",
        liveStatusChangedAt: "2026-11-16T10:03:00.000Z",
        attachedAt: "2026-11-16T10:00:00.000Z",
        updatedAt: "2026-11-16T10:06:00.000Z",
        task: {
          id: child.id,
          key: "PLUG-2",
          title: "Render PR images",
          status: "in_progress",
          statusChangedAt: "2026-11-16T10:01:00.000Z",
          updatedAt: "2026-11-16T10:02:00.000Z",
        },
        parentTask: {
          id: parent.id,
          key: "PLUG-1",
          title: "Captain v1",
          status: "todo",
          statusChangedAt: "2026-11-16T10:00:00.000Z",
          updatedAt: "2026-11-16T10:00:00.000Z",
        },
        fields: [
          {
            key: "review",
            value: "findings",
            head: "abc123",
            writtenAt: "2026-11-16T10:02:00.000Z",
          },
        ],
        lastNotifyingComment: {
          id: report.id,
          createdAt: "2026-11-16T10:04:00.000Z",
          delivery: {
            state: "delivered",
            targetThreadId: "thr_captain",
            attempts: 1,
            deliveredAt: "2026-11-16T10:04:00.000Z",
          },
        },
      },
      expect.objectContaining({
        threadId: "thr_review",
        presetName: "Review",
        liveStatus: "working",
        lastNotifyingComment: {
          id: review.id,
          createdAt: "2026-11-16T10:05:00.000Z",
          delivery: {
            state: "pending",
            targetThreadId: null,
            attempts: 0,
            nextAttemptAt: "2026-11-16T10:05:00.000Z",
            lastError: null,
          },
        },
      }),
    ]);

    await harness.dispose();
  });

  it("limits changedSince reads to rows whose task, task-thread row or comments changed", async () => {
    const { harness, tasks, child, other, implement, comment, snapshot } = setup();
    const all = ["thr_impl", "thr_review", "thr_other"];
    at("10:10:00");
    expect(await snapshot(all, "2026-11-16T10:05:00.000Z")).toEqual([]);

    // A task-thread row: only that thread's row.
    tasks.updateTaskThreadStatus(implement.id, "idle");
    expect((await snapshot(all, "2026-11-16T10:05:00.000Z")).map((row) => row.threadId)).toEqual([
      "thr_impl",
    ]);

    // A comment: every row on that task. The cutoff may carry any UTC offset.
    at("10:20:00");
    comment(child.id, "thr_review", "Milestone: lenses running");
    expect((await snapshot(all, "2026-11-16T12:15:00+02:00")).map((row) => row.threadId)).toEqual([
      "thr_impl",
      "thr_review",
    ]);

    // A task: a verdict bumps its updated_at.
    at("10:30:00");
    tasks.setTaskField({ taskId: other.id, key: "review", value: "passed", head: null });
    expect((await snapshot(all, "2026-11-16T10:25:00.000Z")).map((row) => row.threadId)).toEqual([
      "thr_other",
    ]);

    await harness.dispose();
  });
});
