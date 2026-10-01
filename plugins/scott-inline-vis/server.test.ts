import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { INSTRUCTIONS } from "./server.ts";

test("a fresh install disables bb's built-in inline-vis, which claims the same directive", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "scott-inline-vis",
    sdk: { plugins: { disable: () => ({ ok: true }) } },
  });
  await plugin(bb);
  expect(harness.sdk.callsTo("plugins.disable")).toEqual([]);

  await harness.lifecycle.install();
  expect(harness.sdk.callsTo("plugins.disable")).toEqual([[{ pluginId: "inline-vis" }]]);
});

test("routes agents to the bundled inline-vis skill", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "scott-inline-vis" });
  await plugin(bb);

  const instructions = harness.registrations.instructionProvider?.({
    threadId: "thread-1",
    projectId: "project-1",
  });
  expect(instructions).toBe(INSTRUCTIONS);
  expect(instructions).toContain("read the `inline-vis` skill");
  const skill = fileURLToPath(new URL("./skills/inline-vis/SKILL.md", import.meta.url));
  expect((await stat(skill)).isFile()).toBe(true);
});
