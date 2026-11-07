import { afterEach, expect, it } from "vitest";
import { backend, PERSONAL_ID } from "./backend-fixture";

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

const personal = { type: "host", hostId: "host-home", workspace: { type: "personal" } } as const;

async function setup() {
  const host = await backend();
  instances.push(host);
  const bot = await host.create();
  const open = async () =>
    (await host.harness.behavior.callRpc("main_open", {
      botId: bot.id,
      projectId: PERSONAL_ID,
      environment: personal,
    })) as { threadId: string; created: boolean };
  return { host, bot, open };
}

it("starts the bot's main chat once and reopens it after", async () => {
  const { host, bot, open } = await setup();
  const first = await open();
  expect(first.created).toBe(true);
  expect(host.store.owner(first.threadId)).toBe(bot.id);
  expect(host.store.require(bot.id).mainThreadId).toBe(first.threadId);
  expect(host.initialConfigurations.at(-1)?.instructions).toContain("You are Atlas.");
  expect(await open()).toEqual({ threadId: first.threadId, created: false });
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
