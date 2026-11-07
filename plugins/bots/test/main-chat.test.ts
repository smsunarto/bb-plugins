import { afterEach, expect, it } from "vitest";
import { backend, PERSONAL_ID, request } from "./backend-fixture";

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function setup() {
  const host = await backend();
  instances.push(host);
  const bot = await host.create();
  const open = async () =>
    (await host.harness.behavior.callRpc("main_open", { botId: bot.id })) as {
      threadId: string;
      created: boolean;
    };
  const lastMessages = async () =>
    (
      (await host.harness.behavior.callRpc("bots_list", {})) as {
        lastMessages: { botId: string; text: string }[];
      }
    ).lastMessages;
  return { host, bot, open, lastMessages };
}

it("starts the bot's main chat once and reopens it after", async () => {
  const { host, bot, open } = await setup();
  const first = await open();
  expect(first.created).toBe(true);
  expect(host.store.owner(first.threadId)).toBe(bot.id);
  expect(host.store.require(bot.id).mainThreadId).toBe(first.threadId);
  expect(await open()).toEqual({ threadId: first.threadId, created: false });
});

it("tells only the main chat's agent to delegate work to subthreads", async () => {
  const { host, open } = await setup();
  const main = await open();
  const config = host.initialConfigurations.find((entry) => entry.threadId === main.threadId);
  expect(config?.instructions).toContain("You are Atlas.");
  expect(config?.instructions).toContain("bb thread spawn --parent-self");
  const other = (await host.harness.behavior.callRpc("conversation_create", {
    botId: host.store.list()[0]!.id,
    request: request(PERSONAL_ID),
  })) as { threadId: string };
  const otherConfig = host.initialConfigurations.find((entry) => entry.threadId === other.threadId);
  expect(otherConfig?.instructions).toContain("You are Atlas.");
  expect(otherConfig?.instructions).not.toContain("--parent-self");
});

it("starts a new main chat when the previous one was archived", async () => {
  const { host, bot, open } = await setup();
  const first = await open();
  host.threads.set(first.threadId, {
    ...host.threads.get(first.threadId)!,
    archivedAt: Date.now(),
  });
  const next = await open();
  expect(next.created).toBe(true);
  expect(next.threadId).not.toBe(first.threadId);
  expect(host.store.require(bot.id).mainThreadId).toBe(next.threadId);
});

it("lists the main chat's latest reply as a plain one-line excerpt", async () => {
  const { host, bot, open, lastMessages } = await setup();
  const main = await open();
  const other = makeIdle(host, "thread-other");
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: other,
    lastAssistantText: "Not the main chat.",
  });
  expect(await lastMessages()).toEqual([]);
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: host.threads.get(main.threadId)!,
    lastAssistantText: "## Done\n\n**Shipped** the [fix](https://x.test).\n\n```ts\ncode()\n```",
  });
  expect(await lastMessages()).toEqual([
    expect.objectContaining({ botId: bot.id, text: "Done Shipped the fix." }),
  ]);
});

it("reads a main chat's earlier reply once when none was saved", async () => {
  const { host, bot, open, lastMessages } = await setup();
  const main = await open();
  const calls: string[] = [];
  host.harness.inspection.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => {
    calls.push(threadId);
    return { output: "Morning! What should we work on?" };
  });
  await lastMessages();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await lastMessages()).toEqual([
    expect.objectContaining({ botId: bot.id, text: "Morning! What should we work on?" }),
  ]);
  expect(calls).toEqual([main.threadId]);
});

function makeIdle(host: Awaited<ReturnType<typeof backend>>, id: string) {
  const thread = { ...[...host.threads.values()][0]!, id };
  host.threads.set(id, thread);
  return thread;
}
