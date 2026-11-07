import { afterEach, describe, expect, it } from "vitest";
import {
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { backend, PERSONAL_ID, project } from "./backend-fixture";
import { conversationOwners } from "../lib/conversations";
import type { ThreadBot, ThreadBotPrompt } from "../contract";
import { botGuidance } from "../lib/bot-instructions";

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});
async function setup() {
  const host = await backend([project(), project("other")]);
  instances.push(host);
  return host;
}
function addThread(
  host: Awaited<ReturnType<typeof backend>>,
  id: string,
  projectId = PERSONAL_ID,
  parentThreadId: string | null = null,
) {
  const value = makeThreadResponse({
    id,
    projectId,
    parentThreadId,
    createdAt: 1,
    originPluginId: null,
  });
  host.threads.set(id, value);
  return value;
}
const call = (host: Awaited<ReturnType<typeof backend>>, method: string, input: unknown) =>
  host.harness.behavior.callRpc(method as never, input as never);

describe("choosing a thread's bot", () => {
  it("reports the bound or inherited bot with every bot to choose from", async () => {
    const host = await setup();
    const atlas = await host.create("Atlas", []);
    const nova = await host.create("Nova", []);
    addThread(host, "root");
    addThread(host, "child", PERSONAL_ID, "root");
    host.store.bind("root", atlas.id);
    const root = (await call(host, "thread_bot", { threadId: "root" })) as ThreadBot;
    expect(root).toMatchObject({ botId: atlas.id, explicit: true, detached: false });
    expect(root.bots.map((bot) => bot.name)).toEqual(["Atlas", "Nova"]);
    expect(await call(host, "thread_bot", { threadId: "child" })).toMatchObject({
      botId: atlas.id,
      explicit: false,
    });
    expect(nova.id).toBeTruthy();
  });

  it("moves a conversation and its descendants to another bot, joining its project and leaving main pointers", async () => {
    const host = await setup();
    const atlas = await host.create("Atlas", ["project"]);
    const nova = await host.create("Nova", []);
    for (const [id, parent] of [
      ["main", null],
      ["root", null],
      ["child", "root"],
      ["grandchild", "child"],
    ] as const) {
      addThread(host, id, "project", parent);
      host.store.bind(id, atlas.id);
    }
    host.store.mutate(atlas.id, (bot) => ({
      ...bot,
      mainThreadId: "main",
      threadOrder: ["main", "root", "child"],
    }));
    const result = (await call(host, "conversation_set_bot", {
      threadId: "root",
      botId: nova.id,
    })) as { threadIds: string[] };
    expect(result.threadIds.sort()).toEqual(["child", "grandchild", "root"]);
    for (const id of ["root", "child", "grandchild"]) expect(host.store.owner(id)).toBe(nova.id);
    expect(host.store.owner("main")).toBe(atlas.id);
    expect(host.store.require(atlas.id)).toMatchObject({
      mainThreadId: "main",
      threadOrder: ["main"],
    });
    expect(host.store.require(nova.id).linkedProjectIds).toEqual(["project"]);
    expect(host.store.projectOwner("project")).toBeUndefined();
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
  });

  it("detaches an inherited child with No bot, so neither server nor sidebar inherits, until it is assigned again", async () => {
    const host = await setup();
    const atlas = await host.create("Atlas", []);
    addThread(host, "root");
    addThread(host, "child", PERSONAL_ID, "root");
    addThread(host, "grandchild", PERSONAL_ID, "child");
    host.store.bind("root", atlas.id);
    host.store.bind("grandchild", atlas.id);
    const result = (await call(host, "conversation_set_bot", {
      threadId: "child",
      botId: null,
    })) as { threadIds: string[] };
    expect(result.threadIds.sort()).toEqual(["child", "grandchild"]);
    expect(await call(host, "thread_bot", { threadId: "child" })).toMatchObject({
      botId: null,
      detached: true,
    });
    expect(await call(host, "thread_bot", { threadId: "grandchild" })).toMatchObject({
      botId: null,
    });
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "child", parentThreadId: "root" },
        project: { id: PERSONAL_ID },
      }),
    );
    expect(config.tools).toEqual([]);
    const listed = (await call(host, "bots_list", {})) as {
      threadBindings: { threadId: string; botId: string }[];
      detachedThreadIds: string[];
    };
    expect(listed.detachedThreadIds).toEqual(["child"]);
    const threads = ["root", "child", "grandchild"].map((id) => ({
      id,
      parentThreadId: host.threads.get(id)!.parentThreadId,
    })) as never;
    expect([
      ...conversationOwners(
        threads,
        listed.threadBindings,
        new Set(listed.detachedThreadIds),
      ).keys(),
    ]).toEqual(["root"]);
    // An explicit assignment (dialog or drag) clears the detachment.
    await call(host, "conversation_assign", { botId: atlas.id, threadId: "child" });
    expect(await call(host, "thread_bot", { threadId: "child" })).toMatchObject({
      botId: atlas.id,
      detached: false,
    });
    expect(await call(host, "thread_bot", { threadId: "grandchild" })).toMatchObject({
      botId: atlas.id,
    });
  });

  it("assigns an unassigned chat, and treats choosing the current bot as a no-op", async () => {
    const host = await setup();
    const atlas = await host.create("Atlas", []);
    addThread(host, "chat", "other");
    expect(await call(host, "conversation_set_bot", { threadId: "chat", botId: null })).toEqual({
      ok: true,
      threadIds: [],
    });
    expect(await call(host, "conversation_set_bot", { threadId: "chat", botId: atlas.id })).toEqual(
      { ok: true, threadIds: ["chat"] },
    );
    expect(host.store.require(atlas.id).linkedProjectIds).toEqual(["other"]);
    expect(await call(host, "conversation_set_bot", { threadId: "chat", botId: atlas.id })).toEqual(
      { ok: true, threadIds: [] },
    );
  });

  it("previews exactly the prompt additions the agent configuration gives the thread", async () => {
    const host = await setup();
    const atlas = await host.create("Atlas", ["project"]);
    addThread(host, "chat", "project");
    addThread(host, "child", "project", "chat");
    addThread(host, "loose", "project");
    host.store.bind("chat", atlas.id);
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "child", parentThreadId: "chat" },
        project: (await host.bb.sdk.projects.list()).find((entry) => entry.id === "project")!,
      }),
    );
    const prompt = (await call(host, "thread_bot_prompt", {
      threadId: "child",
    })) as ThreadBotPrompt;
    expect(prompt).toMatchObject({
      botId: atlas.id,
      tools: config.tools.map((tool: { name: string }) => tool.name),
      skills: config.skills,
    });
    expect(prompt.sections).toEqual([
      { id: "bot", title: "Bot context", text: config.instructions },
      { id: "tools", title: "Tool guidance", text: botGuidance() },
    ]);
    expect(prompt.sections[0]!.text).toContain("# Bot: Atlas");
    expect(await call(host, "thread_bot_prompt", { threadId: "loose" })).toEqual({
      botId: null,
      tools: [],
      skills: [],
      sections: [],
    });
  });
});

it("reads ready bot memory without changing the saved revision", async () => {
  const host = await setup();
  const atlas = await host.create("Atlas", []);
  const before = host.store.require(atlas.id);
  const changes = () => host.bb.storage.database().prepare("SELECT total_changes() AS count").get();
  const writesBefore = changes();
  await call(host, "state_read", { botId: atlas.id, file: "MEMORY.md" });
  await call(host, "state_read", { botId: atlas.id, file: "MEMORY.md" });
  expect(host.store.require(atlas.id)).toEqual(before);
  expect(changes()).toEqual(writesBefore);
});
