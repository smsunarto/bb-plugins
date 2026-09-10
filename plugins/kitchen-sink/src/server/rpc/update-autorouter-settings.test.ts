import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { readAutorouterSettings } from "../lib/autorouter/settings.ts";

test("the settings editor preserves existing fields and persists model guidance across reload", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  await harness.callRpc("updateAutorouterSettings", {
    values: {
      autorouterEnabled: true,
      autorouterRule_astra_medium: "Use for bounded feature work.",
      autorouterModel_fable: false,
    },
  });
  const reloaded = await harness.reload(plugin);
  const settings = await readAutorouterSettings(reloaded.bb);
  expect(settings.enabled).toBe(true);
  expect(settings.projectRouting).toBe(true);
  expect(settings.rules.find((rule) => rule.route === "astra/medium")?.prompt).toBe(
    "Use for bounded feature work.",
  );
  expect(settings.enabledRoutes.has("fable/high")).toBe(false);
  await reloaded.harness.dispose();
});

test("the editor rejects unknown keys and invalid settings without partial writes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  for (const values of [
    { autorouterEnabled: true, unrelatedSetting: true },
    { autorouterEnabled: true, autorouterRule_astra_medium: " " },
    { autorouterEnabled: true, autorouterProjectIndex: "not json" },
    { autorouterEnabled: true, autorouterFallback: "unknown/model" },
    { autorouterEnabled: "true" },
  ]) {
    await expect(harness.callRpc("updateAutorouterSettings", { values })).rejects.toThrow();
    expect((await readAutorouterSettings(bb)).enabled).toBe(false);
  }
  await harness.dispose();
});
