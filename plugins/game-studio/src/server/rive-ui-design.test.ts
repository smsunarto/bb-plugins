import { expect, test } from "bun:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("Game Studio exposes the Rive UI design skill to agents", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    agentSkillIds: ["game-studio", "unity-editors", "assemble-unity-scene", "rive-ui-design"],
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  try {
    await plugin(bb);
    const configuration = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    expect(configuration.skills).toContain("rive-ui-design");
  } finally {
    await harness.lifecycle.dispose();
  }
});
