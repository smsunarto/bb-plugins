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
        "dev_mode_arena_start",
        "dev_mode_arena_status",
        "dev_mode_arena_stop",
        "dev_mode_review_start",
        "dev_mode_review_context",
      ],
    );
    assert.equal(result.skills.length, 18);
    assert.ok(result.skills.every((name) => !name.startsWith("principle-")));
    assert.ok(result.skills.includes("arena"));
    assert.ok(result.skills.includes("architect"));
    assert.ok(result.skills.includes("review"));
    assert.ok(result.skills.includes("dev"));
    const instructions = f.harness.inspection.registrations.instructionProvider?.({
      threadId: "thread",
      projectId: "project",
    });
    assert.match(instructions ?? "", /bb dev-mode principle --name <name>/);
    assert.match(instructions ?? "", /read the `dev` skill/);
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
        "dev_mode_arena_context",
        "dev_mode_arena_report",
        "dev_mode_arena_prepare",
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
  [
    "scott-engineering",
    { reviewRun: { id: "run" } },
    ["dev_mode_review_context", "scott_engineering_review_context"],
  ],
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

test("pre-rename Arena worker tools still reach the same run boundary", async () => {
  const f = createFakePluginHost({ pluginId: "scott-engineering", agentSkillIds: skills });
  try {
    await plugin(f.bb);
    const runId = "00000000-0000-4000-8000-000000000001";
    for (const prefix of ["dev_mode", "scott_engineering"]) {
      for (const operation of ["context", "prepare", "report"]) {
        const input =
          operation === "report"
            ? { runId, report: { kind: "candidate", summary: "Result", tradeoff: "Cost" } }
            : { runId };
        await assert.rejects(
          f.harness.behavior.callAgentTool(`${prefix}_arena_${operation}`, input, {
            threadId: "worker",
          }),
          /Arena run not found/,
        );
      }
    }
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
