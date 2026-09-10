import { expect, mock, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

type Threads = BbPluginApi["sdk"]["threads"];
type Event = Awaited<ReturnType<Threads["events"]["list"]>>[number];
type Row = Awaited<ReturnType<Threads["timelineTurnSummaryDetails"]>>["rows"][number];
const patch =
  "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n";
const base = {
  threadId: "thread-1",
  scope: { kind: "turn", turnId: "turn-2" } as const,
  createdAt: 1,
};
const started: Event = {
  ...base,
  id: "start",
  seq: 10,
  type: "turn/started",
  data: { providerThreadId: "provider-1" },
};
const completed: Event = {
  ...base,
  id: "end",
  seq: 20,
  type: "turn/completed",
  data: { providerThreadId: "provider-1", status: "completed" },
};
const updated: Event = {
  ...base,
  id: "diff",
  seq: 18,
  type: "turn/diff/updated",
  data: { providerThreadId: "provider-1", diff: patch },
};
const message: Row = {
  id: "final-2",
  threadId: "thread-1",
  turnId: "turn-2",
  kind: "conversation",
  role: "assistant",
  text: "Original model response",
  attachments: null,
  turnRequest: null,
  createdAt: 1,
  startedAt: 1,
  sourceSeqStart: 19,
  sourceSeqEnd: 19,
};
const edit: Row = {
  id: "edit-2",
  threadId: "thread-1",
  turnId: "turn-2",
  kind: "work",
  workKind: "file-change",
  approvalStatus: null,
  callId: "edit",
  createdAt: 1,
  sourceSeqStart: 15,
  sourceSeqEnd: 15,
  startedAt: 1,
  status: "completed",
  stdout: null,
  stderr: null,
  change: {
    path: "example.ts",
    kind: "update",
    movePath: null,
    diff: patch,
    diffStats: { added: 1, removed: 1 },
  },
};

type Timeline = Awaited<ReturnType<Threads["timeline"]>>;
async function setup(
  events: Event[] = [started, updated, completed],
  rows: Row[] = [edit],
  timelinePages: Partial<Timeline>[] = [],
) {
  const list = mock<Threads["events"]["list"]>(async (input) =>
    events
      .filter(
        (event) =>
          input.types?.includes(event.type) &&
          (input.afterSeq === undefined || event.seq > Number(input.afterSeq)) &&
          (input.beforeSeq === undefined || event.seq < Number(input.beforeSeq)),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Number(input.limit ?? 100)),
  );
  const details = mock<Threads["timelineTurnSummaryDetails"]>(async () => ({ rows }));
  let page = 0;
  const timeline = mock<Threads["timeline"]>(async () => ({
    rows: [message],
    maxSeq: Math.max(0, ...events.map((event) => event.seq)),
    contextBoundarySeq: null,
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 2,
      returnedSegmentCount: 1,
      hasOlderRows: false,
      olderCursor: null,
    },
    ...timelinePages[page++],
  }));
  const host = createFakePluginHost({
    pluginId: "last-turn-diff",
    sdk: {
      threads: {
        events: { list },
        timelineTurnSummaryDetails: details,
        timeline,
      },
    },
  });
  await plugin(host.bb);
  return { ...host, list, details, timeline };
}

test("uses the latest completed turn's aggregate patch and never reads the workspace", async () => {
  const { harness, list, details } = await setup();
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({
    turn: {
      turnId: "turn-2",
      anchorId: "final-2",
      patch,
      changes: [],
      limited: false,
    },
  });
  expect(list.mock.calls[0]?.[0]).toMatchObject({
    types: ["turn/completed"],
    limit: "20",
    order: "desc",
  });
  expect(details.mock.calls[0]?.[0]).toEqual({
    threadId: "thread-1",
    turnId: "turn-2",
    sourceSeqStart: "10",
    sourceSeqEnd: "20",
  });
  expect(harness.sdk.callsTo("files.read")).toEqual([]);
  expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  expect(harness.sdk.callsTo("threads.editMessage")).toEqual([]);
  await harness.lifecycle.dispose();
});

test("returns no preview when the thread has no recorded changes", async () => {
  const { harness } = await setup([started, completed], [{ ...edit, turnId: "other" }, message]);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  await harness.lifecycle.dispose();
});

function laterTurn(index: number): Event[] {
  const scope = { kind: "turn", turnId: `later-${index}` } as const;
  return [
    { ...started, id: `start-${index}`, scope, seq: 30 + index * 10 },
    { ...completed, id: `end-${index}`, scope, seq: 39 + index * 10 },
  ];
}

test("retains the last recorded changes through no-edit and active turns", async () => {
  const { harness } = await setup([started, updated, completed, ...laterTurn(0), laterTurn(1)[0]!]);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", anchorId: "final-2", patch },
  });
  await harness.lifecycle.dispose();
});

test("paginates completed turns and locates the retained answer in older timeline pages", async () => {
  const cursor = { anchorId: "later-final", anchorSeq: 230 };
  const { harness, timeline, list } = await setup(
    [started, updated, completed, ...Array.from({ length: 25 }, (_, i) => laterTurn(i)).flat()],
    [edit],
    [
      {
        rows: [],
        timelinePage: {
          kind: "latest",
          segmentLimit: 2,
          returnedSegmentCount: 2,
          hasOlderRows: true,
          olderCursor: cursor,
        },
      },
      { rows: [message] },
    ],
  );
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", anchorId: "final-2", patch },
  });
  expect(list.mock.calls.filter(([input]) => input.types?.includes("turn/completed"))).toHaveLength(
    2,
  );
  expect(timeline.mock.calls[1]?.[0]).toMatchObject({
    beforeAnchorId: cursor.anchorId,
    beforeAnchorSeq: "230",
  });
  await harness.lifecycle.dispose();
});

test("a newer edit replaces retained changes", async () => {
  const [start, end] = laterTurn(0);
  const latest = {
    ...updated,
    scope: start!.scope,
    seq: 35,
    data: { ...updated.data, diff: patch.replaceAll("new", "newest") },
  };
  const { harness } = await setup(
    [started, updated, completed, start!, latest, end!],
    [edit],
    [{ rows: [message, { ...message, id: "latest-final", turnId: "later-0" }] }],
  );
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "later-0", anchorId: "latest-final", patch: latest.data.diff },
  });
  await harness.lifecycle.dispose();
});

test("does not revive changes from before the context boundary", async () => {
  const { harness } = await setup(
    [started, updated, completed, ...laterTurn(0)],
    [edit],
    [{ contextBoundarySeq: 25 }],
  );
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  await harness.lifecycle.dispose();
});

test("preserves separate edits and excludes failed edits and other turns", async () => {
  const { harness } = await setup(
    [started, completed],
    [
      edit,
      { ...edit, id: "edit-3" },
      { ...edit, status: "error" },
      { ...edit, approvalStatus: "denied" },
      { ...edit, turnId: "other" },
      message,
    ],
  );
  const result = await harness.callRpc("latestTurn", { threadId: "thread-1" });
  expect(result).toMatchObject({
    turn: { patch: null, changes: [{ id: "edit-2" }, { id: "edit-3" }] },
  });
  await harness.lifecycle.dispose();
});

test("falls back to recorded edits when the aggregate patch is empty", async () => {
  const { harness } = await setup([
    started,
    { ...updated, data: { ...updated.data, diff: "" } },
    completed,
  ]);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { patch: null, changes: [{ id: "edit-2" }] },
  });
  await harness.lifecycle.dispose();
});

test("limits oversized changes without truncating a patch into invalid text", async () => {
  const oversized = { ...edit, change: { ...edit.change, diff: "x".repeat(1_000_001) } };
  const { harness } = await setup([started, completed], [oversized, message]);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { limited: true, changes: [{ path: "example.ts", patch: null }] },
  });
  await harness.lifecycle.dispose();
});

test("returns no preview before a turn completes or when boundaries disagree", async () => {
  for (const events of [
    [started],
    [{ ...started, scope: { kind: "turn" as const, turnId: "other" } }, completed],
  ]) {
    const { harness, details } = await setup(events);
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
    expect(details).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  }
});

test("adds no model instructions, tools, or dispatch hooks", async () => {
  const { harness } = await setup();
  expect(harness.registrations.instructionProvider).toBeNull();
  expect(harness.registrations.agentTools).toEqual([]);
  expect(harness.registrations.agentConfigurationProvider).toBeNull();
  expect(harness.registrations.hooks["message.dispatch"]).toBeNull();
  const config = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(),
  );
  expect(JSON.stringify(config)).not.toContain("last-turn");
  await harness.lifecycle.dispose();
});
