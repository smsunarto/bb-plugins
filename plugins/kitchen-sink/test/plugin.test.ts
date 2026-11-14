import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import plugin from "../src/server/server.ts";
import { mentionProviders } from "../src/server/mentions.ts";
import { WORKSPACE_CHANGED_CHANNEL } from "../src/shared/contract.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsRoot = join(root, "skills");

test("the plugin loads against the fake host and registers every mention provider", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);

  expect(harness.registrations.rpcMethods).toEqual([
    "projectScripts",
    "saveProjectScript",
    "exportUnityClaims",
    "getRpivTodos",
  ]);
  expect(
    harness.registrations.experimental_publishedRpcMethods.map((entry) => entry.method),
  ).toEqual(["projectScripts", "saveProjectScript"]);
  expect(harness.registrations.instructionProvider).toBeNull();
  expect(harness.registrations.mentionProviders.map((provider) => provider.id)).toEqual(
    mentionProviders.map((provider) => provider.id),
  );
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
  expect(directories).toEqual(["project-scripts", "subthread", "test-remotely"]);
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
    expect(fields.description?.length ?? 0).toBeGreaterThan(40);
  }
});

test("publishes completion signals only when a thread becomes idle", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  const thread = makeThreadResponse({ id: "thread-9" });

  await harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await harness.emitThreadEvent("thread.failed", { thread, error: "boom" });
  await harness.emitThreadEvent("thread.archived", { thread });
  await harness.emitThreadEvent("thread.deleted", { thread });
  await harness.emitThreadEvent("thread.active", { thread });

  expect(
    harness.realtimeSignals.filter((entry) => entry.channel === WORKSPACE_CHANGED_CHANNEL),
  ).toEqual([
    {
      channel: WORKSPACE_CHANGED_CHANNEL,
      payload: { threadId: "thread-9", parentThreadId: null, reason: "idle" },
    },
  ]);
});

test("subthread completion carries its parent ID so the browser can keep it silent", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  const thread = makeThreadResponse({ id: "child", parentThreadId: "parent" });
  await harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  expect(
    harness.realtimeSignals.filter((entry) => entry.channel === WORKSPACE_CHANGED_CHANNEL),
  ).toEqual([
    {
      channel: WORKSPACE_CHANGED_CHANNEL,
      payload: {
        threadId: "child",
        parentThreadId: "parent",
        reason: "idle",
      },
    },
  ]);
});
