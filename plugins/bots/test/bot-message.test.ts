import { afterEach, expect, it } from "vitest";
import { backend, project, request } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function scope() {
  const host = await backend([project()]);
  hosts.push(host);
  const conversation = async (name: string) => {
    const bot = await host.create(name);
    const { threadId } = (await host.harness.behavior.callRpc("conversation_create", {
      botId: bot.id,
      request: request(),
    })) as { threadId: string };
    const call = async (input: unknown) =>
      JSON.parse(
        String(
          await host.harness.behavior.callAgentTool("bot_message", input, {
            threadId,
            projectId: "project",
          }),
        ),
      );
    return { bot, threadId, call };
  };
  const sends = () =>
    host.harness.inspection.sdk.callsTo("threads.send").map(
      ([args]) =>
        args as {
          threadId: string;
          mode: string;
          senderThreadId: string;
          input: { text: string }[];
        },
    );
  return { host, conversation, sends };
}

it("delivers to the recipient's main chat with a bot_message reply address", async () => {
  const { host, conversation, sends } = await scope();
  const atlas = await conversation("Atlas");
  const vega = await conversation("Vega");
  const main = host.store.require(vega.bot.id).mainThreadId;
  expect(main).toBe(vega.threadId);

  const receipt = await atlas.call({ bot: "vega", message: "Can you draft the release notes?" });

  expect(receipt).toEqual({
    botId: vega.bot.id,
    botName: "Vega",
    threadId: main,
    startedMainChat: false,
    delivery: "sent",
  });
  const [sent] = sends();
  expect(sent).toMatchObject({
    threadId: main,
    mode: "queue-if-active",
    senderThreadId: atlas.threadId,
  });
  expect(sent!.input[0]!.text).toContain("Can you draft the release notes?");
  expect(sent!.input[0]!.text).toContain(`bot_message({"bot": ${JSON.stringify(atlas.bot.id)}`);
});

it("starts a main chat for a recipient that has none", async () => {
  const { host, conversation, sends } = await scope();
  const atlas = await conversation("Atlas");
  const orion = await host.create("Orion");
  expect(host.store.require(orion.id).mainThreadId).toBeFalsy();

  const receipt = await atlas.call({ bot: orion.id, message: "Hello" });

  const main = host.store.require(orion.id).mainThreadId;
  expect(main).toBeTruthy();
  expect(receipt).toMatchObject({ threadId: main, startedMainChat: true });
  expect(sends().at(-1)?.threadId).toBe(main);
});

it("refuses self-messages and unknown bots, listing who can be messaged", async () => {
  const { conversation, sends } = await scope();
  const atlas = await conversation("Atlas");
  await conversation("Vega");

  await expect(atlas.call({ bot: "Atlas", message: "Hi" })).rejects.toThrow("That is this bot");
  await expect(atlas.call({ bot: "Nobody", message: "Hi" })).rejects.toThrow(/Vega \(/);
  await expect(atlas.call({ bot: "Vega", message: "  " })).rejects.toThrow();
  expect(sends()).toHaveLength(0);
});

it("does not deliver to a main chat that was moved to another bot or detached", async () => {
  const { host, conversation, sends } = await scope();
  const atlas = await conversation("Atlas");
  const vega = await conversation("Vega");
  const orion = await conversation("Orion");

  for (const botId of [orion.bot.id, null]) {
    const before = host.store.require(vega.bot.id).mainThreadId!;
    await host.harness.behavior.callRpc("conversation_set_bot", { threadId: before, botId });

    const receipt = await atlas.call({ bot: "Vega", message: "Still there?" });

    expect(receipt.startedMainChat).toBe(true);
    expect(receipt.threadId).not.toBe(before);
    expect(host.store.owner(receipt.threadId)).toBe(vega.bot.id);
    expect(sends().at(-1)?.threadId).toBe(receipt.threadId);
  }
});
