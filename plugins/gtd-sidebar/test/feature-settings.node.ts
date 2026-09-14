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
      for (const key of [
        "compactThreads",
        "showProviderIcon",
        "mobileHaptics",
        "gitButlerBranches",
        "automaticallyNameThreads",
      ]) {
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
