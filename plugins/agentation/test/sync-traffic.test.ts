// What each open toolbar and review surface costs while nothing changes: an
// unchanged pull carries no annotation list, the event stream's heartbeat is a
// frame the page can see, and surfaces hearing one broadcast share a request.

import assert from "node:assert/strict";
import test from "node:test";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import BetterSqlite from "better-sqlite3";

import { sharedRequest } from "../lib/shared-request.ts";
import plugin from "../server.ts";

// The fake host's `storage.database()` sets a pragma through better-sqlite3's
// API, which the shared bun:sqlite stand-in does not provide.
const sqlite = BetterSqlite.prototype as { pragma?: (source: string) => unknown };
sqlite.pragma ??= function (this: { query(sql: string): { all(): unknown } }, source: string) {
  return this.query(`PRAGMA ${source}`).all();
};

async function loaded() {
  const { bb, harness } = createFakePluginHost({ pluginId: "agentation" });
  await plugin(bb);
  const { session, cursor } = (await harness.callRpc("openSession", {
    url: "https://bb.example.test/threads/thr_1",
    route: "/threads/thr_1",
    title: null,
    threadId: "thr_1",
    projectId: null,
  })) as { session: { id: string }; cursor: number };
  return { harness, sessionId: session.id, cursor };
}

test("a pull that finds nothing new carries no annotation list", async () => {
  const { harness, sessionId, cursor } = await loaded();
  try {
    await harness.callRpc("pushAnnotations", {
      sessionId,
      deletedIds: [],
      upserts: [
        {
          annotation: {
            id: "ann_1",
            comment: "The header wraps",
            elementPath: "header",
            timestamp: 1,
            x: 1,
            y: 1,
            element: "header",
          },
          bb: {
            route: "/threads/thr_1",
            pluginId: null,
            surface: null,
            threadId: "thr_1",
            projectId: null,
            routeLabel: null,
          },
        },
      ],
    });
    const changed = (await harness.callRpc("pullSession", { sessionId, cursor })) as {
      cursor: number;
      changed: boolean;
      annotations?: unknown[];
    };
    assert.equal(changed.changed, true);
    assert.equal(changed.annotations?.length, 1);

    const unchanged = await harness.callRpc("pullSession", { sessionId, cursor: changed.cursor });
    assert.deepEqual(unchanged, {
      cursor: changed.cursor,
      changed: false,
      config: { toolbarEnabled: true },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the event stream greets with a retry hint and stays an uncompressed event stream", async () => {
  const { harness } = await loaded();
  try {
    const response = await harness.behavior.fetchHttp("GET", "/events");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const hello = new TextDecoder().decode(value);
    assert.match(hello, /^retry: \d+\nevent: hello\ndata: \{"cursor":\d+\}\n\n$/);
    await reader.cancel();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("callers in one tick share a request, and a caller during it gets one follow-up", async () => {
  let started = 0;
  let release!: () => void;
  const load = () => {
    started += 1;
    return new Promise<number>((resolve) => {
      release = () => resolve(started);
    });
  };
  const first = [sharedRequest("probe", load), sharedRequest("probe", load)];
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 1);

  // Heard about a change while the first answer was still out.
  const late = [sharedRequest("probe", load), sharedRequest("probe", load)];
  release();
  assert.deepEqual(await Promise.all(first), [1, 1]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 2);
  release();
  assert.deepEqual(await Promise.all(late), [2, 2]);
});
