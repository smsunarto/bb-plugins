import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import plugin, { INLINE_VIS_INSTRUCTIONS, SMART_EMBED_INSTRUCTIONS } from "../src/server/server.ts";
import { mentionProviders } from "../src/server/mentions.ts";
import { WORKSPACE_CHANGED_CHANNEL } from "../src/shared/contract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsRoot = join(root, "skills");

test("the plugin loads against the fake host and registers every mention provider", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);

  expect(harness.registrations.rpcMethods).toEqual(["renderEmbed"]);
  expect(
    harness.registrations.experimental_publishedRpcMethods.map((entry) => [
      entry.method,
      entry.registrationDescription,
      entry.methodDescription,
    ]),
  ).toEqual([
    [
      "renderEmbed",
      "Smart Embed citations.",
      "Render a Smart Embed: a source citation, a recorded turn or commit diff, or a saved patch.",
    ],
  ]);
  expect(harness.registrations.mentionProviders.map((provider) => provider.id)).toEqual(
    mentionProviders.map((provider) => provider.id),
  );
});

test("a fresh install disables bb's built-in inline-vis, which claims the same directive", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: { plugins: { disable: () => ({ ok: true }) } },
  });
  await plugin(bb);
  expect(harness.sdk.callsTo("plugins.disable")).toEqual([]);

  await harness.lifecycle.install();
  expect(harness.sdk.callsTo("plugins.disable")).toEqual([[{ pluginId: "inline-vis" }]]);
});

test("mention provider ids are unique and free of the wire separator", () => {
  const ids = mentionProviders.map((provider) => provider.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
});

test("the manifest declares the skills root that holds every composer command", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.bb.skills).toEqual(["skills"]);
  expect(manifest.files).toContain("skills/");
});

test("each skill directory carries a SKILL.md whose frontmatter name matches the directory", async () => {
  const directories = (await readdir(skillsRoot)).sort();
  expect(directories).toEqual([
    "inline-vis",
    "ship-it",
    "smart-embeds",
    "subthread",
    "sync",
    "test-remotely",
  ]);
  for (const directory of directories) {
    const path = join(skillsRoot, directory, "SKILL.md");
    expect((await stat(path)).isFile()).toBe(true);
    const skill = await readFile(path, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter, `${directory}/SKILL.md starts with frontmatter`).not.toBeNull();
    const fields = Object.fromEntries(
      (frontmatter?.[1] ?? "")
        .split("\n")
        .map((line) => line.split(/:\s(.*)/s))
        .map(([key, value]) => [key, value ?? ""]),
    );
    expect(fields.name).toBe(directory);
    if (directory === "ship-it") {
      expect(fields.description).toBe("Ship it");
      expect(fields["disable-model-invocation"]).toBe("true");
    } else {
      expect(fields.description?.length ?? 0).toBeGreaterThan(40);
    }
  }
});

test("sync routes GitButler repositories through the gitbutler skill", async () => {
  const skill = await readFile(join(skillsRoot, "sync", "SKILL.md"), "utf8");
  expect(skill).toContain("`gitbutler` skill");
  expect(skill).toContain("but status");
});

test("the measured baseline prompt is the shipped Smart Embed text", async () => {
  const baseline = await readFile(new URL("../eval/prompts/baseline.md", import.meta.url), "utf8");
  expect(baseline).toBe(`${SMART_EMBED_INSTRUCTIONS}\n`);
});

test("injects preview skill routing within the host's per-plugin character limit", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);

  const instructions = harness.registrations.instructionProvider?.({
    threadId: "thread-1",
    projectId: "project-1",
  });
  expect(instructions).toBe(`${INLINE_VIS_INSTRUCTIONS}\n\n${SMART_EMBED_INSTRUCTIONS}`);
  // BB truncates contributeInstructions output after 4096 characters.
  expect(instructions?.length).toBeLessThanOrEqual(4096);
  const routedSkills = [...(instructions?.matchAll(/read the `([^`]+)` skill/g) ?? [])].map(
    (match) => match[1],
  );
  expect(routedSkills).toEqual(["inline-vis", "smart-embeds"]);
  for (const name of routedSkills) {
    expect((await stat(join(skillsRoot, name!, "SKILL.md"))).isFile()).toBe(true);
  }
});

test("publishes a workspace-changed signal when a thread settles, fails, or goes away", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  const thread = makeThreadResponse({ id: "thread-9" });

  await harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await harness.emitThreadEvent("thread.failed", { thread, error: "boom" });
  await harness.emitThreadEvent("thread.archived", { thread });
  await harness.emitThreadEvent("thread.deleted", { thread });
  await harness.emitThreadEvent("thread.active", { thread });

  expect(harness.realtimeSignals).toEqual([
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "idle" } },
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "failed" } },
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "archived" } },
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "deleted" } },
  ]);
});
