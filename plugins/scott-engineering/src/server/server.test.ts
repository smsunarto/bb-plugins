import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const skills = readdirSync(fileURLToPath(new URL("../../skills", import.meta.url)));
test("authors get launch controls and the migrated skill catalog", async () => {
  const f = createFakePluginHost({ pluginId: "scott-engineering", agentSkillIds: skills });
  try {
    await plugin(f.bb);
    const result = await f.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      [
        "scott_engineering_arena_start",
        "scott_engineering_arena_status",
        "scott_engineering_arena_stop",
      ],
    );
    assert.equal(result.skills.length, 38);
    assert.ok(result.skills.includes("arena"));
    assert.ok(result.skills.includes("architect"));
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("workers get report/context tools and cannot recursively launch Arena", async () => {
  const f = createFakePluginHost({ pluginId: "scott-engineering", agentSkillIds: skills });
  try {
    await plugin(f.bb);
    const result = await f.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        origin: { kind: null, pluginId: "scott-engineering" },
      }),
    );
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      [
        "scott_engineering_arena_context",
        "scott_engineering_arena_report",
        "scott_engineering_arena_prepare",
      ],
    );
    assert.deepEqual(result.skills, []);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
