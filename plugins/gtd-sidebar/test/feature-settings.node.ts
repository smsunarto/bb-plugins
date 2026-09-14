import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { INITIATIVE_TOOL_NAMES } from "../lib/initiative-types.ts";

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
  test("new installs block Projects RPCs, agent tools and host branch reads", async () => {
    const { harness } = await setup();
    try {
      const descriptors = harness.inspection.registrations.settingsDescriptors;
      for (const key of [
        "compactThreads",
        "showProviderIcon",
        "mobileHaptics",
        "gitButlerBranches",
        "automaticallyNameThreads",
        "projectsEnabled",
        "subscriptionsEnabled",
      ]) {
        assert.equal(descriptors[key]?.default, false, key);
      }
      await assert.rejects(
        harness.behavior.callRpc("createInitiative", {
          name: "Optional",
          workspaceProjectIds: [],
        }),
        /Enable Projects coordination/,
      );
      assert.deepEqual(
        await harness.behavior.callRpc("listEnvironmentBranches", { environmentIds: ["env_1"] }),
        { environments: [] },
      );
      await assert.rejects(
        harness.behavior.callAgentTool(INITIATIVE_TOOL_NAMES.contextList, {}),
        /Enable Projects coordination/,
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

  test("settings changes gate existing handlers immediately and survive reload", async () => {
    let { harness } = await setup({
      projectsEnabled: true,
      automaticallyNameThreads: true,
      showProviderIcon: true,
    });
    const subscriptionService = harness.behavior.runService("initiative-subscriptions");
    let subscriptionServiceStopped = false;
    try {
      assert.deepEqual(await harness.behavior.callRpc("listInitiatives", {}), { initiatives: [] });
      await assert.rejects(
        harness.behavior.callRpc("runSubscriptionNow", { subscriptionId: "sub_missing" }),
        /Enable Project subscriptions/,
      );
      await harness.behavior.setSettings({ subscriptionsEnabled: true });
      await assert.rejects(
        harness.behavior.callRpc("runSubscriptionNow", { subscriptionId: "sub_missing" }),
        /subscription sub_missing not found/,
      );
      await assert.rejects(
        harness.behavior.callRpc("deleteSubscription", { subscriptionId: "sub_missing" }),
        /subscription sub_missing not found/,
      );
      await harness.behavior.setSettings({ projectsEnabled: false });
      await assert.rejects(
        harness.behavior.callRpc("listInitiatives", {}),
        /Enable Projects coordination/,
      );
      subscriptionService.controller.abort();
      await subscriptionService.done;
      subscriptionServiceStopped = true;
      ({ harness } = await harness.lifecycle.reload(plugin));
      await assert.rejects(
        harness.behavior.callRpc("listInitiatives", {}),
        /Enable Projects coordination/,
      );
      await harness.behavior.setSettings({ projectsEnabled: true });
      assert.deepEqual(await harness.behavior.callRpc("listInitiatives", {}), { initiatives: [] });
    } finally {
      if (!subscriptionServiceStopped) {
        subscriptionService.controller.abort();
        await subscriptionService.done;
      }
      await harness.lifecycle.dispose();
    }
  });
});
