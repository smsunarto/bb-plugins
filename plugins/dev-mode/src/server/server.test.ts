import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
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

const legacy = [
  ["scott_engineering_arena_context", "dev_mode_arena_context"],
  ["scott_engineering_arena_report", "dev_mode_arena_report"],
  ["scott_engineering_arena_prepare", "dev_mode_arena_prepare"],
  ["scott_engineering_review_context", "dev_mode_review_context"],
] as const;

test("Dev Mode keeps its stored id behind the dev-mode CLI and tool names", async () => {
  const f = createFakePluginHost({ pluginId: "scott-engineering", agentSkillIds: skills });
  try {
    await plugin(f.bb);
    const { cli, agentTools } = f.harness.inspection.registrations;
    assert.equal(cli?.name, "dev-mode");
    const byName = new Map(agentTools.map((tool) => [tool.name, tool]));
    for (const [alias, canonical] of legacy) {
      const [old, current] = [byName.get(alias), byName.get(canonical)];
      assert.ok(old && current, `${alias} and ${canonical} are registered`);
      assert.deepEqual(old.inputSchema, current.inputSchema);
      assert.equal(old.description, current.description);
      assert.deepEqual(old.presentation, current.presentation);
    }
    // Defaulted fields stay optional, so a worker may send only the section.
    const review = byName.get("scott_engineering_review_context")?.inputSchema as {
      required?: string[];
    };
    assert.deepEqual(review.required, ["section"]);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

/** A host where `parent` can launch Arena and `intruder` is an unrelated thread. */
function arenaHost() {
  const environment = { id: "env", hostId: "host", path: "/work/source", status: "ready" };
  const threads = new Map(
    ["parent", "intruder"].map((id) => [
      id,
      makeThreadResponse({ id, projectId: "project", environmentId: "env", providerId: "codex" }),
    ]),
  );
  return createFakePluginHost({
    pluginId: "scott-engineering",
    agentSkillIds: skills,
    // The run host is offline, so the live run waits in its snapshot phase for a retry.
    experimental_callHostRpc: () => {
      throw Object.assign(new Error("host offline"), { body: { code: "host_unavailable" } });
    },
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return { ...thread, environment } as never;
        },
        experimental_listAncestors: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })),
        }),
        defaultExecutionOptions: async () => ({ permissionMode: "auto" }) as never,
        getPluginMetadata: async () => ({}),
      },
    },
  });
}

test("canonical and pre-rename Arena tools guard the same live run", async () => {
  const f = arenaHost();
  try {
    await plugin(f.bb);
    const { runId } = JSON.parse(
      (await f.harness.behavior.callAgentTool(
        "dev_mode_arena_start",
        { task: "Implement the task", requestId: "request" },
        { threadId: "parent" },
      )) as string,
    ) as { runId: string };
    for (const prefix of ["dev_mode", "scott_engineering"]) {
      const owned = JSON.parse(
        (await f.harness.behavior.callAgentTool(
          `${prefix}_arena_context`,
          { runId },
          { threadId: "parent" },
        )) as string,
      ) as { id: string };
      assert.equal(owned.id, runId);
      for (const operation of ["context", "prepare", "report"]) {
        const input =
          operation === "report"
            ? { runId, report: { kind: "candidate", summary: "Result", tradeoff: "Cost" } }
            : { runId };
        await assert.rejects(
          f.harness.behavior.callAgentTool(`${prefix}_arena_${operation}`, input, {
            threadId: "intruder",
          }),
          /This thread does not own the Arena run/,
        );
      }
    }
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
