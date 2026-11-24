// A pill from the new-thread composer names no thread; the dispatch that
// creates the thread assigns it and re-stages it when that turn ends.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import BetterSqlite from "better-sqlite3";

import plugin from "../server.ts";

// The fake host's `storage.database()` sets a pragma through better-sqlite3's
// API, which the shared bun:sqlite stand-in does not provide.
const sqlite = BetterSqlite.prototype as { pragma?: (source: string) => unknown };
sqlite.pragma ??= function (this: { query(sql: string): { all(): unknown } }, source: string) {
  return this.query(`PRAGMA ${source}`).all();
};

async function withStagedAnnotation(
  run: (host: Awaited<ReturnType<typeof loaded>>) => Promise<void>,
) {
  const host = await loaded();
  try {
    await run(host);
  } finally {
    await host.harness.lifecycle.dispose();
  }
}

async function loaded() {
  const { bb, harness } = createFakePluginHost({ pluginId: "agentation" });
  await plugin(bb);
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
    upserts: [
      {
        annotation: {
          id: "ann_1",
          comment: "Save is misaligned",
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
      },
    ],
  });
  const hook = harness.inspection.registrations.hooks["message.dispatch"];
  assert.ok(hook);
  const staged = async () =>
    (
      (await harness.callRpc("listStagedAnnotations", null)) as { annotations: { id: string }[] }
    ).annotations.map((annotation) => annotation.id);
  const db = bb.storage.database();
  const dispatchRows = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM annotation_dispatches`).get() as { n: number }).n;
  return { harness, hook, staged, dispatchRows };
}

function dispatch(
  thread: ReturnType<typeof makeThreadResponse>,
  attempt: "start-turn" | "join-turn",
) {
  return makeMessageDispatchHookContext({
    thread,
    attempt,
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
                itemId: "annotation:ann_1",
                label: "pill",
              },
            },
          ],
        },
      ],
    },
  });
}

test("a new thread's first dispatch assigns the pill until its turn ends", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged, dispatchRows }) => {
    assert.deepEqual(await staged(), ["ann_1"]);
    const thread = makeThreadResponse({ id: "thr_new", status: "pending" });

    assert.deepEqual(await hook(dispatch(thread, "start-turn")), { action: "proceed" });
    assert.deepEqual(await staged(), []);
    // A drain or retry of the same message finds nothing left to claim: no
    // new dispatch row and no broadcast.
    const signals = harness.inspection.realtimeSignals.length;
    for (let pass = 0; pass < 4; pass += 1) {
      assert.deepEqual(await hook(dispatch(thread, "start-turn")), { action: "proceed" });
    }
    assert.equal(dispatchRows(), 1);
    assert.equal(harness.inspection.realtimeSignals.length, signals);

    await harness.emitThreadEvent("thread.idle", {
      thread: { ...thread, status: "idle" },
      lastAssistantText: null,
    });
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});

test("a pill queued behind a running turn waits for its own turn", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    const thread = makeThreadResponse({ id: "thr_busy", status: "active" });
    await hook(dispatch(thread, "start-turn"));
    assert.deepEqual(await staged(), []);

    const idle = { thread: { ...thread, status: "idle" as const }, lastAssistantText: null };
    await harness.emitThreadEvent("thread.idle", idle);
    assert.deepEqual(await staged(), []);

    await harness.emitThreadEvent("thread.active", { thread });
    await harness.emitThreadEvent("thread.idle", idle);
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});

test("a turn bb interrupts to restart keeps its pill until the resumed turn ends", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    let latest: { type: string; data: Record<string, unknown> } = {
      type: "system/thread/interrupted",
      data: { reason: "host-daemon-restarted" },
    };
    harness.sdk.stub("threads.events.list", () => [latest]);
    harness.sdk.stub("system.config", () => ({
      generalSettings: { steerActiveThreadOnEnter: true, resumeThreadsAfterRestart: true },
      experiments: {},
    }));
    const thread = makeThreadResponse({ id: "thr_restart", status: "pending" });
    await hook(dispatch(thread, "start-turn"));
    const idle = { thread: { ...thread, status: "idle" as const }, lastAssistantText: null };

    await harness.emitThreadEvent("thread.idle", idle);
    await harness.emitThreadEvent("thread.failed", { thread: idle.thread, error: null });
    assert.deepEqual(await staged(), []);

    latest = { type: "turn/completed", data: { status: "completed" } };
    await harness.emitThreadEvent("thread.active", { thread });
    await harness.emitThreadEvent("thread.idle", idle);
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});

test("an interrupted turn re-stages its pill when bb will not resume it", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    harness.sdk.stub("threads.events.list", () => [
      { type: "system/thread/interrupted", data: { reason: "host-daemon-restarted" } },
    ]);
    harness.sdk.stub("system.config", () => ({
      generalSettings: { steerActiveThreadOnEnter: true, resumeThreadsAfterRestart: false },
      experiments: {},
    }));
    const thread = makeThreadResponse({ id: "thr_no_resume", status: "pending" });
    await hook(dispatch(thread, "start-turn"));

    await harness.emitThreadEvent("thread.idle", {
      thread: { ...thread, status: "idle" },
      lastAssistantText: null,
    });
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});

test("a pill the agent acknowledged stays assigned after its turn ends", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    const thread = makeThreadResponse({ id: "thr_acked", status: "pending" });
    await hook(dispatch(thread, "start-turn"));
    await harness.callAgentTool("agentation_acknowledge", { annotationId: "ann_1" });

    await harness.emitThreadEvent("thread.idle", {
      thread: { ...thread, status: "idle" },
      lastAssistantText: null,
    });
    assert.deepEqual(await staged(), []);
  });
});

test("a pill acknowledged before it was sent reappears when its queued turn fails", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    await harness.callAgentTool("agentation_acknowledge", { annotationId: "ann_1" });
    const thread = makeThreadResponse({ id: "thr_busy", status: "active" });
    await hook(dispatch(thread, "start-turn"));
    assert.deepEqual(await staged(), []);

    await harness.emitThreadEvent("thread.failed", {
      thread: { ...thread, status: "idle" },
      error: null,
    });
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});

test("deleting the thread gives back a pill its agent acknowledged", async () => {
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    const thread = makeThreadResponse({ id: "thr_gone", status: "pending" });
    await hook(dispatch(thread, "start-turn"));
    await harness.callAgentTool("agentation_acknowledge", { annotationId: "ann_1" });
    await harness.emitThreadEvent("thread.idle", {
      thread: { ...thread, status: "idle" },
      lastAssistantText: null,
    });
    assert.deepEqual(await staged(), []);

    await harness.emitThreadEvent("thread.deleted", { thread });
    assert.deepEqual(await staged(), ["ann_1"]);
  });
});
