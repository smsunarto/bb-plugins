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
        "scott_engineering_review_start",
        "scott_engineering_review_context",
      ],
    );
    assert.equal(result.skills.length, 17);
    assert.ok(result.skills.every((name) => !name.startsWith("principle-")));
    assert.ok(result.skills.includes("arena"));
    assert.ok(result.skills.includes("architect"));
    assert.ok(result.skills.includes("review"));
    const instructions = f.harness.inspection.registrations.instructionProvider?.({
      threadId: "thread",
      projectId: "project",
    });
    assert.match(instructions ?? "", /bb scott-engineering principle --name index/);
    assert.ok((instructions?.length ?? 0) <= 4096);
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
        pluginMetadata: { arena: { runId: "run", jobKey: "job" } },
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

for (const [origin, metadata, tools] of [
  ["scott-engineering", { reviewRun: { id: "run" } }, ["scott_engineering_review_context"]],
  ["review", {}, []],
  ["scott-engineering", { arenaDigest: { runId: "run" } }, []],
  ["scott-engineering", {}, []],
  ["side-chat", {}, []],
] as const) {
  test(`worker routing isolates ${origin} ${JSON.stringify(metadata)}`, async () => {
    const f = createFakePluginHost({ pluginId: "scott-engineering", agentSkillIds: skills });
    try {
      await plugin(f.bb);
      const result = await f.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          origin: { kind: null, pluginId: origin },
          pluginMetadata: metadata,
        }),
      );
      assert.deepEqual(
        result.tools.map((tool) => tool.name),
        tools,
      );
      assert.deepEqual(result.skills, []);
      assert.equal(result.instructions, null);
    } finally {
      await f.harness.lifecycle.dispose();
    }
  });
}
