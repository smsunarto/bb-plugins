import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { readAutorouterSettings } from "../lib/autorouter/settings.ts";

test("the composer toggle persists in plugin settings across a reload", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  expect((await readAutorouterSettings(bb)).enabled).toBe(false);
  await harness.callRpc("updateAutorouterEnabled", { enabled: true });
  const reloaded = await harness.reload(plugin);
  expect((await readAutorouterSettings(reloaded.bb)).enabled).toBe(true);
  await reloaded.harness.callRpc("updateAutorouterEnabled", { enabled: false });
  expect((await readAutorouterSettings(reloaded.bb)).enabled).toBe(false);
  await reloaded.harness.dispose();
});
