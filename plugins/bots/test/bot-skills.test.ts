import { afterEach, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { backend, project, request } from "./backend-fixture";
import { skillTemplate } from "../lib/skill-schema";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

const skill = (name: string, body = "Steps.") =>
  `${skillTemplate(name, `Use when writing ${name}.`)}${body}\n`;

async function scope() {
  const host = await backend([project()]);
  hosts.push(host);
  const conversation = async (name: string) => {
    const bot = await host.create(name);
    const { threadId } = (await host.harness.behavior.callRpc("conversation_create", {
      botId: bot.id,
      request: request(),
    })) as { threadId: string };
    const ctx = { threadId, projectId: "project" };
    const call = async (tool: string, input: unknown) =>
      JSON.parse(String(await host.harness.behavior.callAgentTool(tool, input, ctx)));
    return { bot, ctx, call };
  };
  return { host, conversation };
}

it("keeps a skill written from a repo conversation in the bot's home project only", async () => {
  const { host, conversation } = await scope();
  const atlas = await conversation("Atlas");
  const vega = await conversation("Vega");

  const written = await atlas.call("bot_skill_update", {
    action: "write",
    name: "release-notes",
    content: skill("release-notes"),
  });

  const home = host.store.require(atlas.bot.id).homeProjectId!;
  const root = host.projects.find((entry) => entry.id === home)!.sources![0]!.path;
  expect(root).toMatch(/^\/home\/test\/bb-bots\/atlas-/u);
  expect(host.get("host-home", `${root}/.bb/skills/release-notes/SKILL.md`)).toBe(
    skill("release-notes"),
  );
  expect(await atlas.call("bot_skill_read", {})).toEqual({
    skills: [{ name: "release-notes", description: "Use when writing release-notes." }],
  });
  expect(await atlas.call("bot_skill_read", { name: "release-notes" })).toEqual({
    name: "release-notes",
    content: skill("release-notes"),
    sha256: written.sha256,
  });
  // Another bot neither lists nor reads it.
  expect(await vega.call("bot_skill_read", {})).toEqual({ skills: [] });
  await expect(vega.call("bot_skill_read", { name: "release-notes" })).rejects.toThrow(
    /no skill named release-notes/u,
  );
});

it("replaces only the revision it read and never clobbers on create", async () => {
  const { conversation } = await scope();
  const atlas = await conversation("Atlas");
  const first = await atlas.call("bot_skill_update", {
    action: "write",
    name: "triage",
    content: skill("triage"),
  });
  await expect(
    atlas.call("bot_skill_update", { action: "write", name: "triage", content: skill("triage") }),
  ).rejects.toThrow(/already exists/u);
  const second = await atlas.call("bot_skill_update", {
    action: "write",
    name: "triage",
    content: skill("triage", "New steps."),
    expectedSha256: first.sha256,
  });
  await expect(
    atlas.call("bot_skill_update", {
      action: "write",
      name: "triage",
      content: skill("triage", "Stale steps."),
      expectedSha256: first.sha256,
    }),
  ).rejects.toThrow(/changed since it was read/u);
  expect((await atlas.call("bot_skill_read", { name: "triage" })).sha256).toBe(second.sha256);
});

it("rejects a SKILL.md BB would not load, before writing anything", async () => {
  const { host, conversation } = await scope();
  const atlas = await conversation("Atlas");
  await expect(
    atlas.call("bot_skill_update", {
      action: "write",
      name: "triage",
      content: skill("other-name"),
    }),
  ).rejects.toThrow(/name: triage/u);
  await expect(
    atlas.call("bot_skill_update", {
      action: "write",
      name: "triage",
      content: "# No frontmatter",
    }),
  ).rejects.toThrow(/frontmatter/u);
  await expect(
    atlas.call("bot_skill_update", { action: "write", name: "Bad Name", content: skill("x") }),
  ).rejects.toThrow();
  expect([...host.files.keys()].some((name) => name.includes(".bb/skills"))).toBe(false);
});

it("lets the editor create, list, and delete a bot's skills", async () => {
  const { host, conversation } = await scope();
  const atlas = await conversation("Atlas");
  const rpc = host.harness.behavior.callRpc;
  await rpc("skill_save", {
    botId: atlas.bot.id,
    name: "weekly-report",
    content: skill("weekly-report"),
    expectedSha256: null,
  });
  expect(await rpc("skills_list", { botId: atlas.bot.id })).toEqual({
    skills: [{ name: "weekly-report", description: "Use when writing weekly-report." }],
  });
  await rpc("skill_delete", { botId: atlas.bot.id, name: "weekly-report" });
  expect(await rpc("skills_list", { botId: atlas.bot.id })).toEqual({ skills: [] });
  await expect(rpc("skill_delete", { botId: atlas.bot.id, name: "weekly-report" })).rejects.toThrow(
    /no skill named/u,
  );
});

it("offers the skill tools and their guidance in bot conversations only", async () => {
  const { host, conversation } = await scope();
  const atlas = await conversation("Atlas");
  const resolve = (threadId: string) =>
    host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: threadId },
        project: { id: "project", kind: "standard" },
      }),
    );
  const bot = await resolve(atlas.ctx.threadId);
  expect(bot.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["bot_skill_read", "bot_skill_update"]),
  );
  const read = bot.tools.find((tool) => tool.name === "bot_skill_read") as {
    instructions?: string;
  };
  expect(read.instructions).toMatch(/home project's `\.bb\/skills`/u);
  const plain = await resolve("unassigned-thread");
  expect(plain.tools).toEqual([]);
});

it("validates frontmatter as YAML, the way BB reads it", async () => {
  const { validateSkillContent } = await import("../lib/bot-skills");
  const front = (lines: string) => `---\n${lines}\n---\n\nBody.\n`;
  // ": " inside a plain value is invalid YAML; BB would drop the description.
  expect(() =>
    validateSkillContent("notes", front("name: notes\ndescription: Use when: drafting")),
  ).toThrow(/not valid YAML/u);
  // " #" starts a comment, leaving no description.
  expect(() => validateSkillContent("notes", front("name: notes\ndescription: #todo"))).toThrow(
    /needs a description/u,
  );
  expect(() =>
    validateSkillContent("notes", front('name: notes\ndescription: "Use when: drafting"')),
  ).not.toThrow();
  expect(() =>
    validateSkillContent(
      "notes",
      front("name: notes\ndescription: >\n  Use when drafting\n  release notes."),
    ),
  ).not.toThrow();
  expect(() =>
    validateSkillContent("notes", front(`name: notes\ndescription: >\n  ${"x".repeat(1100)}`)),
  ).toThrow(/1024/u);
});

it("rejects names YAML would read as a number", async () => {
  const { conversation } = await scope();
  const atlas = await conversation("Atlas");
  await expect(
    atlas.call("bot_skill_update", { action: "write", name: "123", content: skill("123") }),
  ).rejects.toThrow();
});
