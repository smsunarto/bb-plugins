import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

async function setup(settings: Record<string, boolean> = {}) {
  const host = createFakePluginHost({
    pluginId: "gtd-sidebar",
    settings,
    sdk: { subscribe: () => () => {} },
  });
  await plugin(host.bb);
  return host;
}

describe("public feature opt-ins", () => {
  test("new installs keep optional enhancements off and host branch reads disabled", async () => {
    const { harness } = await setup();
    try {
      const descriptors = harness.inspection.registrations.settingsDescriptors;
      assert.equal(descriptors.groupThreadsByProject?.default, true);
      for (const key of ["mobileHaptics", "gitButlerBranches", "automaticallyNameThreads"]) {
        assert.equal(descriptors[key]?.default, false, key);
      }
      assert.deepEqual(
        await harness.behavior.callRpc("listEnvironmentBranches", { environmentIds: ["env_1"] }),
        { environments: [] },
      );
      const config = await harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext(),
      );
      assert.deepEqual(config.tools, []);
      assert.equal(harness.inspection.sdk.callsTo("environments.get").length, 0);
      assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  test("saved Projects opt-ins cannot restore the removed feature after reload", async () => {
    let { harness } = await setup({ projectsEnabled: true, subscriptionsEnabled: true });
    try {
      for (let reload = 0; reload < 2; reload++) {
        const registrations = harness.inspection.registrations;
        for (const key of ["projectsEnabled", "subscriptionsEnabled", "slackBotToken"]) {
          assert.equal(registrations.settingsDescriptors[key], undefined);
        }
        assert.deepEqual(registrations.agentTools, []);
        assert.equal(registrations.rpcMethods.includes("listInitiatives"), false);
        assert.equal(registrations.rpcMethods.includes("createInitiative"), false);
        assert.equal(registrations.rpcMethods.includes("runSubscriptionNow"), false);
        assert.equal(
          registrations.services.some((service) => service.name === "initiative-subscriptions"),
          false,
        );
        const config = await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext(),
        );
        assert.deepEqual(config.tools, []);
        if (reload === 0) ({ harness } = await harness.lifecycle.reload(plugin));
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("GitButler branch labels", () => {
  test("ask only connected machines, each bounded so one stalled machine cannot hold the rest", async () => {
    const calls: unknown[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      settings: { gitButlerBranches: true },
      sdk: {
        subscribe: () => () => {},
        hosts: {
          list: async () => [
            { id: "host_mac", status: "connected" },
            { id: "host_asleep", status: "disconnected" },
          ],
        },
        environments: {
          get: async ({ environmentId }: { environmentId: string }) => ({
            id: environmentId,
            hostId: environmentId === "env_mac" ? "host_mac" : "host_asleep",
            path: `/work/${environmentId}`,
            isGitRepo: true,
            isWorktree: false,
          }),
        },
      } as never,
    });
    // The fake host client drops call options, so record them here.
    const hosts = {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: unknown) => {
          calls.push({ method, input, options });
          return { label: "scott/foo" };
        },
      }),
    };
    await plugin(
      new Proxy(bb, { get: (target, key) => (key === "hosts" ? hosts : Reflect.get(target, key)) }),
    );
    try {
      assert.deepEqual(
        await harness.behavior.callRpc("listEnvironmentBranches", {
          environmentIds: ["env_mac", "env_asleep"],
        }),
        { environments: [{ environmentId: "env_mac", label: "scott/foo" }] },
      );
      assert.deepEqual(calls, [
        {
          method: "branchSummary",
          input: { cwd: "/work/env_mac" },
          options: { hostId: "host_mac", timeoutMs: 8_000 },
        },
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
