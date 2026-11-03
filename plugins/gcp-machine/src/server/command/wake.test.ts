import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { wakeSnapshotSchema, wakeStateSchema } from "../../shared/wake-contract.ts";
import { Store } from "../lib/store.ts";
import plugin from "../server.ts";

test("wake explains that provider enrollment is required", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gcp-machine" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const result = await harness.behavior.runCli(["wake"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Enroll the configured VM/);
  assert.equal(harness.inspection.sdk.callsTo("hosts.experimental_resume").length, 0);
});

test("manual wake RPC responds immediately and lost job reads are explicit", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gcp-machine" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const started = wakeSnapshotSchema.parse(
    await harness.behavior.callRpc("startWake", { requestId: "click", requestedAt: Date.now() }),
  );
  assert.equal(typeof started.jobId, "string");
  assert.equal(started.state.kind, "waking");
  const lost = wakeStateSchema.parse(await harness.behavior.callRpc("getWake", { jobId: "lost" }));
  assert.equal(lost.kind, "unknown");
  await assert.rejects(harness.behavior.callRpc("getWake", { jobId: 2 }));
});

test("accepted wake click receipts survive a plugin reload", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gcp-machine" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const input = { requestId: "lost-click", requestedAt: Date.now() };
  await harness.behavior.callRpc("startWake", input);
  await harness.lifecycle.reload(plugin);
  const replay = wakeSnapshotSchema.parse(await harness.behavior.callRpc("startWake", input));
  assert.ok(replay.state.kind === "unknown" || replay.state.kind === "failed");
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("footer indicator follows the bound BB host without any cloud call", async (t) => {
  const host = makeHostResponse({ id: "vm", status: "connected" });
  const { bb, harness } = createFakePluginHost({
    pluginId: "gcp-machine",
    sdk: { hosts: { get: async () => host } },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const store = new Store(bb);
  store.reserve({
    key: "binding",
    project: "test-project",
    zone: "us-west1-a",
    instance: "vm",
    instanceId: "1",
    controllerHostId: "controller",
    access: { gcloudPath: "gcloud", account: "", sshUser: "test" },
  });
  store.attach("binding", "vm");
  assert.equal(await harness.behavior.callRpc("getIndicator", null), "awake");
  host.status = "disconnected";
  host.lifecycle.phase = "resuming";
  assert.equal(await harness.behavior.callRpc("getIndicator", null), "waking");
  host.lifecycle.phase = "suspended";
  assert.equal(await harness.behavior.callRpc("getIndicator", null), "offline");
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("an active wake remains yellow when a later host-status read fails", async (t) => {
  let reads = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "gcp-machine",
    sdk: {
      hosts: {
        get: async () => {
          if (++reads === 1) return new Promise<ReturnType<typeof makeHostResponse>>(() => {});
          throw new Error("host lookup temporarily unavailable");
        },
      },
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const store = new Store(bb);
  store.reserve({
    key: "binding",
    project: "test-project",
    zone: "us-west1-a",
    instance: "vm",
    instanceId: "1",
    controllerHostId: "controller",
    access: { gcloudPath: "gcloud", account: "", sshUser: "test" },
  });
  store.attach("binding", "vm");
  await harness.behavior.callRpc("startWake", { requestId: "wake", requestedAt: Date.now() });
  assert.equal(await harness.behavior.callRpc("getIndicator", null), "waking");
});
