import { expect, mock, spyOn, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { CHANGED_CHANNEL } from "../../shared/contract.ts";
import {
  MAX_SCAN_CANDIDATES,
  type HostOperation,
  type SnapshotCandidate,
} from "../../shared/host-contract.ts";

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
  rawHost = false,
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
    experimental_callHostRpc: rawHost
      ? callHost
      : async (call) => {
          const { operations, job } = call.input as SyncInput;
          const applied: string[] = [];
          for (const operation of operations) {
            await callHost({
              hostId: call.hostId,
              method: operation.method,
              input: operation.input,
            });
            applied.push(operation.id);
          }
          if (job.kind === "capture") {
            const result = (await callHost({
              hostId: call.hostId,
              method: "snapshot",
              input: { environmentPath: job.environmentPath },
            })) as { commit: string | null };
            return { applied, commit: result.commit ?? null };
          }
          if (job.kind === "scan") {
            const snapshots = [];
            for (const candidate of job.candidates ?? []) {
              const result = (await callHost({
                hostId: call.hostId,
                method: "turnPatch",
                input: {
                  environmentPath: job.environmentPath,
                  threadId: job.threadId,
                  ...candidate,
                },
              })) as { snapshot: unknown };
              snapshots.push(result.snapshot);
            }
            return { applied, snapshots };
          }
          return { applied };
        },
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

type SyncInput = {
  operations: HostOperation[];
  job: {
    kind: "capture" | "scan" | "settle";
    environmentPath?: string;
    threadId?: string;
    candidates?: SnapshotCandidate[];
  };
};

test("uses the latest completed turn's aggregate patch and never reads the workspace", async () => {
  const { harness, list, details } = await setup();
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
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

test("temporary-only turns retain the previous project preview", async () => {
  const later = laterTurn(0);
  for (const aggregate of [false, true]) {
    const temporaryPatch = patch.replaceAll("example.ts", "/tmp/review.txt");
    const { harness } = await setup(
      [
        started,
        updated,
        completed,
        ...later,
        ...(aggregate
          ? [
              {
                ...updated,
                id: "temporary-diff",
                seq: 35,
                scope: later[0]!.scope,
                data: { providerThreadId: "provider-1", diff: temporaryPatch },
              },
            ]
          : []),
      ],
      [
        edit,
        {
          ...edit,
          id: "temporary-edit",
          turnId: "later-0",
          change: {
            ...edit.change,
            path: "/tmp/review.txt",
            diff: temporaryPatch,
          },
        },
      ],
    );
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { turnId: "turn-2", anchorId: "final-2", patch },
    });
    await harness.lifecycle.dispose();
  }
});

test("a temporary-only thread has no preview", async () => {
  const { harness } = await setup(
    [started, completed],
    [
      {
        ...edit,
        change: { ...edit.change, path: "/private/tmp/review.txt" },
      },
    ],
  );
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  await harness.lifecycle.dispose();
});

test("temporary edits never consume the file or text preview budget", async () => {
  const temporary = {
    ...edit,
    change: { ...edit.change, path: "/tmp/review.txt", diff: "x".repeat(1_000_001) },
  };
  for (const rows of [
    [temporary],
    Array.from({ length: 201 }, (_, n) => ({ ...temporary, id: `tmp-${n}` })),
  ]) {
    const { harness } = await setup([started, completed], [...rows, edit]);
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { limited: false, changes: [{ path: "example.ts", patch }] },
    });
    await harness.lifecycle.dispose();
  }
  const temporaryPatch =
    patch.replaceAll("example.ts", "/private/tmp/review.txt") + "+" + "x".repeat(1_000_001) + "\n";
  for (const aggregate of [temporaryPatch, temporaryPatch + patch]) {
    const { harness } = await setup(
      [{ ...started }, { ...updated, data: { ...updated.data, diff: aggregate } }, completed],
      [temporary],
    );
    const result = await harness.callRpc("latestTurn", { threadId: "thread-1" });
    expect(result).toMatchObject(
      aggregate === temporaryPatch
        ? { turn: null }
        : {
            turn: { turnId: "turn-2", anchorId: "final-2", changes: [], patch, limited: false },
          },
    );
    await harness.lifecycle.dispose();
  }
});

test("known project edits under tmp remain visible and moves across tmp stay visible", async () => {
  const { harness } = await setup(
    [started, completed],
    [absoluteEdit("/private/tmp/project/src/a.ts", "project")],
  );
  stubWorkspaces(harness);
  harness.sdk.stub("environments.get", async () => ({
    id: "env-1",
    hostId: "h",
    path: "/private/tmp/project",
    name: null,
  }));
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { changes: [{ path: "/private/tmp/project/src/a.ts", relPath: "src/a.ts" }] },
  });
  await harness.lifecycle.dispose();
  for (const [path, movePath, expected] of [
    ["/tmp/gen.ts", "src/gen.ts", "src/gen.ts"],
    ["src/a.ts", "/tmp/a.ts", "src/a.ts"],
  ]) {
    const { harness } = await setup(
      [started, completed],
      [{ ...edit, change: { ...edit.change, path: path!, movePath: movePath! } }],
    );
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { changes: [{ path: expected }] },
    });
    await harness.lifecycle.dispose();
  }
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
    [absoluteEdit("/scratch/x.ts", "stray"), message],
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

test("temporary rows cannot consume snapshot or foreign-project preview budgets", async () => {
  const temporary = {
    ...absoluteEdit("/tmp/review.txt", "temporary"),
    change: { ...edit.change, path: "/tmp/review.txt", diff: "x".repeat(1_000_001) },
  };
  const foreign = absoluteEdit("/ws/bb-plugins/src/a.ts", "foreign");
  const { harness } = await setup(
    [started, completed],
    [temporary, foreign, message],
    [],
    null,
    () => snapshot(),
  );
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { patch: snapshotPatchText, limited: false, changes: [{ id: "foreign", patch }] },
  });
  await harness.lifecycle.dispose();
});

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
        canWrite: false,
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
const lifecycleThread = { id: "thread-1", status: "idle", environmentId: "env-1" };

async function waitUntil(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Exercise the public host boundary, retaining only acknowledged markers. */
async function lifecycle() {
  const calls: SyncInput[] = [];
  const pinned: HostOperation[] = [];
  const state = { offline: false, late: false, failCapture: false, refuse: false };
  const { harness, bb } = await setup(
    undefined,
    undefined,
    [],
    null,
    async (call) => {
      const input = call.input as SyncInput;
      calls.push(input);
      if (state.offline) throw new Error("Host is not connected");
      if (state.late) await new Promise((resolve) => setTimeout(resolve, 1_600));
      const applied = state.refuse
        ? []
        : input.operations.map((operation) => {
            pinned.push(operation);
            return operation.id;
          });
      if (state.refuse) return { applied, error: "refused" };
      if (input.job.kind === "capture")
        return { applied, commit: state.failCapture ? null : commitOf(calls.length) };
      return input.job.kind === "scan"
        ? { applied, snapshots: input.job.candidates!.map(() => snapshot().snapshot) }
        : { applied };
    },
    true,
  );
  stubWorkspaces(harness);
  const dispatch = () =>
    harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        attempt: "start-turn",
        environment: readyEnvironment as never,
        thread: lifecycleThread as never,
        input: { blocks: [], text: "go" },
      }),
    );
  const emit = (event: "thread.active" | "thread.idle" | "thread.failed" | "thread.deleted") =>
    harness.behavior.emitThreadEvent(event, {
      thread: lifecycleThread as never,
      lastAssistantText: null,
      error: null,
    });
  const pins = () => pinned.flatMap((o) => (o.method === "pin" ? o.input.captures : []));
  return { harness, bb, calls, state, pinned, pins, emit, dispatch };
}

test("dispatch uses one host call, a turn uses four, and the idle memo uses zero more", async () => {
  const { harness, calls, pins, emit, dispatch } = await lifecycle();
  await dispatch();
  expect(calls).toHaveLength(1);
  await emit("thread.active");
  expect(calls).toHaveLength(2);
  await emit("thread.idle");
  expect(calls.map((c) => c.job.kind)).toEqual(["capture", "capture", "capture", "scan"]);
  expect(pins().map((p) => p.kind)).toEqual(["start", "open", "end"]);
  const before = calls.length;
  const firstRead = await harness.callRpc("latestTurn", { threadId: "thread-1" });
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual(firstRead);
  expect(calls).toHaveLength(before);
  expect(harness.sdk.callsTo("files.read")).toHaveLength(0);
  await harness.lifecycle.dispose();
});

test("late dispatch captures never become a baseline and the budget still bounds the lock", async () => {
  const { harness, calls, state, pins, dispatch, emit } = await lifecycle();
  state.late = true;
  const began = Date.now();
  expect(await dispatch()).toEqual({ action: "proceed" });
  expect(Date.now() - began).toBeLessThan(1_600);
  state.late = false;
  await emit("thread.active");
  await emit("thread.idle");
  expect(calls).toHaveLength(4);
  expect(pins().map((p) => p.kind)).toEqual(["open", "end"]);
  await harness.lifecycle.dispose();
});

test("queued, Send-now, and overlapping dispatches cannot claim another attempt's baseline", async () => {
  for (const scenario of ["queued", "send-now", "overlap"] as const) {
    const { harness, pins, dispatch, emit } = await lifecycle();
    await dispatch();
    if (scenario === "overlap") await dispatch();
    else
      await harness.behavior.emitThreadEvent(
        scenario === "queued" ? "message.queued" : "message.dispatched",
        {
          entry: {
            id: "row",
            threadId: "thread-1",
            content: [{ type: "text", text: "go" }],
          } as never,
        },
      );
    await emit("thread.active");
    await emit("thread.idle");
    expect(pins().some((p) => p.kind === "start")).toBe(false);
    await harness.lifecycle.dispose();
  }
});

test("a dispatch that beats idle defers the previous end without a second dispatch host call", async () => {
  const { harness, calls, pins, emit, dispatch } = await lifecycle();
  await emit("thread.active");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const before = calls.length;
  await dispatch();
  expect(calls.length - before).toBe(1);
  await emit("thread.idle");
  await emit("thread.active");
  await harness.behavior.runSchedule("settle-owed");
  const captured = pins();
  expect(captured.map((p) => p.kind)).toEqual(["open", "end", "start", "open"]);
  expect(captured[1]?.commit).toBe(captured[2]?.commit);
  expect(captured[1]?.finishedAt).toBe(captured[2]?.finishedAt);
  await harness.lifecycle.dispose();
});

test("failed captures still deliver lifecycle markers on the next exchange", async () => {
  const { harness, state, pins, emit } = await lifecycle();
  state.failCapture = true;
  await emit("thread.active");
  await emit("thread.failed");
  expect(pins().map((p) => p.kind)).toEqual(["run", "stop"]);
  await harness.lifecycle.dispose();
});

test("sleeping hosts retain durable markers and replay them once when they wake", async () => {
  const { harness, bb, state, pins, emit } = await lifecycle();
  await emit("thread.active");
  state.offline = true;
  await emit("thread.failed");
  expect(await bb.storage.kv.list("owed:")).not.toHaveLength(0);
  state.offline = false;
  await harness.behavior.runSchedule("settle-owed");
  const count = pins().length;
  await harness.behavior.runSchedule("settle-owed");
  expect(pins().map((p) => p.kind)).toEqual(["open", "stop"]);
  expect(pins()).toHaveLength(count);
  expect(await bb.storage.kv.list("owed:")).toHaveLength(0);
  await harness.lifecycle.dispose();
});

test("a refused marker remains owed without losing acknowledged operations", async () => {
  const { harness, bb, state, emit } = await lifecycle();
  await emit("thread.active");
  state.refuse = true;
  await emit("thread.deleted");
  expect(await bb.storage.kv.list("owed:")).toHaveLength(2);
  state.refuse = false;
  await harness.behavior.runSchedule("settle-owed");
  expect(await bb.storage.kv.list("owed:")).toHaveLength(0);
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

test("a materialized attribution, even an empty one, never reshuffles on repeated reads", async () => {
  const inputs: unknown[] = [];
  const attribution = { start: "s", end: "e", contested: [], owned: [] };
  const { harness } = await setup([started, completed], [message], [], null, (call) => {
    inputs.push((call.input as { known?: unknown }).known);
    return snapshot({ otherPatch: otherPatchText, attribution });
  });
  stubWorkspaces(harness);
  await harness.callRpc("latestTurn", { threadId: "thread-1" });
  await harness.callRpc("latestTurn", { threadId: "thread-1" });
  expect(inputs).toEqual([undefined]);
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
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  expect(harness.sdk.callsTo("threads.get")).toHaveLength(1);
  expect(harness.sdk.callsTo("environments.get")).toHaveLength(1);
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

test("a long chat-only stretch scans in capped batches until a turn shows changes", async () => {
  const events = [
    started,
    completed,
    ...Array.from({ length: 22 }, (_, i) =>
      laterTurn(i).map((e) =>
        Object.assign({}, e, { createdAt: 100 + i * 2 + (e.type === "turn/completed" ? 1 : 0) }),
      ),
    ).flat(),
  ];
  const preparedAtScan: number[] = [];
  const counted = { details: () => 0 };
  const { harness, details } = await setup(events, [edit, message], [], null, (call) => {
    preparedAtScan.push(counted.details());
    const { window } = call.input as { window: { startedAt: number } };
    return snapshot({ patch: window.startedAt > 1 ? "" : snapshotPatchText });
  });
  counted.details = () => details.mock.calls.length;
  stubWorkspaces(harness);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2", patch: snapshotPatchText },
  });
  const scans = harness.experimental_hostRpcCalls.map((c) => (c.input as SyncInput).job);
  expect(scans.map((job) => job.candidates?.length)).toEqual([MAX_SCAN_CANDIDATES, 3]);
  // The first scan starts before any candidate beyond its batch is prepared.
  expect(preparedAtScan[0]).toBe(MAX_SCAN_CANDIDATES);
  expect(details.mock.calls).toHaveLength(23);
  await harness.lifecycle.dispose();
});

test("memo reconciliation fences a changed context boundary", async () => {
  const { harness } = await setup(undefined, undefined, [{}, { contextBoundarySeq: 25 }]);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2" },
  });
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  await harness.lifecycle.dispose();
});

test("late provider evidence advances the sequence and replaces the memo", async () => {
  const events: Event[] = [started, updated, completed];
  const { harness } = await setup(events);
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "turn-2" },
  });
  events.push(...laterTurn(0), {
    ...updated,
    id: "late-diff",
    seq: 35,
    scope: { kind: "turn", turnId: "later-0" },
  });
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { turnId: "later-0" },
  });
  await harness.lifecycle.dispose();
});

test("a temporary summary failure cannot poison the completed memo", async () => {
  const { harness } = await setup([started, completed], [], [], new Error("summary unavailable"));
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toEqual({ turn: null });
  harness.sdk.stub("threads.timelineTurnSummaryDetails", async () => ({ rows: [edit] }));
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { changes: [{ id: "edit-2" }] },
  });
  await harness.lifecycle.dispose();
});

test("lazy Unity context validates the exact revision and caches a single expanded edit", async () => {
  const yaml = "--- !u!1 &1\nGameObject:\n  m_Name: Player\n  m_IsActive: 0\n";
  const unityPatch =
    "diff --git a/Hero.prefab b/Hero.prefab\n--- a/Hero.prefab\n+++ b/Hero.prefab\n@@ -3,2 +3,2 @@\n   m_Name: Player\n-  m_IsActive: 1\n+  m_IsActive: 0\n";
  const { harness } = await setup([
    started,
    { ...updated, data: { ...updated.data, diff: unityPatch } },
    completed,
  ]);
  stubWorkspaces(harness);
  harness.sdk.stub("files.read", async () => ({ contentEncoding: "utf8", content: yaml }));
  const { turn } = (await harness.callRpc("latestTurn", { threadId: "thread-1" })) as {
    turn: { revision: string };
  };
  expect(harness.sdk.callsTo("files.read")).toHaveLength(0);
  const input = { threadId: "thread-1", revision: turn.revision, changeId: "0" };
  expect(await harness.callRpc("unityContext", input)).toMatchObject({
    diff: { groups: [{ name: "Player" }] },
  });
  await harness.callRpc("unityContext", input);
  expect(harness.sdk.callsTo("files.read")).toHaveLength(1);
  expect(await harness.callRpc("unityContext", { ...input, revision: "0".repeat(64) })).toEqual({
    diff: null,
  });
  expect(harness.sdk.callsTo("files.read")).toHaveLength(1);
  await harness.lifecycle.dispose();
});

test("a half-open host incurs one timeout across capture and fallback scan", async () => {
  let late = 0;
  const now = Date.now;
  const clock = spyOn(Date, "now").mockImplementation(() => now() + late);
  const { harness } = await setup(
    undefined,
    undefined,
    [],
    null,
    () => {
      late += 36_000;
      throw new Error("Host plugin call timed out");
    },
    true,
  );
  stubWorkspaces(harness);
  try {
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: lifecycleThread as never,
      error: null,
    });
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
  } finally {
    clock.mockRestore();
    await harness.lifecycle.dispose();
  }
});

test("captures never queue behind each other, and a scan still sees a capture under way", async () => {
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: SyncInput[] = [];
  const { harness } = await setup(
    undefined,
    undefined,
    [],
    null,
    async (call) => {
      const input = call.input as SyncInput;
      calls.push(input);
      const n = calls.length;
      if (n === 1) {
        entered();
        await held;
      }
      const applied = input.operations.map((o) => o.id);
      return input.job.kind === "capture"
        ? { applied, commit: commitOf(n) }
        : { applied, snapshots: input.job.candidates!.map(() => null) };
    },
    true,
  );
  stubWorkspaces(harness);
  const opening = harness.behavior.emitThreadEvent("thread.active", {
    thread: lifecycleThread as never,
  });
  await startedCall;
  const ending = harness.behavior.emitThreadEvent("thread.failed", {
    thread: { ...lifecycleThread, id: "thread-2" } as never,
    error: null,
  });
  // Thread 2's end capture reaches the host while thread 1's open is held.
  await waitUntil(() => calls.length === 2);
  expect(calls[1]).toMatchObject({ job: { kind: "capture" }, operations: [] });
  release();
  await Promise.all([opening, ending]);
  const scan = calls.find((c) => c.job.kind === "scan");
  expect(scan?.operations).toContainEqual(
    expect.objectContaining({
      method: "pin",
      input: expect.objectContaining({
        threadId: "thread-1",
        captures: [expect.objectContaining({ kind: "open" })],
      }),
    }),
  );
  await harness.lifecycle.dispose();
});

test("a follow-up dispatch waits for neither the idle scan nor owed markers", async () => {
  let release = () => {};
  let scanning = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanStarted = new Promise<void>((resolve) => {
    scanning = resolve;
  });
  const calls: SyncInput[] = [];
  const pinned: HostOperation[] = [];
  const { harness } = await setup(
    undefined,
    undefined,
    [],
    null,
    async (call) => {
      const input = call.input as SyncInput;
      calls.push(input);
      const applied = input.operations.map((operation) => {
        pinned.push(operation);
        return operation.id;
      });
      if (input.job.kind !== "scan") return { applied, commit: commitOf(calls.length) };
      scanning();
      await held;
      return { applied, snapshots: input.job.candidates!.map(() => null) };
    },
    true,
  );
  stubWorkspaces(harness);
  const emit = (event: "thread.active" | "thread.idle") =>
    harness.behavior.emitThreadEvent(event, {
      thread: lifecycleThread as never,
      lastAssistantText: null,
    });
  await emit("thread.active");
  const idle = emit("thread.idle");
  await scanStarted;
  // The scan still carries the unacknowledged end marker.
  const began = Date.now();
  expect(
    await harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        attempt: "start-turn",
        environment: readyEnvironment as never,
        thread: lifecycleThread as never,
        input: { blocks: [], text: "go" },
      }),
    ),
  ).toEqual({ action: "proceed" });
  expect(Date.now() - began).toBeLessThan(1_000);
  const baseline = calls.at(-1)!;
  expect(baseline).toMatchObject({ job: { kind: "capture" }, operations: [] });
  release();
  await idle;
  await emit("thread.active");
  await harness.behavior.runSchedule("settle-owed");
  const pins = pinned.flatMap((o) => (o.method === "pin" ? o.input.captures : []));
  expect(pins.map((p) => p.kind)).toEqual(["open", "end", "start", "open"]);
  expect(pins[2]?.commit).toBe(commitOf(calls.indexOf(baseline) + 1));
  await harness.lifecycle.dispose();
});

const isScan = (call: ExperimentalFakeHostRpcCall) => (call.input as SyncInput).job.kind === "scan";

test("a marker the host always refuses gates only its checkout's scans and drops after three tries", async () => {
  let late = 0;
  const now = Date.now;
  const clock = spyOn(Date, "now").mockImplementation(() => now() + late);
  const calls: SyncInput[] = [];
  const { harness, bb } = await setup(
    undefined,
    undefined,
    [],
    null,
    async (call) => {
      const input = call.input as SyncInput;
      calls.push(input);
      const refused = input.operations.filter((o) => o.input.threadId === "ghost");
      const applied = input.operations.filter((o) => !refused.includes(o)).map((o) => o.id);
      const { job } = input;
      if (job.kind === "capture") return { applied, commit: commitOf(calls.length) };
      if (job.kind === "settle") return { applied };
      return refused.some((o) => o.input.environmentPath === job.environmentPath)
        ? { applied, error: "Workspace markers remain owed" }
        : { applied, snapshots: job.candidates!.map(() => snapshot().snapshot) };
    },
    true,
  );
  stubWorkspaces(harness);
  const thread = { thread: lifecycleThread as never, lastAssistantText: null, error: null };
  try {
    await bb.storage.kv.set(`owed:h:${"0".repeat(15)}:${"0".repeat(12)}:ghost`, {
      hostId: "h",
      at: Date.now(),
      method: "forget",
      input: { environmentPath: "/ws/dotfiles", threadId: "ghost", at: Date.now() },
    });
    await harness.behavior.emitThreadEvent("thread.active", thread);
    await harness.behavior.emitThreadEvent("thread.idle", thread);
    // Captures carry no journal, so the refused marker never holds them back.
    const captures = calls.filter((c) => c.job.kind === "capture");
    expect(captures).toHaveLength(2);
    expect(captures.every((c) => c.operations.length === 0)).toBe(true);
    // The scan of the marker's checkout falls back to the provider's patch.
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { patch },
    });
    for (let i = 0; i < 2; i++) {
      late += 61_000;
      await harness.behavior.runSchedule("settle-owed");
    }
    expect(await bb.storage.kv.list("owed:")).toEqual([]);
    const drops = harness.logEntries.filter((e) => e.message.includes("dropped a workspace"));
    expect(drops).toHaveLength(1);
    // The periodic retry read the turn again and told visible clients.
    expect(harness.realtimeSignals.at(-1)).toEqual({
      channel: CHANGED_CHANNEL,
      payload: { threadId: "thread-1" },
    });
    const scans = calls.filter((c) => c.job.kind === "scan").length;
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { patch: snapshotPatchText },
    });
    expect(calls.filter((c) => c.job.kind === "scan")).toHaveLength(scans);
  } finally {
    clock.mockRestore();
    await harness.lifecycle.dispose();
  }
});

test("a read that fell back while its host failed refreshes clients once the host answers", async () => {
  let late = 0;
  const now = Date.now;
  const clock = spyOn(Date, "now").mockImplementation(() => now() + late);
  let down = true;
  const { harness } = await setup(undefined, undefined, [], null, (call) => {
    if (call.method !== "turnPatch") return { commit: null };
    if (down) throw new Error("Host is not connected");
    return snapshot();
  });
  stubWorkspaces(harness);
  try {
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { patch },
    });
    down = false;
    late += 31_000;
    // Another thread's capture is the first sign the host is back.
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: { ...lifecycleThread, id: "thread-2" } as never,
    });
    const refreshed = (s: { channel: string; payload: unknown }) =>
      s.channel === CHANGED_CHANNEL && (s.payload as { threadId: string }).threadId === "thread-1";
    await waitUntil(() => harness.realtimeSignals.some(refreshed));
    const scans = harness.experimental_hostRpcCalls.filter(isScan).length;
    expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
      turn: { patch: snapshotPatchText },
    });
    expect(harness.experimental_hostRpcCalls.filter(isScan)).toHaveLength(scans);
  } finally {
    clock.mockRestore();
    await harness.lifecycle.dispose();
  }
});

test("a lifecycle event between latestTurn and unityContext keeps the revision without a scan", async () => {
  const yaml = "--- !u!1 &1\nGameObject:\n  m_Name: Player\n  m_IsActive: 0\n";
  const unityPatch =
    "diff --git a/Hero.prefab b/Hero.prefab\n--- a/Hero.prefab\n+++ b/Hero.prefab\n@@ -3,2 +3,2 @@\n   m_Name: Player\n-  m_IsActive: 1\n+  m_IsActive: 0\n";
  const { harness } = await setup(
    [started, { ...updated, data: { ...updated.data, diff: unityPatch } }, completed],
    undefined,
    [],
    null,
    (call) => (call.method === "turnPatch" ? { snapshot: null } : { commit: null }),
  );
  stubWorkspaces(harness);
  harness.sdk.stub("files.read", async () => ({ contentEncoding: "utf8", content: yaml }));
  const { turn } = (await harness.callRpc("latestTurn", { threadId: "thread-1" })) as {
    turn: { revision: string };
  };
  // The next turn starts: the memo is fenced, but the displayed turn is unchanged.
  await harness.behavior.emitThreadEvent("thread.active", { thread: lifecycleThread as never });
  const scans = harness.experimental_hostRpcCalls.filter(isScan).length;
  expect(
    await harness.callRpc("unityContext", {
      threadId: "thread-1",
      revision: turn.revision,
      changeId: "0",
    }),
  ).toMatchObject({ diff: { groups: [{ name: "Player" }] } });
  expect(harness.experimental_hostRpcCalls.filter(isScan)).toHaveLength(scans);
  // A fresh read of the same evidence yields the same revision.
  expect(await harness.callRpc("latestTurn", { threadId: "thread-1" })).toMatchObject({
    turn: { revision: turn.revision },
  });
  await harness.lifecycle.dispose();
});

test("the memo keeps recently read threads and evicts the least recently used", async () => {
  const { harness } = await setup(undefined, undefined, [], null, () => ({ snapshot: null }));
  stubWorkspaces(harness);
  const scans = () => harness.experimental_hostRpcCalls.filter(isScan).length;
  const read = (n: number) => harness.callRpc("latestTurn", { threadId: `thread-${n}` });
  for (let n = 0; n < 64; n++) await read(n);
  expect(scans()).toBe(64);
  await read(0);
  await read(64);
  expect(scans()).toBe(65);
  await read(0);
  expect(scans()).toBe(65);
  await read(1);
  expect(scans()).toBe(66);
  await harness.lifecycle.dispose();
});

test("a failed workspace lookup is retried, while churny environment fields keep the memo", async () => {
  const { harness } = await setup(undefined, undefined, [], null, () => ({ snapshot: null }));
  stubWorkspaces(harness);
  harness.sdk.stub("projects.list", async () => {
    throw new Error("projects unavailable");
  });
  const read = () => harness.callRpc("latestTurn", { threadId: "thread-1" });
  expect(await read()).toMatchObject({ turn: { turnId: "turn-2" } });
  stubWorkspaces(harness);
  const labeled = await read();
  expect(labeled).toMatchObject({ turn: { workspace: "dotfiles" } });
  const scans = harness.experimental_hostRpcCalls.filter(isScan).length;
  expect(scans).toBe(2);
  harness.sdk.stub("environments.get", async () => ({
    id: "env-1",
    hostId: "h",
    path: "/ws/dotfiles",
    name: null,
    branchName: "scott/elsewhere",
    updatedAt: 99,
  }));
  expect(await read()).toEqual(labeled);
  expect(harness.experimental_hostRpcCalls.filter(isScan)).toHaveLength(scans);
  await harness.lifecycle.dispose();
});

test("another thread's long scan never delays this thread's end capture or dispatch", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: SyncInput[] = [];
  const { harness } = await setup(
    undefined,
    undefined,
    [],
    null,
    async (call) => {
      const input = call.input as SyncInput;
      calls.push(input);
      const applied = input.operations.map((o) => o.id);
      if (input.job.kind === "capture") return { applied, commit: commitOf(calls.length) };
      if (input.job.kind === "scan" && input.job.threadId === "thread-2") await held;
      return { applied, snapshots: input.job.candidates?.map(() => null) ?? [] };
    },
    true,
  );
  stubWorkspaces(harness);
  const other = harness.callRpc("latestTurn", { threadId: "thread-2" });
  await waitUntil(() => calls.some((c) => c.job.kind === "scan"));
  const thread = { thread: lifecycleThread as never, lastAssistantText: null, error: null };
  await harness.behavior.emitThreadEvent("thread.active", thread);
  const idle = harness.behavior.emitThreadEvent("thread.idle", thread);
  // Thread 1's end capture reaches the host while thread 2's scan holds the queue.
  await waitUntil(() => calls.filter((c) => c.job.kind === "capture").length === 2);
  const began = Date.now();
  await harness.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({
      attempt: "start-turn",
      environment: readyEnvironment as never,
      thread: lifecycleThread as never,
      input: { blocks: [], text: "go" },
    }),
  );
  expect(Date.now() - began).toBeLessThan(1_000);
  expect(calls.filter((c) => c.job.kind === "capture")).toHaveLength(3);
  release();
  await Promise.all([other, idle]);
  await harness.lifecycle.dispose();
});

test("a dispatch behind a capture that outlasted the budget proceeds at once without a baseline", async () => {
  let late = 0;
  const now = Date.now;
  const clock = spyOn(Date, "now").mockImplementation(() => now() + late);
  const { harness, calls, state, pins, emit, dispatch } = await lifecycle();
  try {
    await emit("thread.active");
    state.late = true;
    const idle = emit("thread.idle");
    await waitUntil(() => calls.length === 2);
    late += 2_000;
    const began = now();
    expect(await dispatch()).toEqual({ action: "proceed" });
    expect(now() - began).toBeLessThan(500);
    expect(calls).toHaveLength(2);
    state.late = false;
    await idle;
    await emit("thread.active");
    await harness.behavior.runSchedule("settle-owed");
    expect(pins().some((p) => p.kind === "start")).toBe(false);
  } finally {
    clock.mockRestore();
    await harness.lifecycle.dispose();
  }
});
