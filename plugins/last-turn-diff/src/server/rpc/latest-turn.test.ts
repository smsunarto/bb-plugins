import { expect, mock, spyOn, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  type ExperimentalFakeHostRpcCall,
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
  detailsError: Error | null = null,
  callHost: (call: ExperimentalFakeHostRpcCall) => unknown = () => ({ snapshot: null }),
) {
  const list = mock<Threads["events"]["list"]>(async (input) =>
    events
      .filter(
        (event) =>
          input.types?.includes(event.type) &&
          (input.afterSeq === undefined || event.seq > Number(input.afterSeq)) &&
          (input.beforeSeq === undefined || event.seq < Number(input.beforeSeq)),
      )
      .sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq))
      .slice(0, Number(input.limit ?? 100)),
  );
  const details = mock<Threads["timelineTurnSummaryDetails"]>(async () => {
    if (detailsError) throw detailsError;
    return { rows };
  });
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
    completedTurnDisplay: "flat",
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
    experimental_hostEntry: true,
    experimental_callHostRpc: callHost,
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

test("keeps the aggregate patch when turn summary details are unavailable", async () => {
  const { harness } = await setup(
    undefined,
    undefined,
    undefined,
    new Error("Timeline turn summary details could not match range"),
  );
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", anchorId: "final-2", patch, changes: [] },
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

test("adds no model instructions or tools", async () => {
  const { harness } = await setup();
  expect(harness.registrations.instructionProvider).toBeNull();
  expect(harness.registrations.agentTools).toEqual([]);
  expect(harness.registrations.agentConfigurationProvider).toBeNull();
  const config = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(),
  );
  expect(JSON.stringify(config)).not.toContain("last-turn");
  await harness.lifecycle.dispose();
});

function stubWorkspaces(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  harness.sdk.stub("threads.get", async () => ({
    environmentId: "env-1",
    projectId: "proj_dot",
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env-1",
    hostId: "h",
    path: "/ws/dotfiles",
    name: null,
  }));
  harness.sdk.stub("projects.list", async () => [
    {
      id: "proj_dot",
      name: "dotfiles",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "s1",
          projectId: "proj_dot",
          hostId: "h",
          path: "/ws/dotfiles",
          type: "local_path",
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    },
    {
      id: "proj_bb",
      name: "bb-plugins",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "s2",
          projectId: "proj_bb",
          hostId: "h",
          path: "/ws/bb-plugins",
          type: "local_path",
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    },
  ]);
}

type FileChangeRow = Extract<Row, { workKind: "file-change" }>;
function absoluteEdit(path: string, id: string): FileChangeRow {
  const fileChange = edit as FileChangeRow;
  return { ...fileChange, id, change: { ...fileChange.change, path } };
}
type LatestTurnResult = {
  turn: {
    workspace?: string;
    changes: { id: string; workspace?: string; relPath?: string }[];
  } | null;
};

test("changes outside the thread workspace carry a project label and relative path", async () => {
  const { harness } = await setup(
    [started, completed],
    [
      absoluteEdit("/ws/dotfiles/src/b.ts", "local"),
      absoluteEdit("/ws/bb-plugins/src/a.ts", "foreign"),
      message,
    ],
  );
  stubWorkspaces(harness);
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  expect(result).toMatchObject({
    turn: {
      workspace: "dotfiles",
      changes: [
        { id: "local", relPath: "src/b.ts" },
        { id: "foreign", workspace: "bb-plugins", relPath: "src/a.ts" },
      ],
    },
  });
  expect(result.turn?.changes[0]).not.toHaveProperty("workspace");
  await harness.lifecycle.dispose();
});

test("an aggregate patch still surfaces foreign row changes the patch cannot cover", async () => {
  const { harness } = await setup(
    [started, updated, completed],
    [
      absoluteEdit("/ws/dotfiles/src/b.ts", "local"),
      absoluteEdit("/ws/bb-plugins/src/a.ts", "foreign"),
      message,
    ],
  );
  stubWorkspaces(harness);
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  // The env-local row is already covered by the aggregate patch; only the
  // foreign row is appended with its workspace label.
  expect(result).toMatchObject({
    turn: {
      patch,
      workspace: "dotfiles",
      changes: [{ id: "foreign", workspace: "bb-plugins", relPath: "src/a.ts" }],
    },
  });
  await harness.lifecycle.dispose();
});

test("foreign changes outside every known project are labeled by parent directory", async () => {
  const { harness } = await setup(
    [started, completed],
    [absoluteEdit("/tmp/scratch/x.ts", "stray"), message],
  );
  stubWorkspaces(harness);
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  expect(result).toMatchObject({
    turn: { changes: [{ id: "stray", workspace: "scratch" }] },
  });
  expect(result.turn?.changes[0]).not.toHaveProperty("relPath");
  await harness.lifecycle.dispose();
});

test("relative paths that escape the workspace still attribute to a project", async () => {
  const { harness } = await setup(
    [started, completed],
    [absoluteEdit("../bb-plugins/src/a.ts", "escaped"), message],
  );
  stubWorkspaces(harness);
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  expect(result).toMatchObject({
    turn: { changes: [{ id: "escaped", workspace: "bb-plugins", relPath: "src/a.ts" }] },
  });
  await harness.lifecycle.dispose();
});

test("unresolvable environments leave changes unattributed", async () => {
  const { harness } = await setup(
    [started, completed],
    [absoluteEdit("/ws/dotfiles/src/b.ts", "local"), message],
  );
  harness.sdk.stub("threads.get", async () => {
    throw new Error("thread unavailable");
  });
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  expect(result).toMatchObject({ turn: { changes: [{ id: "local" }] } });
  expect(result.turn).not.toHaveProperty("workspace");
  expect(result.turn?.changes[0]).not.toHaveProperty("relPath");
  await harness.lifecycle.dispose();
});

const snapshotPatchText =
  "diff --git a/fmt.ts b/fmt.ts\n--- a/fmt.ts\n+++ b/fmt.ts\n@@ -1 +1 @@\n-a\n+b\n";
const otherPatchText = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n";
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: {
      root: "/ws/dotfiles",
      path: "/ws/dotfiles",
      patch: snapshotPatchText,
      otherPatch: null,
      limited: false,
      uncovered: [],
      attribution: { start: "s", end: "e", contested: [], owned: [] },
      ...overrides,
    },
  };
}

test("a workspace snapshot outranks the provider patch and covers unrecorded edits", async () => {
  const calls: ExperimentalFakeHostRpcCall[] = [];
  const previous = {
    ...completed,
    id: "end-1",
    seq: 4,
    createdAt: 500,
    scope: { kind: "turn" as const, turnId: "turn-1" },
  };
  const next = {
    ...started,
    id: "start-3",
    seq: 30,
    createdAt: 12_000,
    scope: { kind: "turn" as const, turnId: "turn-3" },
  };
  const { harness } = await setup(
    [previous, { ...started, createdAt: 1_000 }, updated, { ...completed, createdAt: 9_000 }, next],
    [absoluteEdit("/ws/dotfiles/src/b.ts", "local"), message],
    [],
    null,
    (call) => {
      calls.push(call);
      return snapshot({ otherPatch: otherPatchText });
    },
  );
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", patch: snapshotPatchText, otherPatch: otherPatchText },
  });
  expect(calls).toEqual([
    {
      method: "turnPatch",
      hostId: "h",
      input: {
        environmentPath: "/ws/dotfiles",
        threadId: "thread-1",
        window: {
          prevCompletedAt: 500,
          startedAt: 1_000,
          completedAt: 9_000,
          nextStartedAt: 12_000,
        },
        recordedPaths: ["/ws/dotfiles/src/b.ts"],
      },
    },
  ]);
  await harness.lifecycle.dispose();
});

test("a turn whose only edits came from shell commands still shows them", async () => {
  const { harness } = await setup([started, completed], [message], [], null, () => snapshot());
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", patch: snapshotPatchText, changes: [] },
  });
  await harness.lifecycle.dispose();
});

test("a failing host falls back to the provider's patch", async () => {
  const { harness } = await setup(undefined, undefined, [], null, () => {
    throw new Error("host offline");
  });
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { patch },
  });
  await harness.lifecycle.dispose();
});

const command = {
  ...message,
  id: "command-2",
  kind: "work",
  workKind: "command",
} as unknown as Row;

test("others' changes alone keep a turn that ran commands, not a chat-only reply", async () => {
  const onlyOthers = () => snapshot({ patch: "", otherPatch: otherPatchText });
  const ran = await setup([started, completed], [command, message], [], null, onlyOthers);
  stubWorkspaces(ran.harness);
  expect(await ran.harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", patch: "", otherPatch: otherPatchText, changes: [] },
  });
  await ran.harness.lifecycle.dispose();

  const chat = await setup([started, completed], [message], [], null, onlyOthers);
  stubWorkspaces(chat.harness);
  expect(await chat.harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({
    turn: null,
  });
  await chat.harness.lifecycle.dispose();
});

test("edits reported under the resolved environment path stay in this workspace", async () => {
  const { harness } = await setup(
    [started, completed],
    [absoluteEdit("/private/ws/dotfiles/src/b.ts", "resolved"), message],
    [],
    null,
    () => snapshot({ root: "/private/ws/dotfiles" }),
  );
  stubWorkspaces(harness);
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  // Nothing is appended as a foreign workspace: the snapshot already covers it.
  expect(result.turn?.changes).toEqual([]);
  await harness.lifecycle.dispose();
});

const readyEnvironment = { status: "ready", hostId: "h", path: "/ws/dotfiles" };

const commitOf = (n: number) => n.toString(16).padStart(40, "0");
/** A fake host that logs each snapshot by number and each pin as kind@snapshot. */
function recordingHost(fail: (n: number) => "late" | "throw" | null = () => null) {
  const log: string[] = [];
  let count = 0;
  const call = async (call: ExperimentalFakeHostRpcCall) => {
    if (call.method === "snapshot") {
      const n = ++count;
      const failure = fail(n);
      if (failure === "throw") throw new Error("snapshot failed");
      if (failure === "late") await new Promise((resolve) => setTimeout(resolve, 1_600));
      log.push(`snapshot:${n}`);
      return { commit: commitOf(n) };
    }
    if (call.method === "pin") {
      const { captures } = call.input as { captures: { kind: string; commit: string | null }[] };
      const pins = captures.map((c) => `${c.kind}@${c.commit ? parseInt(c.commit, 16) : "-"}`);
      log.push(`pin:${pins.join(",")}`);
      return {};
    }
    log.push(call.method);
    return call.method === "turnPatch" ? { snapshot: null } : {};
  };
  return { log, call };
}
const lifecycleThread = { id: "thread-1", status: "idle", environmentId: "env-1" };
async function lifecycle(fail?: (n: number) => "late" | "throw" | null) {
  const host = recordingHost(fail);
  const { harness } = await setup(undefined, undefined, [], null, host.call);
  stubWorkspaces(harness);
  const hook = harness.registrations.hooks["message.dispatch"]!;
  const dispatch = (attempt: "start-turn" | "join-turn" = "start-turn", status = "idle") =>
    hook(
      makeMessageDispatchHookContext({
        attempt,
        environment: readyEnvironment as never,
        thread: { ...lifecycleThread, status } as never,
        input: { blocks: [], text: "go" },
      }),
    );
  const thread = lifecycleThread as never;
  const emit = (event: "thread.active" | "thread.idle" | "thread.failed" | "thread.deleted") =>
    harness.behavior.emitThreadEvent(event, { thread, lastAssistantText: null, error: null });
  return { harness, log: host.log, dispatch, emit };
}

test("a turn's baseline is the snapshot its dispatch waited for", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  expect(await dispatch()).toEqual({ action: "proceed" });
  expect(await dispatch("join-turn")).toEqual({ action: "proceed" });
  await emit("thread.active");
  expect(await dispatch("start-turn", "active")).toEqual({ action: "proceed" }); // Queues as busy.
  await emit("thread.idle");
  await emit("thread.deleted");
  expect(log).toEqual([
    "snapshot:1",
    "snapshot:2",
    "pin:start@1,open@2",
    "snapshot:3",
    "pin:end@3",
    "turnPatch", // Attributed as soon as it ends, while overlapping captures exist.
    "forget",
  ]);
  expect(harness.realtimeSignals).toHaveLength(3);
  await harness.lifecycle.dispose();
});

test("a baseline that missed the dispatch budget is never pinned", async () => {
  const { harness, log, dispatch, emit } = await lifecycle((n) => (n === 1 ? "late" : null));
  const began = Date.now();
  expect(await dispatch()).toEqual({ action: "proceed" });
  expect(Date.now() - began).toBeLessThan(1_600);
  await emit("thread.active");
  expect(log).toEqual(["snapshot:1", "snapshot:2", "pin:open@2"]);
  await harness.lifecycle.dispose();
});

const row = (id: string, text: string) =>
  ({ id, threadId: "thread-1", content: [{ type: "text", text }] }) as never;

test("a baseline whose message was queued instead is never pinned", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  await dispatch();
  await harness.behavior.emitThreadEvent("message.queued", { entry: row("row-1", "go") });
  await emit("thread.active");
  expect(log).toEqual(["snapshot:1", "snapshot:2", "pin:open@2"]);
  await harness.lifecycle.dispose();
});

test("an unrelated follow-up queued before the turn opens keeps its baseline", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  await dispatch();
  await harness.behavior.emitThreadEvent("message.queued", { entry: row("row-2", "later") });
  await emit("thread.active");
  expect(log).toEqual(["snapshot:1", "snapshot:2", "pin:start@1,open@2"]);
  await harness.lifecycle.dispose();
});

test("a Send-now that skipped the hook never claims another attempt's baseline", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  await dispatch(); // Then rejected by a later plugin: no event says so.
  await harness.behavior.emitThreadEvent("message.dispatched", { entry: row("row-3", "now") });
  await emit("thread.active");
  expect(log).toEqual(["snapshot:1", "snapshot:2", "pin:open@2"]);
  await harness.lifecycle.dispose();
});

test("overlapping passes before a warm turn opens drop both baselines", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  await dispatch();
  await dispatch(); // bb released the lock; the first turn has not opened yet.
  await emit("thread.active");
  expect(log).toEqual(["snapshot:1", "snapshot:2", "snapshot:3", "pin:open@3"]);
  await harness.lifecycle.dispose();
});

test("a pass beginning the same millisecond its thread opens never ends that turn", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  const now = spyOn(Date, "now").mockReturnValue(1_000);
  await dispatch();
  const opening = emit("thread.active"); // Queued ahead of the second pass's snapshot.
  await dispatch();
  await opening;
  now.mockRestore();
  await emit("thread.idle");
  expect(log.filter((entry) => entry.startsWith("pin"))).toEqual([
    "pin:start@1,open@2",
    "pin:end@4",
  ]);
  await harness.lifecycle.dispose();
});

test("a failed open snapshot still marks the thread as running", async () => {
  const { harness, log, dispatch, emit } = await lifecycle((n) => (n === 2 ? "throw" : null));
  await dispatch();
  await emit("thread.active");
  expect(log).toEqual(["snapshot:1", "pin:start@1,run@-"]);
  await harness.lifecycle.dispose();
});

test("a dispatch that beats thread.idle pins its baseline as the previous turn's end", async () => {
  const { harness, log, dispatch, emit } = await lifecycle();
  await emit("thread.active");
  await new Promise((resolve) => setTimeout(resolve, 5)); // The turn runs.
  await dispatch();
  await emit("thread.idle");
  await emit("thread.active");
  expect(log).toEqual([
    "snapshot:1",
    "pin:open@1",
    "snapshot:2",
    "pin:end@2",
    "turnPatch",
    "snapshot:3",
    "pin:start@2,open@3",
  ]);
  await harness.lifecycle.dispose();
});

test("a failed end snapshot still marks the thread as finished", async () => {
  const { harness, log, emit } = await lifecycle((n) => (n === 2 ? "throw" : null));
  await emit("thread.active");
  await emit("thread.failed");
  expect(log).toEqual(["snapshot:1", "pin:open@1", "pin:stop@-", "turnPatch"]);
  await harness.lifecycle.dispose();
});

test("a thread's snapshot operations run in arrival order, environment lookups included", async () => {
  const { harness, log, emit } = await lifecycle();
  let slow = true;
  harness.sdk.stub("environments.get", async () => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, 20));
    slow = false;
    return { id: "env-1", hostId: "h", path: "/ws/dotfiles", name: null };
  });
  await Promise.all([emit("thread.active"), emit("thread.deleted")]);
  expect(log).toEqual(["snapshot:1", "pin:open@1", "forget"]);
  await harness.lifecycle.dispose();
});

test("an empty snapshot hides reverted edits but keeps edits it cannot see", async () => {
  const { harness } = await setup(
    [started, completed],
    [
      absoluteEdit("/ws/dotfiles/src/b.ts", "reverted"),
      absoluteEdit("/ws/dotfiles/vendor/lib/x.ts", "submodule"),
      absoluteEdit("/ws/bb-plugins/src/a.ts", "foreign"),
      message,
    ],
    [],
    null,
    () => snapshot({ patch: "", uncovered: ["vendor/lib"] }),
  );
  stubWorkspaces(harness);
  const result = (await harness.callRpc("latestTurn", {
    threadId: "thread-1",
  })) as LatestTurnResult;
  expect(result.turn?.changes.map((change) => change.id)).toEqual(["submodule", "foreign"]);
  await harness.lifecycle.dispose();
});

test("a remembered attribution, even an empty one, is sent back so a card never reshuffles", async () => {
  const inputs: unknown[] = [];
  const attribution = { start: "s", end: "e", contested: [], owned: [] };
  const { harness } = await setup([started, completed], [message], [], null, (call) => {
    inputs.push((call.input as { known?: unknown }).known);
    return snapshot({ otherPatch: otherPatchText, attribution });
  });
  stubWorkspaces(harness);
  await harness.callRpc("latestTurn", { threadId: "thread-1" });
  await harness.callRpc("latestTurn", { threadId: "thread-1" });
  expect(inputs).toEqual([undefined, attribution]);
  await harness.lifecycle.dispose();
});

test("a remembered attribution in an older shape is converted, keeping its evidence", async () => {
  const inputs: unknown[] = [];
  const { harness, bb } = await setup([started, completed], [message], [], null, (call) => {
    inputs.push((call.input as { known?: unknown }).known);
    return snapshot({ otherPatch: otherPatchText });
  });
  await bb.storage.kv.set("attribution:thread-1:000000000000001", {
    start: "s",
    end: "e",
    foreign: ["vendor.txt"],
  });
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { otherPatch: otherPatchText },
  });
  expect(inputs).toEqual([{ start: "s", end: "e", contested: ["vendor.txt"], owned: [] }]);
  await harness.lifecycle.dispose();
});

test("an empty snapshot hides reverted edits even when the environment is unavailable", async () => {
  const { harness } = await setup(
    [started, completed],
    [absoluteEdit("/ws/dotfiles/src/b.ts", "reverted"), command, message],
    [],
    null,
    () => snapshot({ patch: "" }),
  );
  stubWorkspaces(harness);
  let lookups = 0;
  harness.sdk.stub("threads.get", async () => {
    // The snapshot target resolves; the attribution context does not.
    if (lookups++ > 0) throw new Error("thread unavailable");
    return { environmentId: "env-1", projectId: "proj_dot" } as never;
  });
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  await harness.lifecycle.dispose();
});

test("a turn whose edits were all reverted keeps the previous turn's preview", async () => {
  const scope = { kind: "turn" as const, turnId: "turn-1" };
  const earlier: Event[] = [
    { ...started, id: "start-1", seq: 2, createdAt: 100, scope },
    { ...completed, id: "end-1", seq: 8, createdAt: 200, scope },
  ];
  const reverted = [
    absoluteEdit("/ws/dotfiles/src/b.ts", "edit"),
    absoluteEdit("/ws/dotfiles/src/b.ts", "undo"),
  ];
  const { harness } = await setup(
    [...earlier, { ...started, createdAt: 300 }, { ...completed, createdAt: 400 }],
    [...reverted, message],
    [],
    null,
    (call) => {
      const { window } = call.input as { window: { startedAt: number } };
      return snapshot(window.startedAt === 300 ? { patch: "" } : {});
    },
  );
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-1", patch: snapshotPatchText },
  });
  await harness.lifecycle.dispose();
});
