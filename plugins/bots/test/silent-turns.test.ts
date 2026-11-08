import { afterEach, expect, it } from "vitest";
import { backend } from "./backend-fixture";

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function setup() {
  const host = await backend();
  instances.push(host);
  const bot = await host.create();
  const { threadId } = (await host.harness.behavior.callRpc("main_open", { botId: bot.id })) as {
    threadId: string;
  };
  const marked: string[] = [];
  host.harness.inspection.sdk.stub(
    "threads.markRead",
    async ({ threadId }: { threadId: string }) => {
      marked.push(threadId);
      return host.threads.get(threadId)!;
    },
  );
  /** Runs one turn on `id`, read or unread when it begins, ending with `reply`. */
  const turn = async (id: string, { read, reply }: { read: boolean; reply: string | null }) => {
    const row = host.threads.get(id)!;
    const started = { ...row, latestAttentionAt: 1000, lastReadAt: read ? 1000 : 500 };
    host.threads.set(id, started);
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: started });
    const finished = { ...started, latestAttentionAt: 2000 };
    host.threads.set(id, finished);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: finished,
      lastAssistantText: reply,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { host, mainId: threadId, marked, turn };
}

it("marks a bot's silent turn read so bb sends no empty push", async () => {
  const { mainId, marked, turn } = await setup();
  await turn(mainId, { read: true, reply: "" });
  await turn(mainId, { read: true, reply: null });
  await turn(mainId, { read: true, reply: "  \n" });
  expect(marked).toEqual([mainId, mainId, mainId]);
});

it("leaves a turn with a reply to notify", async () => {
  const { mainId, marked, turn } = await setup();
  await turn(mainId, { read: true, reply: "🚫 Blocked on Sentry access." });
  expect(marked).toEqual([]);
});

it("keeps an earlier unread reply unread through a silent turn", async () => {
  const { mainId, marked, turn } = await setup();
  await turn(mainId, { read: false, reply: "" });
  expect(marked).toEqual([]);
});

it("leaves threads that belong to no bot alone", async () => {
  const { host, marked, turn } = await setup();
  host.threads.set("unowned", { ...[...host.threads.values()][0]!, id: "unowned" });
  await turn("unowned", { read: true, reply: "" });
  expect(marked).toEqual([]);
});
