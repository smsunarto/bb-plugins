// Who holds an annotation after re-runs, mentions, and restarts, through the
// real server: the message.dispatch hook, the mention provider's `resolve`, and
// startup recovery.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import BetterSqlite from "better-sqlite3";

import { claimStagedAnnotations, completeDispatch } from "../lib/staging.ts";
import { ANNOTATION_MENTION_PROVIDER, annotationMentionItemId } from "../lib/staging-display.ts";
import { setAnnotationStatus } from "../lib/store.ts";
import plugin from "../server.ts";

// The fake host's `storage.database()` sets a pragma through better-sqlite3's
// API, which the shared bun:sqlite stand-in does not provide.
const sqlite = BetterSqlite.prototype as { pragma?: (source: string) => unknown };
sqlite.pragma ??= function (this: { query(sql: string): { all(): unknown } }, source: string) {
  return this.query(`PRAGMA ${source}`).all();
};

type Thread = ReturnType<typeof makeThreadResponse>;
type Host = ReturnType<typeof createFakePluginHost>;

const config = async () => ({
  experiments: {},
  generalSettings: { steerActiveThreadOnEnter: false },
});

function idleSdk(status: Thread["status"] = "idle") {
  return {
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({ id: threadId, status }),
    },
    system: { config },
  };
}

async function seedAnnotations(harness: Host["harness"], ids: string[]) {
  const { session } = (await harness.callRpc("openSession", {
    url: "https://bb.example.test/settings",
    route: "/settings",
    title: null,
    threadId: null,
    projectId: null,
  })) as { session: { id: string } };
  await harness.callRpc("pushAnnotations", {
    sessionId: session.id,
    deletedIds: [],
    upserts: ids.map((id) => ({
      annotation: {
        id,
        comment: `Feedback ${id}`,
        elementPath: "button.save",
        timestamp: 1,
        x: 1,
        y: 1,
        element: "button.save",
      },
      bb: {
        route: "/settings",
        pluginId: null,
        surface: null,
        threadId: null,
        projectId: null,
        routeLabel: null,
      },
    })),
  });
}

function inspect({ bb, harness }: Host) {
  const db = bb.storage.database();
  const hook = harness.inspection.registrations.hooks["message.dispatch"];
  assert.ok(hook);
  const provider = harness.inspection.registrations.mentionProviders.find(
    (candidate) => candidate.id === ANNOTATION_MENTION_PROVIDER,
  );
  assert.ok(provider);
  const staged = async () =>
    (
      (await harness.callRpc("listStagedAnnotations", null)) as { annotations: { id: string }[] }
    ).annotations.map((annotation) => annotation.id);
  const view = async (annotationId = "ann_1") => {
    const { annotations, routings } = (await harness.callRpc("listAnnotations", {
      sessionId: null,
      statuses: null,
      pluginId: null,
    })) as {
      annotations: { id: string; status: string }[];
      routings: Record<string, { state: string; threadId?: string }>;
    };
    const routing = routings[annotationId];
    return {
      status: annotations.find((annotation) => annotation.id === annotationId)?.status,
      holder: routing?.state === "assigned" ? routing.threadId : routing?.state,
    };
  };
  const dispatchRows = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM annotation_dispatches`).get() as { n: number }).n;
  return {
    db,
    harness,
    hook,
    resolve: provider.resolve,
    staged,
    view,
    dispatchRows,
    acknowledge: (annotationId = "ann_1") =>
      harness.callAgentTool("agentation_acknowledge", { annotationId }),
  };
}

async function withHost(
  run: (host: ReturnType<typeof inspect>) => Promise<void>,
  sdk: Record<string, unknown> = {},
) {
  const host = createFakePluginHost({ pluginId: "agentation", sdk: sdk as never });
  await plugin(host.bb);
  try {
    await seedAnnotations(host.harness, ["ann_1"]);
    await run(inspect(host));
  } finally {
    await host.harness.lifecycle.dispose();
  }
}

function pill(thread: Thread, annotationId = "ann_1") {
  return makeMessageDispatchHookContext({
    thread,
    attempt: "start-turn",
    input: {
      text: "fix this",
      blocks: [
        {
          type: "text",
          text: "fix this",
          mentions: [
            {
              start: 0,
              end: 1,
              resource: {
                kind: "plugin",
                pluginId: "agentation",
                itemId: `annotation:${annotationId}`,
                label: "pill",
              },
            },
          ],
        },
      ],
    },
  });
}

const idle = (thread: Thread) => ({
  thread: { ...thread, status: "idle" as const },
  lastAssistantText: null,
});

test("a re-run of the dispatch pass keeps the agent's acknowledgement", async () => {
  await withHost(async ({ harness, hook, view, staged, dispatchRows, acknowledge }) => {
    const thread = makeThreadResponse({ id: "thr_T", status: "active" });
    await hook(pill(thread));
    await acknowledge();
    await harness.emitThreadEvent("thread.idle", idle(thread));

    // The drain re-runs the pass for the same queued message.
    await hook(pill({ ...thread, status: "idle" }));
    assert.equal(dispatchRows(), 1);
    await harness.emitThreadEvent("thread.active", { thread });
    await harness.emitThreadEvent("thread.idle", idle(thread));
    assert.deepEqual(await view(), { status: "acknowledged", holder: "thr_T" });
    assert.deepEqual(await staged(), []);
  });
});

test("a re-run of an older message cannot take the annotation from the thread holding it", async () => {
  await withHost(async ({ harness, hook, view, staged, acknowledge }) => {
    const first = makeThreadResponse({ id: "thr_A", status: "pending" });
    await hook(pill(first));
    await harness.emitThreadEvent("thread.failed", {
      thread: { ...first, status: "error" },
      error: null,
    });
    assert.deepEqual(await staged(), ["ann_1"]);

    await hook(pill(makeThreadResponse({ id: "thr_B", status: "pending" })));
    await acknowledge();

    // Thread A's failed message is retried or re-run on restart.
    await hook(pill({ ...first, status: "error" }));
    assert.deepEqual(await view(), { status: "acknowledged", holder: "thr_B" });
  });
});

test("a queued pill's drain pass does not let the previous turn's idle re-stage it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withHost(
    async ({ harness, hook, staged }) => {
      const thread = makeThreadResponse({ id: "thr_busy", status: "active" });
      await hook(pill(thread));

      // The running turn ends; its idle handler is awaiting events.list.
      const previousTurnIdle = harness.emitThreadEvent("thread.idle", idle(thread));
      await Promise.resolve();
      await hook(pill({ ...thread, status: "idle" }));
      release();
      await previousTurnIdle;
      assert.deepEqual(await staged(), []);
    },
    {
      threads: {
        events: {
          list: async () => {
            await gate;
            return [];
          },
        },
      },
      system: { config },
    },
  );
});

test("a mention in another thread gives the context and leaves the annotation where it is", async () => {
  await withHost(async ({ harness, hook, resolve, view, dispatchRows, acknowledge }) => {
    const first = makeThreadResponse({ id: "thr_A", status: "pending" });
    await hook(pill(first));
    await acknowledge();
    await harness.emitThreadEvent("thread.idle", idle(first));
    const signals = harness.inspection.realtimeSignals.length;

    const { context } = await resolve(annotationMentionItemId("ann_1", "thr_B"));
    assert.match(context, /ann_1/u);
    // Status is read through the tools, so the context cannot contradict it.
    assert.doesNotMatch(context, /Status/u);
    assert.deepEqual(await view(), { status: "acknowledged", holder: "thr_A" });
    assert.equal(dispatchRows(), 1);
    assert.deepEqual(signalTypes(harness, signals), []);
  }, idleSdk());
});

test("a retried mention cannot take the annotation from the thread now holding it", async () => {
  await withHost(async ({ harness, resolve, view, staged, acknowledge }) => {
    // Thread A's message is refused before the provider accepts it.
    await resolve(annotationMentionItemId("ann_1", "thr_A"));
    await harness.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_A", status: "error" }),
      error: null,
    });
    assert.deepEqual(await staged(), ["ann_1"]);

    const signals = harness.inspection.realtimeSignals.length;
    await resolve(annotationMentionItemId("ann_1", "thr_B"));
    assert.deepEqual(signalTypes(harness, signals), ["annotations"]);
    await acknowledge();

    // bb retries thread A's message with its original mentions.
    await resolve(annotationMentionItemId("ann_1", "thr_A"));
    assert.deepEqual(await view(), { status: "acknowledged", holder: "thr_B" });
  }, idleSdk());
});

test("mentioning an annotation in the thread holding it keeps the acknowledgement", async () => {
  await withHost(async ({ harness, hook, resolve, view, staged, dispatchRows, acknowledge }) => {
    const thread = makeThreadResponse({ id: "thr_A", status: "pending" });
    await hook(pill(thread));
    await acknowledge();
    const signals = harness.inspection.realtimeSignals.length;

    // A follow-up in thr_A's composer, steered into the turn or after it.
    await resolve(annotationMentionItemId("ann_1", "thr_A"));
    assert.equal(dispatchRows(), 1);
    assert.equal(harness.inspection.realtimeSignals.length, signals);
    await harness.emitThreadEvent("thread.idle", idle(thread));
    assert.deepEqual(await view(), { status: "acknowledged", holder: "thr_A" });
    assert.deepEqual(await staged(), []);
  }, idleSdk("active"));
});

test("a new thread's pill for an acknowledged staged annotation starts a fresh assignment", async () => {
  await withHost(async ({ harness, hook, resolve, view, staged, acknowledge }) => {
    await acknowledge();
    // bb resolves the pill when it creates the thread, before the hook runs.
    const { context } = await resolve(annotationMentionItemId("ann_1", null));
    assert.doesNotMatch(context, /Status/u);

    const thread = makeThreadResponse({ id: "thr_new", status: "pending" });
    const signals = harness.inspection.realtimeSignals.length;
    await hook(pill(thread));
    assert.deepEqual(signalTypes(harness, signals), ["annotations"]);
    assert.deepEqual(await view(), { status: "pending", holder: "thr_new" });

    const turnEnd = harness.inspection.realtimeSignals.length;
    await harness.emitThreadEvent("thread.idle", idle(thread));
    assert.deepEqual(signalTypes(harness, turnEnd), ["routing"]);
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});

test("a chip send delivers the annotation as pending and asks the agent to acknowledge", async () => {
  await withHost(async ({ harness, view, acknowledge }) => {
    const sent: string[] = [];
    harness.sdk.stub("threads.get", () => makeThreadResponse({ id: "thr_T", status: "idle" }));
    harness.sdk.stub("threads.send", (input: { input: Array<{ text: string }> }) => {
      sent.push(input.input.map((block) => block.text).join("\n"));
      return {};
    });
    await acknowledge();

    const signals = harness.inspection.realtimeSignals.length;
    await harness.callRpc("sendStagedAnnotations", { annotationIds: ["ann_1"], threadId: "thr_T" });
    assert.deepEqual(signalTypes(harness, signals), ["annotations", "routing"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /\*\*Status:\*\* pending/u);
    assert.match(sent[0]!, /agentation_acknowledge/u);
    assert.deepEqual(await view(), { status: "pending", holder: "thr_T" });

    await acknowledge();
    const restage = harness.inspection.realtimeSignals.length;
    await harness.callRpc("restageAnnotation", { annotationId: "ann_1" });
    assert.deepEqual(signalTypes(harness, restage), ["annotations"]);
    assert.deepEqual(await view(), { status: "pending", holder: "staged" });
  }, idleSdk());
});

test("`bb agentation restage` returns an acknowledged annotation as pending", async () => {
  await withHost(async ({ harness, hook, view, acknowledge }) => {
    await hook(pill(makeThreadResponse({ id: "thr_A", status: "pending" })));
    await acknowledge();

    const signals = harness.inspection.realtimeSignals.length;
    await harness.runCli(["restage", "ann_1"]);
    assert.deepEqual(signalTypes(harness, signals), ["annotations"]);
    assert.deepEqual(await view(), { status: "pending", holder: "staged" });
  });
});

test("deleting a thread broadcasts the annotations it gave back", async () => {
  await withHost(async ({ harness, hook, view, acknowledge }) => {
    const thread = makeThreadResponse({ id: "thr_gone", status: "pending" });
    await hook(pill(thread));
    await acknowledge();

    const signals = harness.inspection.realtimeSignals.length;
    await harness.emitThreadEvent("thread.deleted", { thread });
    assert.deepEqual(signalTypes(harness, signals), ["annotations"]);
    assert.deepEqual(await view(), { status: "pending", holder: "staged" });
  });
});

/** The types of the realtime signals published since `from`. */
function signalTypes(harness: Host["harness"], from = 0) {
  return harness.inspection.realtimeSignals
    .slice(from)
    .map((signal) => (signal.payload as { type: string }).type);
}

// --- Startup recovery --------------------------------------------------------

const notFound = () =>
  Object.assign(new Error("HTTP 404: Thread not found"), {
    status: 404,
    code: "thread_not_found",
  });

/** Load the plugin over state a previous run left, with `lookup` deciding each thread. */
async function restartWith(
  prepare: (db: BetterSqlite.Database) => void,
  lookup: (threadId: string) => Promise<unknown>,
) {
  let get: (threadId: string) => Promise<unknown> = async (threadId) =>
    makeThreadResponse({ id: threadId, status: "idle" });
  const first = createFakePluginHost({
    pluginId: "agentation",
    sdk: {
      threads: { get: ({ threadId }: { threadId: string }) => get(threadId) },
      system: { config },
    } as never,
  });
  await plugin(first.bb);
  await seedAnnotations(first.harness, ["ann_1", "ann_2"]);
  prepare(first.bb.storage.database());
  get = lookup;
  const next = await first.harness.lifecycle.reload(plugin);
  await settle();
  return next;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function sendDirect(db: BetterSqlite.Database, annotationId: string, threadId: string) {
  const claim = claimStagedAnnotations(db, { annotationIds: [annotationId], threadId });
  assert.equal(claim.outcome, "claimed");
  if (claim.outcome === "claimed") {
    completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: "awaiting-finish" });
  }
}

/** Assigned, acknowledged, and its turn long over: no turn assignment left. */
function keptBy(db: BetterSqlite.Database, annotationId: string, threadId: string) {
  sendDirect(db, annotationId, threadId);
  setAnnotationStatus(db, { annotationId, status: "acknowledged", by: "agent" });
  db.prepare(`DELETE FROM annotation_turn_assignments WHERE annotation_id = ?`).run(annotationId);
}

function recoveryLogs(host: Host) {
  return host.harness.inspection.logEntries
    .map((entry) => entry.message)
    .filter((message) => /re-staged|kept/u.test(message));
}

test("recovery gives back a deleted thread's acknowledged annotation and keeps a live one", async () => {
  const host = await restartWith(
    (db) => {
      keptBy(db, "ann_1", "thr_gone");
      keptBy(db, "ann_2", "thr_live");
    },
    async (threadId) => {
      if (threadId === "thr_gone") throw notFound();
      return makeThreadResponse({ id: threadId, status: "idle" });
    },
  );
  try {
    const { view } = inspect(host);
    assert.deepEqual(await view("ann_1"), { status: "pending", holder: "staged" });
    assert.deepEqual(await view("ann_2"), { status: "acknowledged", holder: "thr_live" });
    assert.deepEqual(recoveryLogs(host), [
      "re-staged 1 annotation assigned to threads deleted while Agentation was stopped",
    ]);
    assert.deepEqual(signalTypes(host.harness), ["annotations"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recovery reads either a thread_not_found code or a 404 as a deleted thread", async () => {
  const host = await restartWith(
    (db) => {
      keptBy(db, "ann_1", "thr_coded");
      keptBy(db, "ann_2", "thr_404");
    },
    async (threadId) => {
      throw threadId === "thr_coded"
        ? Object.assign(new Error("thread not found"), { code: "thread_not_found" })
        : Object.assign(new Error("HTTP 404"), { status: 404 });
    },
  );
  try {
    const { view } = inspect(host);
    assert.deepEqual(await view("ann_1"), { status: "pending", holder: "staged" });
    assert.deepEqual(await view("ann_2"), { status: "pending", holder: "staged" });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recovery moves nothing acknowledged when a lookup fails for another reason", async () => {
  const host = await restartWith(
    (db) => keptBy(db, "ann_1", "thr_flaky"),
    async () => {
      throw Object.assign(new Error("HTTP 502: bad gateway"), { status: 502 });
    },
  );
  try {
    assert.deepEqual(await inspect(host).view(), { status: "acknowledged", holder: "thr_flaky" });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recovery counts only threads with a kept turn as still active", async () => {
  const host = await restartWith(
    (db) => keptBy(db, "ann_1", "thr_working"),
    async (threadId) => makeThreadResponse({ id: threadId, status: "active" }),
  );
  try {
    assert.deepEqual(recoveryLogs(host), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recovery does not re-stage an annotation sent while it read thread states", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = false;
  const first = createFakePluginHost({
    pluginId: "agentation",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const snapshot = makeThreadResponse({ id: threadId, status: "idle" });
          if (gated) await gate;
          return snapshot;
        },
      },
      system: { config },
    } as never,
  });
  await plugin(first.bb);
  await seedAnnotations(first.harness, ["ann_1", "ann_2"]);
  keptBy(first.bb.storage.database(), "ann_1", "thr_T");
  gated = true;
  const next = await first.harness.lifecycle.reload(plugin);
  try {
    const { hook, view } = inspect(next);
    // Recovery waits on thr_T, which holds ann_1. ann_2 is sent there meanwhile.
    await hook(pill(makeThreadResponse({ id: "thr_T", status: "idle" }), "ann_2"));
    release();
    await settle();
    assert.deepEqual(await view("ann_2"), { status: "pending", holder: "thr_T" });
  } finally {
    await next.harness.lifecycle.dispose();
  }
});
