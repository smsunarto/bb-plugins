// What an agent reads about where an annotated plugin's source lives. bb loads
// a `path:` plugin from the server's own disk, and the agent reading the
// annotation may run on another machine where that path does not exist.

import assert from "node:assert/strict";
import test from "node:test";

import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import BetterSqlite from "better-sqlite3";

import plugin from "../server.ts";

// The fake host's `storage.database()` sets a pragma through better-sqlite3's
// API, which the shared bun:sqlite stand-in does not provide.
const sqlite = BetterSqlite.prototype as { pragma?: (source: string) => unknown };
sqlite.pragma ??= function (this: { query(sql: string): { all(): unknown } }, source: string) {
  return this.query(`PRAGMA ${source}`).all();
};

const SERVER_HOST = makeHostResponse({ id: "host_cardinal", name: "codex@cardinal" });
const SOURCE = "path:/home/codex/git/bb-plugins/plugins/kitchen-sink";

async function annotateKitchenSink(clientContext: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "agentation",
    sdk: {
      plugins: {
        list: async () =>
          ({ plugins: [{ id: "kitchen-sink", provenance: "direct", source: SOURCE }] }) as never,
      },
      system: { config: async () => ({ primaryHostId: SERVER_HOST.id }) as never },
      hosts: {
        get: async ({ hostId }: { hostId: string }) =>
          hostId === SERVER_HOST.id ? SERVER_HOST : Promise.reject(new Error("unknown host")),
      },
    },
  });
  await plugin(bb);
  const { session } = (await harness.callRpc("openSession", {
    url: "https://scott.getbb.app/threads/thr_1",
    route: "/threads/thr_1",
    title: null,
    threadId: "thr_1",
    projectId: null,
  })) as { session: { id: string } };
  await harness.callRpc("pushAnnotations", {
    sessionId: session.id,
    deletedIds: [],
    upserts: [
      {
        annotation: {
          id: "ann_1",
          comment: "The citation header wraps",
          elementPath: "figure.smart-embed",
          timestamp: 1,
          x: 1,
          y: 1,
          element: "figure",
        },
        bb: {
          route: "/threads/thr_1",
          pluginId: "kitchen-sink",
          surface: null,
          threadId: "thr_1",
          projectId: null,
          routeLabel: null,
          ...clientContext,
        },
      },
    ],
  });
  const text = String(await harness.callAgentTool("agentation_get_all_pending", {}));
  await harness.lifecycle.dispose();
  return text.split("\n").find((line) => line.startsWith("**Plugin source:**"));
}

test("a path source names the bb server's machine it lives on", async () => {
  assert.equal(
    await annotateKitchenSink(),
    "**Plugin source:** installed from `path:/home/codex/git/bb-plugins/plugins/kitchen-sink`, a directory on the bb server's machine (`codex@cardinal`). bb runs the plugin from that copy. If you work in another checkout or on another machine, the change reaches the running plugin only after it lands in that directory and `bb plugin reload kitchen-sink` runs.",
  );
});

test("the browser cannot claim a different machine for the source", async () => {
  const line = await annotateKitchenSink({ pluginSourceHost: "Personal Mac" });
  assert.match(line ?? "", /\(`codex@cardinal`\)/);
  assert.doesNotMatch(line ?? "", /Personal Mac/);
});
