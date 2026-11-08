import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { BotMetadata, ThreadBot } from "../contract";
import { backend, request } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function setup() {
  const host = await backend();
  hosts.push(host);
  const call = host.harness.behavior.callRpc.bind(host.harness.behavior);
  const bot = await host.create("Atlas");
  const { threadId } = (await call("conversation_create", {
    botId: bot.id,
    request: request(),
  })) as { threadId: string };
  await call("routine_save", {
    botId: bot.id,
    name: "Morning brief",
    instruction: "Summarize new support tickets.",
    cron: "0 9 * * 1-5",
    timezone: "America/Los_Angeles",
    projectId: "project",
  });
  await call("state_apply", {
    botId: bot.id,
    change: { target: "project", action: "own", projectId: "project" },
  });
  return { host, call, bot, threadId };
}
const listedBots = async (call: (name: string, input: unknown) => Promise<unknown>) =>
  ((await call("bots_list", {})) as { bots: BotMetadata[] }).bots;

describe("deleting a bot", () => {
  it("removes the bot and its schedules, and leaves its conversations unassigned", async () => {
    const { host, call, bot, threadId } = await setup();
    expect(host.automations.rows.size).toBe(1);
    expect(existsSync(host.stateDirectory(bot.id))).toBe(true);

    await expect(call("bot_delete", { botId: bot.id })).resolves.toEqual({ ok: true });

    expect((await listedBots(call)).map((entry) => entry.name)).not.toContain("Atlas");
    expect(host.automations.rows.size).toBe(0);
    expect(existsSync(host.stateDirectory(bot.id))).toBe(false);
    expect(host.threads.has(threadId)).toBe(true);
    expect(((await call("thread_bot", { threadId })) as ThreadBot).botId).toBeNull();
    // Its project is free for another bot to own.
    const other = await host.create("Beryl", []);
    await expect(
      call("state_apply", {
        botId: other.id,
        change: { target: "project", action: "own", projectId: "project" },
      }),
    ).resolves.toMatchObject({ changed: true });
    // Deleting it again changes nothing.
    await expect(call("bot_delete", { botId: bot.id })).resolves.toEqual({ ok: true });
  });

  it("keeps the bot when its schedule cannot be removed, so a retry can finish", async () => {
    const { host, call, bot } = await setup();
    host.automations.setUnavailable(true);
    await expect(call("bot_delete", { botId: bot.id })).rejects.toThrow();
    expect((await listedBots(call)).some((entry) => entry.id === bot.id)).toBe(true);
    host.automations.setUnavailable(false);
    await call("bot_delete", { botId: bot.id });
    expect(host.automations.rows.size).toBe(0);
  });

  it("refuses to delete Dr. Bot", async () => {
    const { call } = await setup();
    const drBot = (await listedBots(call)).find((entry) => entry.builtin === "dr-bot");
    expect(drBot).toBeDefined();
    await expect(call("bot_delete", { botId: drBot!.id })).rejects.toThrow(/built in/);
  });

  it("deletes a bot by name from the CLI", async () => {
    const { host, call, bot } = await setup();
    const result = await host.harness.behavior.runCli(["delete", "Atlas"]);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(String(result.stdout)).toContain(`Deleted Atlas (${bot.id})`);
    expect((await listedBots(call)).some((entry) => entry.id === bot.id)).toBe(false);
  });
});
