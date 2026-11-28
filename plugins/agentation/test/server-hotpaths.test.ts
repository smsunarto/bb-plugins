// Hot server paths that run for every thread turn and every toolbar poll must
// not reach bb or kv when nothing in Agentation's own store needs them.

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

type Thread = ReturnType<typeof makeThreadResponse>;

function countingSdk() {
  const calls = { eventsList: 0, systemConfig: 0 };
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      events: {
        list: async () => {
          calls.eventsList++;
          return [];
        },
      },
    },
    system: {
      config: async () => {
        calls.systemConfig++;
        return { experiments: {}, generalSettings: { steerActiveThreadOnEnter: false } };
      },
    },
  };
  return { calls, sdk };
}

async function openSession(harness: ReturnType<typeof createFakePluginHost>["harness"]) {
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
          comment: "Feedback",
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
  return session.id;
}

function pill(thread: Thread) {
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

const idle = (thread: Thread) => ({
  thread: { ...thread, status: "idle" as const },
  lastAssistantText: null,
});

test("a turn ending on a thread with no annotations makes no bb calls", async () => {
  const { calls, sdk } = countingSdk();
  const host = createFakePluginHost({ pluginId: "agentation", sdk: sdk as never });
  await plugin(host.bb);
  try {
    await openSession(host.harness);
    const thread = makeThreadResponse({ id: "thr_empty", status: "idle" });
    for (let turn = 0; turn < 5; turn++) {
      await host.harness.emitThreadEvent("thread.idle", idle(thread));
      await host.harness.emitThreadEvent("thread.failed", {
        thread: { ...thread, status: "error" },
        error: null,
      });
    }
    assert.deepEqual(calls, { eventsList: 0, systemConfig: 0 });
    assert.equal(
      host.harness.inspection.logEntries.some((entry) => /while bb resumes/u.test(entry.message)),
      false,
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a turn ending on a thread holding an annotation still checks for a resume", async () => {
  const { calls, sdk } = countingSdk();
  const host = createFakePluginHost({ pluginId: "agentation", sdk: sdk as never });
  await plugin(host.bb);
  try {
    await openSession(host.harness);
    const hook = host.harness.inspection.registrations.hooks["message.dispatch"];
    assert.ok(hook);
    const thread = makeThreadResponse({ id: "thr_held", status: "pending" });
    await hook(pill(thread));
    await host.harness.emitThreadEvent("thread.idle", idle(thread));
    assert.equal(calls.eventsList, 1);
    const staged = (await host.harness.callRpc("listStagedAnnotations", null)) as {
      annotations: { id: string }[];
    };
    assert.deepEqual(
      staged.annotations.map((annotation) => annotation.id),
      ["ann_1"],
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("toolbar polls read the toolbar flag from kv at most once", async () => {
  const { sdk } = countingSdk();
  const host = createFakePluginHost({ pluginId: "agentation", sdk: sdk as never });
  const kv = host.bb.storage.kv;
  const get = kv.get.bind(kv);
  let toolbarReads = 0;
  kv.get = (async (key: string) => {
    if (key === "toolbar-enabled") toolbarReads++;
    return get(key);
  }) as typeof kv.get;
  await plugin(host.bb);
  try {
    const sessionId = await openSession(host.harness);
    type Pull = { config: { toolbarEnabled: boolean } };
    const pull = () =>
      host.harness.callRpc("pullSession", { sessionId, cursor: 0 }) as Promise<Pull>;

    await Promise.all([pull(), pull(), pull()]);
    for (let poll = 0; poll < 10; poll++) {
      assert.equal((await pull()).config.toolbarEnabled, true);
    }
    assert.equal(toolbarReads, 1);

    await host.harness.callRpc("setToolbarEnabled", { enabled: false });
    assert.equal((await pull()).config.toolbarEnabled, false);
    assert.equal(await get<boolean>("toolbar-enabled"), false);
    assert.equal(toolbarReads, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
