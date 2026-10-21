import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const skills = readdirSync(fileURLToPath(new URL("../../skills", import.meta.url)));

async function host() {
  const f = createFakePluginHost({ pluginId: "scott-engineering", agentSkillIds: skills });
  await plugin(f.bb);
  return f;
}

test("authors get the skills and the Arena and review prompts, with no tools", async () => {
  const f = await host();
  try {
    const result = await f.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    assert.deepEqual(result.tools, []);
    assert.deepEqual([...result.skills].sort(), [...skills].sort());
    assert.ok(result.skills.includes("arena") && result.skills.includes("review"));
    assert.match(result.instructions ?? "", /bb dev-mode principle --name <name>/);
    assert.match(result.instructions ?? "", /bb thread spawn --parent-self/);
    assert.equal(f.harness.inspection.registrations.agentTools.length, 0);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

for (const origin of ["side-chat", "review", "scott-engineering"])
  test(`${origin} threads get no skills or prompts`, async () => {
    const f = await host();
    try {
      const result = await f.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ origin: { kind: null, pluginId: origin } }),
      );
      assert.deepEqual(result.tools, []);
      assert.deepEqual(result.skills, []);
      assert.equal(result.instructions, null);
    } finally {
      await f.harness.lifecycle.dispose();
    }
  });

const childTitles = ["arena", "review"].flatMap((skill) =>
  [
    ...readFileSync(new URL(`../../skills/${skill}/SKILL.md`, import.meta.url), "utf8").matchAll(
      /`((?:Arena|Review) \((?:Claude|Codex)\))`/g,
    ),
  ].map((match) => match[1]!),
);

test("the children the arena and review skills name get no skills or prompts", async () => {
  assert.deepEqual(childTitles.sort(), [
    "Arena (Claude)",
    "Arena (Codex)",
    "Review (Claude)",
    "Review (Codex)",
  ]);
  const f = await host();
  try {
    for (const title of childTitles) {
      const result = await f.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { title, parentThreadId: "author" } }),
      );
      assert.deepEqual(result.skills, [], title);
      assert.equal(result.instructions, null, title);
    }
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("the dev skill indexes every shared principle and links real playbooks", async () => {
  const index = new URL("../../skills/dev/SKILL.md", import.meta.url);
  const text = readFileSync(index, "utf8");
  const f = await host();
  try {
    const listed = await f.harness.behavior.runCli(["principle"]);
    const principles = listed.stdout?.trim().split("\n") ?? [];
    const indexed = [...text.matchAll(/^- `([a-z-]+)`\./gm)].map((match) => match[1]);
    assert.deepEqual(indexed.sort(), principles.sort());
  } finally {
    await f.harness.lifecycle.dispose();
  }
  const playbooks = [...text.matchAll(/\]\((playbooks\/[a-z-]+\.md)\)/g)].map((match) => match[1]!);
  assert.deepEqual(
    playbooks.map((path) => path.slice("playbooks/".length)).sort(),
    readdirSync(new URL("../../skills/dev/playbooks", import.meta.url)).sort(),
  );
  for (const path of playbooks) assert.ok(existsSync(new URL(path, index)), path);
});

test("Dev Mode keeps its stored id behind the dev-mode CLI", async () => {
  const f = await host();
  try {
    assert.equal(f.harness.inspection.registrations.cli?.name, "dev-mode");
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
