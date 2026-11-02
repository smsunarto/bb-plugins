import { describe, expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { TurnEvents } from "../../test/events.ts";
import type { ExportOutcome, TraceExporter } from "./neatlogs.ts";
import type { NeatlogsConfig } from "./settings.ts";
import { TracePump } from "./trace-pump.ts";
import type { NeatlogsSpan, ThreadEventRow } from "./turn-trace.ts";

type Sdk = BbPluginApi["sdk"];
type SubscribeArgs = Parameters<Sdk["subscribe"]>[0];
type ListEventsArgs = Parameters<Sdk["threads"]["events"]["list"]>[0];

const ACTIVATED_AT = 10_000;
const config: NeatlogsConfig = {
  apiKey: "test-key",
  traceUrl: "https://ingest.example/v1/trace",
  contentMode: "full",
};

interface FakeThread {
  id: string;
  createdAt: number;
  updatedAt: number;
  events: TurnEvents;
  sourceThreadId?: string;
}

function createRuntime(threads: FakeThread[]) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const subscriptions: SubscribeArgs[] = [];
  let listFailures = 0;
  const listEvents = async ({
    threadId,
    afterSeq,
    beforeSeq,
    order,
    limit,
    types,
  }: ListEventsArgs) => {
    if (Number(limit ?? 100) > 100) {
      throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    }
    const rows: ThreadEventRow[] = byId.get(threadId)?.events.rows ?? [];
    return rows
      .filter((event) => event.seq > Number(afterSeq ?? -Infinity))
      .filter((event) => event.seq < Number(beforeSeq ?? Infinity))
      .filter((event) => types === undefined || types.includes(event.type))
      .toSorted((a, b) => (order === "desc" ? b.seq - a.seq : a.seq - b.seq))
      .slice(0, Number(limit ?? 100));
  };
  const { bb } = createFakePluginHost({
    pluginId: "neatlogs",
    sdk: {
      subscribe: ((args: SubscribeArgs) => {
        subscriptions.push(args);
        return () => subscriptions.splice(subscriptions.indexOf(args), 1);
      }) as Sdk["subscribe"],
      threads: {
        list: (async ({
          archived,
          offset = 0,
          limit = 100,
        }: {
          archived?: boolean;
          offset?: number;
          limit?: number;
        }) => {
          if (listFailures > 0) {
            listFailures -= 1;
            throw new Error("HTTP 503");
          }
          return archived ? [] : [...byId.values()].slice(offset, offset + limit);
        }) as unknown as Sdk["threads"]["list"],
        get: (async ({ threadId }: { threadId: string }) => ({
          ...byId.get(threadId),
          environmentId: null,
          originPluginId: null,
          parentThreadId: null,
          projectId: "project-1",
          providerId: "claude-code",
          sourceThreadId: byId.get(threadId)?.sourceThreadId ?? null,
          title: null,
          visibility: "visible",
        })) as unknown as Sdk["threads"]["get"],
        events: { list: listEvents as unknown as Sdk["threads"]["events"]["list"] },
      },
    },
  });

  const exported: Array<{ threadId: string; turnId: string; at: number; trace: NeatlogsSpan }> = [];
  return {
    bb,
    exported,
    /** Records each export; the default outcome accepts it. */
    exporter(
      outcomes: (trace: NeatlogsSpan) => ExportOutcome | Promise<ExportOutcome> = () => accepted,
    ) {
      const exporter: TraceExporter = async (_config, trace) => {
        exported.push({
          threadId: String(trace.metadata?.threadId),
          turnId: String(trace.metadata?.turnId),
          at: Date.now(),
          trace,
        });
        return outcomes(trace);
      };
      return exporter;
    },
    emit(threadId: string, eventTypes: ThreadEventRow["type"][]) {
      for (const subscription of subscriptions) {
        if (subscription.event === "thread:changed") {
          subscription.callback({
            entity: "thread",
            type: "changed",
            id: threadId,
            changes: ["events-appended"],
            metadata: { eventTypes },
          } as never);
        }
      }
    },
    emitChange(threadId: string, changes: ["history-rewritten"] | ["thread-deleted"]) {
      for (const subscription of subscriptions) {
        if (subscription.event === "thread:changed") {
          subscription.callback({
            entity: "thread",
            type: "changed",
            id: threadId,
            changes,
          } as never);
        }
      }
    },
    failNextList() {
      listFailures += 1;
    },
  };
}

const accepted: ExportOutcome = { kind: "exported", traceId: "trace", spans: 1 };

function turn(events: TurnEvents, turnId: string, at: number): TurnEvents {
  return events
    .request(at, `prompt ${turnId}`)
    .started(turnId, at + 1)
    .item(turnId, at + 2, at + 3, { id: `${turnId}-m`, type: "agentMessage", text: "ok" })
    .completed(turnId, at + 4);
}

function start(
  runtime: ReturnType<typeof createRuntime>,
  exporter: TraceExporter,
  retryDelayMs = 60_000,
) {
  const controller = new AbortController();
  const pump = new TracePump({
    bb: runtime.bb,
    getConfig: () => config,
    exporter,
    now: () => ACTIVATED_AT,
    retryDelayMs,
  });
  const done = pump.run(controller.signal);
  return {
    pump,
    async stop() {
      controller.abort();
      await done;
    },
  };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out: ${message}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("TracePump", () => {
  test("exports each completed turn once, when BB reports the turn completed", async () => {
    const thread = {
      id: "thread-1",
      createdAt: 20_000,
      updatedAt: 20_000,
      events: new TurnEvents("thread-1"),
    };
    const runtime = createRuntime([thread]);
    const run = start(runtime, runtime.exporter());
    await settle();

    turn(thread.events, "t1", 20_000);
    runtime.emit("thread-1", ["item/agentMessage/delta"]);
    await settle();
    expect(runtime.exported).toEqual([]);

    runtime.emit("thread-1", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 1, "first turn");

    turn(thread.events, "t2", 21_000);
    runtime.emit("thread-1", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 2, "second turn");
    runtime.emit("thread-1", ["turn/completed"]);
    await settle();
    await run.stop();

    expect(runtime.exported.map((entry) => entry.turnId)).toEqual(["t1", "t2"]);
  });

  test("never exports history from before activation, including a turn open at activation", async () => {
    const events = new TurnEvents("old");
    turn(events, "before", 1_000);
    events.request(9_000, "spans activation").started("open", 9_001);
    const old = { id: "old", createdAt: 1_000, updatedAt: 9_001, events };
    const runtime = createRuntime([old]);
    const run = start(runtime, runtime.exporter());

    events.completed("open", 11_000);
    old.updatedAt = 11_000;
    runtime.emit("old", ["turn/completed"]);
    await settle();
    expect(runtime.exported).toEqual([]);

    turn(events, "after", 12_000);
    runtime.emit("old", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 1, "post-activation turn");
    await run.stop();

    expect(runtime.exported.map((entry) => entry.turnId)).toEqual(["after"]);
  });

  test("on startup, exports turns that completed while unloaded on threads changed since activation", async () => {
    const changed = {
      id: "changed",
      createdAt: 20_000,
      updatedAt: 0,
      events: new TurnEvents("changed"),
    };
    const untouched = {
      id: "untouched",
      createdAt: 1_000,
      updatedAt: 2_000,
      events: new TurnEvents("untouched"),
    };
    turn(untouched.events, "old", 1_000);
    const runtime = createRuntime([changed, untouched]);

    // A first load records activation, then the plugin unloads.
    const first = start(runtime, runtime.exporter());
    await settle();
    await first.stop();

    turn(changed.events, "missed", 20_000);
    changed.updatedAt = 20_004;
    const second = start(runtime, runtime.exporter());
    await waitFor(() => runtime.exported.length === 1, "missed turn");
    await settle();
    await second.stop();

    expect(runtime.exported.map((entry) => `${entry.threadId}/${entry.turnId}`)).toEqual([
      "changed/missed",
    ]);
  });

  test("backs off after a transient failure even when the thread wakes again", async () => {
    const thread = {
      id: "thread-1",
      createdAt: 20_000,
      updatedAt: 20_000,
      events: new TurnEvents("thread-1"),
    };
    turn(thread.events, "t1", 20_000);
    const runtime = createRuntime([thread]);
    const outcomes: ExportOutcome[] = [{ kind: "retry", reason: "HTTP 429" }];
    // Startup reconciliation finds t1 on the thread changed since activation.
    const run = start(
      runtime,
      runtime.exporter(() => outcomes.shift() ?? accepted),
      100,
    );
    await waitFor(() => runtime.exported.length === 1, "first attempt");

    runtime.emit("thread-1", ["turn/completed"]);
    await settle();
    expect(runtime.exported).toHaveLength(1);

    await waitFor(() => runtime.exported.length === 2, "retry after the delay");
    await settle();
    await run.stop();

    const [failed, retried] = runtime.exported;
    expect((retried?.at ?? 0) - (failed?.at ?? 0)).toBeGreaterThanOrEqual(90);
    expect(runtime.exported.map((entry) => entry.turnId)).toEqual(["t1", "t1"]);
  });

  test("skips a turn Neatlogs rejects and holds every thread when it refuses the key", async () => {
    const one = { id: "one", createdAt: 20_000, updatedAt: 20_000, events: new TurnEvents("one") };
    const two = { id: "two", createdAt: 20_000, updatedAt: 20_000, events: new TurnEvents("two") };
    const runtime = createRuntime([one, two]);
    const outcomes: Record<string, ExportOutcome[]> = {
      "one/t1": [{ kind: "rejected", status: 400 }],
      "one/t2": [{ kind: "refused", status: 401 }],
    };
    const run = start(
      runtime,
      runtime.exporter(
        (trace) =>
          outcomes[
            `${String(trace.metadata?.threadId)}/${String(trace.metadata?.turnId)}`
          ]?.shift() ?? accepted,
      ),
    );
    await settle();

    turn(one.events, "t1", 21_000);
    runtime.emit("one", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 1, "t1 rejected");
    turn(one.events, "t2", 22_000);
    runtime.emit("one", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 2, "t2 refused");

    turn(two.events, "t1", 23_000);
    runtime.emit("two", ["turn/completed"]);
    await settle();
    expect(runtime.exported).toHaveLength(2);

    one.updatedAt = 22_004;
    two.updatedAt = 23_004;
    run.pump.configurationChanged();
    await waitFor(() => runtime.exported.length === 4, "both threads after a settings change");
    await settle();
    await run.stop();

    expect(runtime.exported.map((entry) => `${entry.threadId}/${entry.turnId}`).toSorted()).toEqual(
      ["one/t1", "one/t2", "one/t2", "two/t1"],
    );
  });

  test("exports a fork's own turns but not the history it inherited", async () => {
    const events = new TurnEvents("fork");
    turn(events, "source-turn", 15_000); // copied with the source's timestamps
    const fork = {
      id: "fork",
      createdAt: 30_000,
      updatedAt: 30_000,
      events,
      sourceThreadId: "source",
    };
    const runtime = createRuntime([fork]);
    const run = start(runtime, runtime.exporter());
    await settle();

    runtime.emit("fork", ["turn/completed"]);
    await settle();
    expect(runtime.exported).toEqual([]);

    turn(events, "own-turn", 31_000);
    runtime.emit("fork", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 1, "fork's own turn");
    await run.stop();

    expect(runtime.exported.map((entry) => entry.turnId)).toEqual(["own-turn"]);
  });

  test("exports the turn rerun by a message edit", async () => {
    const events = new TurnEvents("thread-1");
    const thread = { id: "thread-1", createdAt: 20_000, updatedAt: 20_000, events };
    const runtime = createRuntime([thread]);
    const run = start(runtime, runtime.exporter());
    await settle();

    turn(events, "t1", 20_000);
    const editPoint = events.rows.at(-1)?.seq ?? 0;
    turn(events, "t2", 21_000);
    runtime.emit("thread-1", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 2, "original turns");

    events.truncateAfter(editPoint);
    turn(events, "t2-edited", 22_000);
    runtime.emitChange("thread-1", ["history-rewritten"]);
    await waitFor(() => runtime.exported.length === 3, "rerun turn");
    await run.stop();

    expect(runtime.exported.map((entry) => entry.turnId)).toEqual(["t1", "t2", "t2-edited"]);
    expect(runtime.exported[2]?.trace.input).toBe("prompt t2-edited");
  });

  test("reports each turn's usage against the previous turn's cumulative total", async () => {
    const events = new TurnEvents("thread-1");
    const thread = { id: "thread-1", createdAt: 20_000, updatedAt: 20_000, events };
    const runtime = createRuntime([thread]);
    const run = start(runtime, runtime.exporter());
    await settle();

    const usage = (output: number, total: number) => ({
      input: total - output,
      cached: 0,
      cacheRead: 0,
      output,
      total,
    });
    events
      .request(20_000, "one")
      .started("t1", 20_001)
      .usage("t1", 20_002, usage(100, 1_000))
      .completed("t1", 20_003);
    events
      .request(21_000, "two")
      .started("t2", 21_001)
      .usage("t2", 21_002, usage(150, 3_000))
      .completed("t2", 21_003);
    runtime.emit("thread-1", ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 2, "both turns");
    await run.stop();

    expect(runtime.exported.map((entry) => entry.trace.children?.at(-1)?.tokens)).toEqual([
      { prompt: 900, completion: 100, total: 1_000 },
      { prompt: 1_950, completion: 50, total: 2_000 },
    ]);
  });

  test("retries thread discovery that failed at startup", async () => {
    const thread = {
      id: "thread-1",
      createdAt: 20_000,
      updatedAt: 20_000,
      events: new TurnEvents("thread-1"),
    };
    const runtime = createRuntime([thread]);
    const first = start(runtime, runtime.exporter());
    await settle();
    await first.stop();

    turn(thread.events, "missed", 20_000);
    thread.updatedAt = 20_004;
    runtime.failNextList();
    const second = start(runtime, runtime.exporter(), 50);
    await settle();
    expect(runtime.exported).toEqual([]);
    await waitFor(() => runtime.exported.length === 1, "discovery retry");
    await second.stop();
  });

  test("assembles a turn whose events span several pages", async () => {
    const events = new TurnEvents("thread-1").request(20_000, "many calls").started("t1", 20_001);
    for (let index = 0; index < 120; index += 1) {
      events.item("t1", 20_100 + index * 10, 20_105 + index * 10, {
        id: `cmd-${index}`,
        type: "commandExecution",
        command: `echo ${index}`,
        cwd: "",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "",
      });
    }
    events.completed("t1", 22_000);
    const thread = { id: "thread-1", createdAt: 20_000, updatedAt: 22_000, events };
    const runtime = createRuntime([thread]);
    const traces: NeatlogsSpan[] = [];
    const run = start(
      runtime,
      runtime.exporter((trace) => {
        traces.push(trace);
        return accepted;
      }),
    );

    await waitFor(() => traces.length === 1, "multi-page turn");
    await settle();
    await run.stop();

    expect(traces).toHaveLength(1);
    expect(traces[0]?.children?.filter((span) => span.kind === "TOOL")).toHaveLength(120);
  });

  test("exports at most four threads at a time", async () => {
    const threads = Array.from({ length: 10 }, (_, index) => {
      const thread = {
        id: `thread-${index}`,
        createdAt: 20_000,
        updatedAt: 20_000,
        events: new TurnEvents(`thread-${index}`),
      };
      turn(thread.events, "t1", 20_000);
      return thread;
    });
    const runtime = createRuntime(threads);
    let inFlight = 0;
    let peak = 0;
    const run = start(
      runtime,
      runtime.exporter(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return accepted;
      }),
    );

    for (const thread of threads) runtime.emit(thread.id, ["turn/completed"]);
    await waitFor(() => runtime.exported.length === 10, "every thread");
    await run.stop();

    expect(peak).toBe(4);
  });
});
