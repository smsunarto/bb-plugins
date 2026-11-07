import { afterEach, describe, expect, it } from "vitest";
import {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { handoffSourceFromText, handoffSourceThreadId } from "../lib/handoff-source";
import { backend, PERSONAL_ID, request } from "./backend-fixture";

describe("handoff detection", () => {
  it("recognises BB's native continue prefix and the handoff plugin's attachment only", () => {
    expect(handoffSourceFromText("Continue from @thread:thr_abc123\n\nnext steps")).toBe(
      "thr_abc123",
    );
    expect(
      handoffSourceFromText(
        "Continue from @thread:thr_5fhe5jfeey (Roundhouse integrator). `bb handoff` co...",
      ),
    ).toBe("thr_5fhe5jfeey");
    expect(handoffSourceFromText("Please look at @thread:thr_abc123")).toBeNull();
    const file = {
      type: "localFile",
      path: "handoff-thr_5ytzpvkkbt-1788792949255-1788792949258-bhccc2.md",
      name: "handoff-thr_5ytzpvkkbt-1788792949255.md",
    };
    expect(
      handoffSourceThreadId(
        [{ type: "text", text: "You are continuing YOUR OWN in-progress session" }, file],
        "handoff",
      ),
    ).toBe("thr_5ytzpvkkbt");
    expect(handoffSourceThreadId([{ type: "text", text: "Read this" }, file], null)).toBeNull();
  });
});

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("handoffs of bot conversations", () => {
  async function setup() {
    const host = await backend();
    instances.push(host);
    const bot = await host.create();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++)
      ids.push(
        (
          (await host.harness.behavior.callRpc("conversation_create", {
            botId: bot.id,
            request: request(PERSONAL_ID),
          })) as { threadId: string }
        ).threadId,
      );
    // New conversations are unordered (newest first) until the user reorders them.
    host.store.mutate(bot.id, (current) => ({ ...current, threadOrder: [ids[1]!, ids[0]!] }));
    const order = () => host.store.require(bot.id).threadOrder ?? [];
    const dispatch = (
      thread: ReturnType<typeof makeThreadResponse>,
      blocks: { type: string; text?: string; path?: string; name?: string; mentions?: [] }[],
    ) =>
      host.harness.inspection.registrations.hooks["message.dispatch"]!(
        makeMessageDispatchHookContext({ thread, input: { blocks: blocks as never, text: "" } }),
      );
    return { host, bot, ids, order, dispatch };
  }

  it("joins the continued bot in the continued conversation's place, so a handoff of the main becomes main", async () => {
    const { host, bot, order, dispatch } = await setup();
    const main = order()[0]!;
    const handoff = makeThreadResponse({
      id: "handoff",
      projectId: PERSONAL_ID,
      status: "pending",
      titleFallback: `Continue from @thread:${main}`,
    });
    host.threads.set(handoff.id, handoff);
    await dispatch(handoff, [
      { type: "text", text: `Continue from @thread:${main}\n\nkeep going`, mentions: [] },
    ]);
    expect(host.store.owner("handoff")).toBe(bot.id);
    expect(order().slice(0, 2)).toEqual(["handoff", main]);
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: handoff.id },
        project: { id: PERSONAL_ID },
      }),
    );
    expect(config.instructions).toContain("You are Atlas.");
  });

  it("adopts at creation from the fallback title and handles the handoff plugin's attachment", async () => {
    const { host, bot, ids, order, dispatch } = await setup();
    const created = makeThreadResponse({
      id: "native",
      projectId: PERSONAL_ID,
      titleFallback: `Continue from @thread:${ids[0]}`,
    });
    host.threads.set(created.id, created);
    await host.harness.behavior.emitThreadEvent("thread.created", { thread: created });
    expect(host.store.owner("native")).toBe(bot.id);
    const plugin = makeThreadResponse({
      id: "plugin",
      projectId: PERSONAL_ID,
      status: "pending",
      originPluginId: "handoff",
    });
    host.threads.set(plugin.id, plugin);
    await dispatch(plugin, [
      { type: "text", text: "You are continuing YOUR OWN session" },
      {
        type: "localFile",
        path: `handoff-${ids[1]}-1788792949255-1788792949258-x.md`,
        name: `handoff-${ids[1]}-1788792949255.md`,
      },
    ]);
    expect(host.store.owner("plugin")).toBe(bot.id);
    expect(order().indexOf("plugin")).toBe(order().indexOf(ids[1]!) - 1);
  });

  it("ignores later mentions, running threads, and handoffs of unassigned chats", async () => {
    const { host, ids, dispatch } = await setup();
    const running = makeThreadResponse({ id: "running", projectId: PERSONAL_ID, status: "idle" });
    host.threads.set(running.id, running);
    await dispatch(running, [{ type: "text", text: `Continue from @thread:${ids[0]}` }]);
    expect(host.store.owner("running")).toBeNull();
    host.threads.set("chat", makeThreadResponse({ id: "chat", projectId: PERSONAL_ID }));
    const fromChat = makeThreadResponse({
      id: "from-chat",
      projectId: PERSONAL_ID,
      status: "pending",
    });
    host.threads.set(fromChat.id, fromChat);
    await dispatch(fromChat, [{ type: "text", text: "Continue from @thread:chat" }]);
    expect(host.store.owner("from-chat")).toBeNull();
  });
});
