import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { readAutorouterSettings } from "../lib/autorouter/settings.ts";

import { ruleSettingKey } from "../../shared/autorouter/policy.ts";

test("manually edited project index and model prompts are used without reloading", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  const entries = [
    {
      repository: "unregistered",
      path: "/git/unregistered",
      hostId: "host",
      projectId: null,
      summary: "An unregistered repository.",
      examples: ["First task", "Second task", "Third task"],
    },
  ];
  await harness.setSettings({
    autorouterProjectIndex: JSON.stringify(entries),
    [ruleSettingKey("astra/high")]: "Use for kernel correctness reviews.",
  });
  expect(await harness.callRpc("getAutorouterProjectIndex")).toEqual({ entries });
  expect(
    (await readAutorouterSettings(bb)).rules.find((rule) => rule.route === "astra/high")?.prompt,
  ).toBe("Use for kernel correctness reviews.");
  await expect(harness.setSettings({ autorouterProjectIndex: "not JSON" })).rejects.toThrow();
  expect(await harness.callRpc("getAutorouterProjectIndex")).toEqual({ entries });
  await harness.dispose();
});
