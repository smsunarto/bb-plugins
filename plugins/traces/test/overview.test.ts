import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server/server.ts";

function host(id: string, phase: string) {
  return { id, name: id, status: "connected", lifecycle: { phase } };
}

async function overviewFor(environmentHostId: string) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "traces",
    sdk: {
      hosts: {
        list: async () => [
          host("host_live", "active"),
          host("host_removing", "removing"),
          host("host_gone", "destroyed"),
        ],
      },
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thr_1", environmentId: "env_1", providerId: "claude" }),
        events: { list: async () => [] },
      },
      environments: { get: async () => ({ hostId: environmentHostId }) },
    },
  });
  await plugin(bb);
  const result = await harness.callRpc("overview", { threadId: "thr_1" });
  await harness.lifecycle.dispose();
  return result;
}

test("a thread on a removed machine falls back to the listed machines", async () => {
  for (const hostId of ["host_removing", "host_gone", "host_unlisted"]) {
    assert.deepEqual(await overviewFor(hostId), {
      hosts: [{ id: "host_live", name: "host_live", online: true }],
      context: null,
    });
  }
});

test("a thread on a live machine keeps its trace context", async () => {
  assert.deepEqual(await overviewFor("host_live"), {
    hosts: [{ id: "host_live", name: "host_live", online: true }],
    context: {
      hostId: "host_live",
      provider: "claude-code",
      nativeId: null,
      title: "Untitled thread",
    },
  });
});
