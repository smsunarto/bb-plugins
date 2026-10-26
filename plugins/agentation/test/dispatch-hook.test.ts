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
  return { harness, hook, staged };
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
  await withStagedAnnotation(async ({ harness, hook, staged }) => {
    assert.deepEqual(await staged(), ["ann_1"]);
    const thread = makeThreadResponse({ id: "thr_new", status: "pending" });

    assert.deepEqual(await hook(dispatch(thread, "start-turn")), { action: "proceed" });
    assert.deepEqual(await staged(), []);
    // A drain or retry of the same message finds nothing left to claim.
    assert.deepEqual(await hook(dispatch(thread, "start-turn")), { action: "proceed" });

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
