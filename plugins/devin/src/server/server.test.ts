import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";

const configuration = (
  threadId: string,
  providerId = "devin",
): PluginAgentConfigurationContext => ({
  pluginMetadata: {},
  thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
  project: {
    id: "proj_1",
    kind: "standard",
    name: "bb-plugins",
    gitRemoteUrl: "https://github.com/smsunarto/bb-plugins",
  },
  environment: {
    id: "env_1",
    name: null,
    path: "/Users/me/git/bb-plugins",
    branchName: "scott/devin-plugin",
    workspaceProvisionType: null,
  },
  host: { id: "host_1", name: "laptop" },
  provider: {
    id: providerId,
    model: "swe-2-high",
    capabilities: { supportsNativeUserQuestion: false },
  },
  origin: { kind: null, pluginId: null },
});

async function loaded() {
  const host = createFakePluginHost({ pluginId: "devin" });
  await plugin(host.bb);
  const [provider] = host.harness.inspection.registrations.providerRegistrations;
  assert.ok(provider);
  const derive = (threadId: string) =>
    provider.deriveProviderOptions?.({
      threadId,
      projectId: "proj_1",
      model: "swe-2-high",
      permissionMode: "accept-edits",
      settings: {},
    });
  return { ...host, provider, derive };
}

test("Devin registers as an ACP provider that launches the local agent", async () => {
  const { provider } = await loaded();
  assert.equal(provider.id, "devin");
  assert.deepEqual(provider.experimental_bridgeOptions, {
    acpLaunchSpec: { displayName: "Devin", command: "devin", args: ["acp"], env: {} },
  });
});

test("the Cloud toggle launches the next thread on Devin Cloud, and only that one", async () => {
  const { harness, derive } = await loaded();
  assert.deepEqual(await harness.callRpc("setCloudIntent", { armed: true }), { armed: true });
  assert.deepEqual(await harness.callRpc("cloudIntent"), { armed: true });

  const cloud = {
    acpLaunchSpec: {
      displayName: "Devin Cloud",
      command: "devin",
      args: ["acp", "--cloud"],
      env: {},
    },
  };
  assert.deepEqual(derive("thr_cloud"), cloud);
  assert.deepEqual(derive("thr_cloud"), cloud);
  assert.deepEqual(await harness.callRpc("cloudIntent"), { armed: false });
  assert.deepEqual(derive("thr_local"), {});
});

test("the Cloud banner shows the session once the bridge reports it", async () => {
  const { harness, derive } = await loaded();
  await harness.callRpc("setCloudIntent", { armed: true });
  derive("thr_cloud");
  derive("thr_local");
  const events: unknown[] = [];
  harness.sdk.stub("threads.get", () => ({ providerId: "devin" }));
  harness.sdk.stub("threads.events.list", () => events);

  assert.deepEqual(await harness.callRpc("cloudSession", { threadId: "thr_local" }), {
    state: "hidden",
  });
  assert.deepEqual(await harness.callRpc("cloudSession", { threadId: "thr_cloud" }), {
    state: "starting",
  });
  events.push({
    type: "thread/identity",
    data: { providerThreadId: "devin-118de5960fdb40e0a6f497b55554e7ce" },
  });
  assert.deepEqual(await harness.callRpc("cloudSession", { threadId: "thr_cloud" }), {
    state: "active",
    sessionId: "devin-118de5960fdb40e0a6f497b55554e7ce",
    url: "https://app.devin.ai/sessions/118de5960fdb40e0a6f497b55554e7ce",
    attachCommand: "devin --cloud -r devin-118de5960fdb40e0a6f497b55554e7ce",
  });
});

test("a Cloud thread opens with the project's repository, a local thread with nothing", async () => {
  const { harness, derive } = await loaded();
  const empty = { tools: [], skills: [], instructions: null };
  await harness.callRpc("setCloudIntent", { armed: true });

  // Another provider's thread neither consumes the armed toggle nor gets the note.
  assert.deepEqual(
    await harness.resolveAgentConfiguration(configuration("thr_other", "codex")),
    empty,
  );
  assert.deepEqual(await harness.callRpc("cloudIntent"), { armed: true });

  // Resolving the configuration pins the thread, so the launch that follows agrees with it.
  assert.deepEqual(await harness.resolveAgentConfiguration(configuration("thr_cloud")), {
    ...empty,
    instructions:
      "Repository: https://github.com/smsunarto/bb-plugins. Work there; clone it first if it is not on this machine.",
  });
  assert.deepEqual(derive("thr_cloud")?.acpLaunchSpec, {
    displayName: "Devin Cloud",
    command: "devin",
    args: ["acp", "--cloud"],
    env: {},
  });
  assert.deepEqual(await harness.resolveAgentConfiguration(configuration("thr_local")), empty);
});
