import { expect, test } from "bun:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { readFile } from "node:fs/promises";
import plugin from "./server.ts";

async function configuration(pluginId: string | null) {
  const host = createFakePluginHost({
    pluginId: "review",
    agentSkillIds: ["review-workflow", "review-quick", "review-standard", "review-deep"],
  });
  await plugin(host.bb);
  return host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { kind: pluginId === "side-chat" ? "fork" : null, pluginId },
    }),
  );
}

test("authors get review tools while reviewers only get pinned context", async () => {
  const author = await configuration(null),
    reviewer = await configuration("review"),
    side = await configuration("side-chat");
  expect(author.tools.map((tool) => (typeof tool === "string" ? tool : tool.name))).toEqual([
    "review_start",
    "review_result",
    "review_context",
  ]);
  expect(reviewer.tools.map((tool) => (typeof tool === "string" ? tool : tool.name))).toEqual([
    "review_context",
  ]);
  expect(side.tools).toEqual([]);
  expect(author.skills).toEqual([
    "review-workflow",
    "review-quick",
    "review-standard",
    "review-deep",
  ]);
  expect(reviewer.instructions).toBeNull();
  expect(side.instructions).toBeNull();
});

test("manual commands are user-only while the agent workflow stays available", async () => {
  for (const mode of ["quick", "standard", "deep"]) {
    const skill = await readFile(
      new URL(`../../skills/review-${mode}/SKILL.md`, import.meta.url),
      "utf8",
    );
    expect(skill).toContain("disable-model-invocation: true");
    const policy = await readFile(
      new URL(`../../skills/review-${mode}/agents/openai.yaml`, import.meta.url),
      "utf8",
    );
    expect(policy).toContain("allow_implicit_invocation: false");
    expect(skill).toContain(`mode: "${mode}"`);
  }
  const workflow = await readFile(
    new URL("../../skills/review-workflow/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(workflow).toContain("user-invocable: false");
});

test("Prompt Editor exposes each registered review tool as an editable tool description", async () => {
  const { describePlugin } = await import("../../../prompt-editor/src/server/lib/agent-text.ts");
  const rootDir = new URL("../../", import.meta.url).pathname;
  const listed = describePlugin({
    id: "review",
    name: "Review",
    rootDir,
    source: `path:${rootDir}`,
    sourceDisplay: "local",
    status: "running",
    capabilities: ["review_start", "review_result", "review_context"].map((id) => ({
      kind: "agent-tool",
      id,
      detail: null,
    })),
  });
  expect(listed?.tools.map((tool) => [tool.name, tool.file])).toEqual([
    ["review_start", "instructions/tools/review_start.md"],
    ["review_result", "instructions/tools/review_result.md"],
    ["review_context", "instructions/tools/review_context.md"],
  ]);
});
