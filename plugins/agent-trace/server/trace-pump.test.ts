import { describe, expect, mock, test, type Mock } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ExportError } from "./exporters/otlp.ts";
import type { ExportTraceServiceRequest, ThreadEventRow } from "./turn-trace.ts";
import type { AgentTraceConfig } from "../shared/settings.ts";
import {
  checkpointKey,
  TracePump,
  type TraceExporter,
  type ThreadCheckpoint,
} from "./trace-pump.ts";

type SubscribeArgs = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type Thread = ReturnType<typeof makeThreadResponse>;
type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type EventOf<T extends ThreadEventRow["type"]> = Extract<ThreadEventRow, { type: T }>;

const config: AgentTraceConfig = {
  contentMode: "metadata",
  deploymentEnvironment: "test",
  laminar: { apiKey: "test-key", endpoint: "http://127.0.0.1/v1/traces" },
  langfuse: null,
};

function row<T extends ThreadEventRow["type"]>(
  type: T,
  seq: number,
  data: EventOf<T>["data"],
  threadId: string,
  turnId = "turn-1",
): EventOf<T> {
  return {
    id: `${threadId}-event-${seq}`,
    scope: { kind: "turn", turnId },
    threadId,
    seq,
    createdAt: seq,
    type,
    data,
  } as EventOf<T>;
}

function started(threadId: string, seq = 1, turnId = "turn-1"): EventOf<"turn/started"> {
  return row("turn/started", seq, { providerThreadId: `provider-${threadId}` }, threadId, turnId);
}

function completed(threadId: string, seq = 2, turnId = "turn-1"): EventOf<"turn/completed"> {
  return row(
    "turn/completed",
    seq,
    { providerThreadId: `provider-${threadId}`, status: "completed" },
    threadId,
    turnId,
  );
}

function assistant(
  threadId: string,
  seq: number,
  text: string,
  turnId = "turn-1",
): EventOf<"item/completed"> {
  return row(
    "item/completed",
    seq,
    {
      providerThreadId: `provider-${threadId}`,
      item: { id: `${threadId}-assistant-${seq}`, type: "agentMessage", text },
    },
    threadId,
    turnId,
  );
}

function testThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return makeThreadResponse({
    archivedAt: null,
    createdAt: 2_000,
    environmentId: "environment-1",
    id,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "provider-1",
    status: "idle",
    visibility: "visible",
    ...overrides,
  });
}

function listedThread(thread: Thread): ListedThread {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: thread.archivedAt,
    createdAt: thread.createdAt,
    deletedAt: thread.deletedAt,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: thread.environmentId,
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    id: thread.id,
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: 0,
    originKind: null,
    originPluginId: null,
    parentThreadId: thread.parentThreadId,
    pinSortKey: null,
    pinnedAt: thread.pinnedAt,
    projectId: thread.projectId,
    providerId: thread.providerId,
    queuedWork: "none",
    runtime: { displayStatus: thread.status, hostReconnectGraceExpiresAt: null },
    sectionId: thread.sectionId,
    sourceThreadId: thread.sourceThreadId,
    status: thread.status,
    title: thread.title,
    titleFallback: null,
    updatedAt: thread.updatedAt,
    visibility: thread.visibility,
  };
}

interface Runtime {
  bb: BbPluginApi;
  emitConnection(): void;
  emitGlobalThread(changes: readonly ["history-rewritten"]): void;
  emitThread(
    threadId: string,
    changes?: readonly ["events-appended"] | readonly ["history-rewritten"],
  ): void;
  events: Map<string, ThreadEventRow[]>;
  listEvents: Mock<BbPluginApi["sdk"]["threads"]["events"]["list"]>;
  listThreads: Mock<BbPluginApi["sdk"]["threads"]["list"]>;
  subscriptionCountAtFirstList(): number | null;
  subscribe: Mock<(args: SubscribeArgs) => () => void>;
  threads: Map<string, Thread>;
}

function createRuntime(initialThreads: Thread[] = []): Runtime {
  const threads = new Map(initialThreads.map((thread) => [thread.id, thread]));
  const events = new Map<string, ThreadEventRow[]>();
  const subscriptions: SubscribeArgs[] = [];
  const subscribe = mock((args: SubscribeArgs) => {
    subscriptions.push(args);
    return () => {
      const index = subscriptions.indexOf(args);
      if (index >= 0) subscriptions.splice(index, 1);
    };
  });
  let firstListSubscriptionCount: number | null = null;
  const listThreads = mock<BbPluginApi["sdk"]["threads"]["list"]>(
    async (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => {
      firstListSubscriptionCount ??= subscribe.mock.calls.length;
      const matching = [...threads.values()]
        .filter((thread) => (thread.archivedAt !== null) === Boolean(args?.archived))
        .map(listedThread);
      const offset = args?.offset ?? 0;
      const limit = args?.limit ?? 100;
      return matching.slice(offset, offset + limit);
    },
  );
  const getThread = mock(async (args: Parameters<BbPluginApi["sdk"]["threads"]["get"]>[0]) => {
    const thread = threads.get(args.threadId);
    if (thread === undefined) throw new Error(`missing test thread ${args.threadId}`);
    return thread;
  });
  const listEvents = mock<BbPluginApi["sdk"]["threads"]["events"]["list"]>(
    async (args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0]) => {
      const source = events.get(args.threadId) ?? [];
      const after = args.afterSeq === undefined ? Number.NEGATIVE_INFINITY : Number(args.afterSeq);
      const before =
        args.beforeSeq === undefined ? Number.POSITIVE_INFINITY : Number(args.beforeSeq);
      const ordered = source
        .filter((event) => event.seq > after && event.seq < before)
        .toSorted((left, right) =>
          args.order === "desc" ? right.seq - left.seq : left.seq - right.seq,
        );
      return ordered.slice(0, Number(args.limit ?? "100"));
    },
  );
  const { bb } = createFakePluginHost({
    pluginId: "agent-trace",
    sdk: {
      subscribe: subscribe as BbPluginApi["sdk"]["subscribe"],
      threads: {
        get: getThread,
        list: listThreads,
        events: { list: listEvents },
      },
    },
  });

  return {
    bb,
    emitConnection() {
      for (const subscription of subscriptions) {
        if (subscription.event === "realtime:connection") {
          subscription.callback({ reconnectDelayMs: null, reconnected: true, state: "connected" });
        }
      }
    },
    emitGlobalThread(changes) {
      for (const subscription of subscriptions) {
        if (subscription.event === "thread:changed") {
          subscription.callback({ entity: "thread", type: "changed", changes });
        }
      }
    },
    emitThread(threadId, changes = ["events-appended"]) {
      for (const subscription of subscriptions) {
        if (subscription.event === "thread:changed") {
          subscription.callback({ entity: "thread", type: "changed", id: threadId, changes });
        }
      }
    },
    events,
    listEvents,
    listThreads,
    subscriptionCountAtFirstList: () => firstListSubscriptionCount,
    subscribe,
    threads,
  };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out: ${message}`);
}

function startPump(
  runtime: Runtime,
  exporter: TraceExporter,
  settings = config,
): { controller: AbortController; done: Promise<void> } {
  const controller = new AbortController();
  const pump = new TracePump({
    bb: runtime.bb,
    exporter,
    getConfig: () => settings,
    now: () => 1_000,
  });
  return { controller, done: pump.run(controller.signal) };
}

async function stopPump(run: { controller: AbortController; done: Promise<void> }): Promise<void> {
  run.controller.abort();
  await run.done;
}

async function checkpoint(
  runtime: Runtime,
  threadId: string,
): Promise<ThreadCheckpoint | undefined> {
  return runtime.bb.storage.kv.get<ThreadCheckpoint>(checkpointKey(threadId));
}

describe("trace pump cursor and retry behavior", () => {
  test("assembles a completed turn across pages and does not advance for an incomplete turn", async () => {
    const completeThread = testThread("complete");
    const incompleteThread = testThread("incomplete");
    const runtime = createRuntime([completeThread, incompleteThread]);
    const filler = Array.from({ length: 198 }, (_, index) =>
      row(
        "system/operation",
        index + 2,
        {
          message: "metadata only",
          operation: "test",
          operationId: `operation-${index}`,
          status: "complete",
        },
        completeThread.id,
      ),
    );
    runtime.events.set(completeThread.id, [
      started(completeThread.id),
      ...filler,
      assistant(completeThread.id, 200, "answer"),
      completed(completeThread.id, 201),
    ]);
    runtime.events.set(incompleteThread.id, [started(incompleteThread.id)]);
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter);

    await waitFor(() => exporter.mock.calls.length === 1, "cross-page trace export");
    await waitFor(
      () => runtime.listEvents.mock.calls.some(([args]) => args.threadId === incompleteThread.id),
      "incomplete thread scan",
    );

    expect((await checkpoint(runtime, completeThread.id))?.cursor).toBe(201);
    expect((await checkpoint(runtime, incompleteThread.id))?.cursor).toBe(0);
    expect(
      runtime.listEvents.mock.calls.filter(([args]) => args.threadId === completeThread.id),
    ).toHaveLength(2);
    expect(exporter.mock.calls[0]![1].resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(3);
    await stopPump(run);
  });

  test.each([401, 429, 500])("HTTP %d keeps the durable checkpoint unchanged", async (status) => {
    const thread = testThread(`failure-${status}`);
    const runtime = createRuntime([thread]);
    runtime.events.set(thread.id, [started(thread.id), completed(thread.id)]);
    const exporter = mock<TraceExporter>(async () => {
      throw new ExportError("laminar", status);
    });
    const run = startPump(runtime, exporter);

    await waitFor(() => exporter.mock.calls.length === 1, `HTTP ${status} attempt`);
    expect((await checkpoint(runtime, thread.id))?.cursor).toBe(0);
    await stopPump(run);
  });

  test("coalesces duplicate thread wakes into one export", async () => {
    const runtime = createRuntime();
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter);
    await waitFor(() => runtime.listThreads.mock.calls.length === 2, "startup discovery");

    const thread = testThread("duplicate-wake");
    runtime.threads.set(thread.id, thread);
    runtime.events.set(thread.id, [started(thread.id), completed(thread.id)]);
    runtime.emitThread(thread.id);
    runtime.emitThread(thread.id);

    await waitFor(() => exporter.mock.calls.length === 1, "coalesced export");
    await waitFor(async () => (await checkpoint(runtime, thread.id))?.cursor === 2, "checkpoint");
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(
      runtime.listEvents.mock.calls.filter(([args]) => args.threadId === thread.id),
    ).toHaveLength(1);
    expect(runtime.subscribe.mock.calls.map(([args]) => args.event).toSorted()).toEqual([
      "realtime:connection",
      "thread:changed",
    ]);
    expect(runtime.subscriptionCountAtFirstList()).toBe(2);
    await stopPump(run);
  });

  test("a restarted pump retries the same deterministic trace and resumes its checkpoint", async () => {
    const thread = testThread("reload");
    const runtime = createRuntime([thread]);
    runtime.events.set(thread.id, [
      started(thread.id),
      assistant(thread.id, 2, "answer"),
      completed(thread.id, 3),
    ]);
    const firstRequests: ExportTraceServiceRequest[] = [];
    const firstExporter = mock<TraceExporter>(async (_config, request) => {
      firstRequests.push(request);
      throw new ExportError("laminar", 500);
    });
    const firstRun = startPump(runtime, firstExporter);
    await waitFor(() => firstExporter.mock.calls.length === 1, "first failed export");
    expect((await checkpoint(runtime, thread.id))?.cursor).toBe(0);
    await stopPump(firstRun);

    const secondRequests: ExportTraceServiceRequest[] = [];
    const secondExporter = mock<TraceExporter>(async (_config, request) => {
      secondRequests.push(request);
    });
    const secondRun = startPump(runtime, secondExporter);
    await waitFor(() => secondExporter.mock.calls.length === 1, "retry after restart");

    expect(secondRequests).toEqual(firstRequests);
    expect((await checkpoint(runtime, thread.id))?.cursor).toBe(3);
    await stopPump(secondRun);
  });
});

describe("trace pump activation and reconciliation", () => {
  test("exports every provider through one BB event subscription", async () => {
    const codex = testThread("codex-thread", { providerId: "codex" });
    const cursor = testThread("cursor-thread", { providerId: "acp-cursor" });
    const runtime = createRuntime([codex, cursor]);
    runtime.events.set(codex.id, [started(codex.id), completed(codex.id)]);
    runtime.events.set(cursor.id, [started(cursor.id), completed(cursor.id)]);
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter);

    await waitFor(() => exporter.mock.calls.length === 2, "provider-independent exports");

    const providerIds = exporter.mock.calls.map(([, request]) => {
      const root = request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      return root.attributes.find((attribute) => attribute.key === "bb.provider.id")?.value
        .stringValue;
    });
    expect(providerIds.toSorted()).toEqual(["acp-cursor", "codex"]);
    expect(
      runtime.subscribe.mock.calls.filter(([args]) => args.event === "thread:changed"),
    ).toHaveLength(1);
    await stopPump(run);
  });

  test("baselines old history, skips its open turn, and exports a new thread's first turn", async () => {
    const oldIdle = testThread("old-idle", { createdAt: 100 });
    const oldActive = testThread("old-active", { createdAt: 100, status: "active" });
    const runtime = createRuntime([oldIdle, oldActive]);
    runtime.events.set(oldIdle.id, [started(oldIdle.id), completed(oldIdle.id)]);
    runtime.events.set(oldActive.id, [started(oldActive.id)]);
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter);

    await waitFor(
      async () => (await checkpoint(runtime, oldIdle.id))?.cursor === 2,
      "old baseline",
    );
    await waitFor(
      async () => (await checkpoint(runtime, oldActive.id))?.cursor === 1,
      "open baseline",
    );
    expect(exporter).toHaveBeenCalledTimes(0);

    runtime.threads.set(oldActive.id, { ...oldActive, status: "idle" });
    runtime.events.set(oldActive.id, [started(oldActive.id), completed(oldActive.id)]);
    runtime.emitThread(oldActive.id);
    await waitFor(
      async () => (await checkpoint(runtime, oldActive.id))?.cursor === 2,
      "old open turn skip",
    );
    expect(exporter).toHaveBeenCalledTimes(0);

    const fresh = testThread("fresh", { createdAt: 2_000 });
    runtime.threads.set(fresh.id, fresh);
    runtime.events.set(fresh.id, [started(fresh.id), completed(fresh.id)]);
    runtime.emitThread(fresh.id);
    await waitFor(() => exporter.mock.calls.length === 1, "first fresh turn");
    expect((await checkpoint(runtime, fresh.id))?.cursor).toBe(2);
    await stopPump(run);
  });

  test("reconnect discovers and exports turns appended while notifications were unavailable", async () => {
    const thread = testThread("reconnect", { archivedAt: 500, createdAt: 100 });
    const runtime = createRuntime([thread]);
    runtime.events.set(thread.id, [started(thread.id), completed(thread.id)]);
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter);
    await waitFor(
      async () => (await checkpoint(runtime, thread.id))?.cursor === 2,
      "archived baseline",
    );

    runtime.events.set(thread.id, [
      started(thread.id),
      completed(thread.id),
      started(thread.id, 3, "turn-2"),
      completed(thread.id, 4, "turn-2"),
    ]);
    runtime.emitConnection();
    await waitFor(() => exporter.mock.calls.length === 1, "reconnect catch-up");

    expect((await checkpoint(runtime, thread.id))?.cursor).toBe(4);
    expect(
      runtime.listThreads.mock.calls.some(
        ([args]) => args?.archived === true && args.includeHidden,
      ),
    ).toBe(true);
    await stopPump(run);
  });

  test("an ID-less history rewrite rebases checkpoints without suppressing a new thread", async () => {
    const thread = testThread("rewrite", { createdAt: 100 });
    const runtime = createRuntime([thread]);
    runtime.events.set(thread.id, [started(thread.id), completed(thread.id)]);
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter);
    await waitFor(
      async () => (await checkpoint(runtime, thread.id))?.cursor === 2,
      "initial baseline",
    );

    const fresh = testThread("fresh-during-rewrite");
    runtime.threads.set(fresh.id, fresh);
    runtime.events.set(fresh.id, [started(fresh.id), completed(fresh.id)]);
    runtime.events.set(thread.id, [
      started(thread.id, 4, "replacement"),
      completed(thread.id, 5, "replacement"),
    ]);
    runtime.emitGlobalThread(["history-rewritten"]);
    await waitFor(
      async () => (await checkpoint(runtime, thread.id))?.historyRevision === 1,
      "rewrite rebase",
    );
    await waitFor(() => exporter.mock.calls.length === 1, "new thread export during rewrite");
    expect((await checkpoint(runtime, thread.id))?.cursor).toBe(5);
    expect((await checkpoint(runtime, fresh.id))?.cursor).toBe(2);
    exporter.mockClear();

    runtime.events.set(thread.id, [
      started(thread.id, 4, "replacement"),
      completed(thread.id, 5, "replacement"),
      started(thread.id, 6, "turn-after-rewrite"),
      completed(thread.id, 7, "turn-after-rewrite"),
    ]);
    runtime.emitThread(thread.id);
    await waitFor(() => exporter.mock.calls.length === 1, "post-rewrite export");
    const root = exporter.mock.calls[0]![1].resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const revision = root.attributes.find((attribute) => attribute.key === "bb.history.revision");
    expect(revision?.value.intValue).toBe("1");
    expect((await checkpoint(runtime, thread.id))?.cursor).toBe(7);
    await stopPump(run);
  });

  test("hidden threads stay metadata-only when full content is configured", async () => {
    const thread = testThread("hidden", { visibility: "hidden" });
    const runtime = createRuntime([thread]);
    runtime.events.set(thread.id, [
      started(thread.id),
      assistant(thread.id, 2, "hidden answer secret"),
      completed(thread.id, 3),
    ]);
    const exporter = mock<TraceExporter>(async () => {});
    const run = startPump(runtime, exporter, { ...config, contentMode: "full" });

    await waitFor(() => exporter.mock.calls.length === 1, "hidden trace export");
    expect(JSON.stringify(exporter.mock.calls[0]![1])).not.toContain("hidden answer secret");
    await stopPump(run);
  });
});
