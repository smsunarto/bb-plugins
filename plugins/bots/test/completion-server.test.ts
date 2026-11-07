import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend, PERSONAL_ID, request } from "./backend-fixture";

const DAY = 24 * 60 * 60 * 1000;
const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

async function setup() {
  const host = await backend();
  instances.push(host);
  const bot = await host.create();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (
        (await host.harness.behavior.callRpc("conversation_create", {
          botId: bot.id,
          request: request(PERSONAL_ID),
        })) as { threadId: string }
      ).threadId,
    );
  // Make every conversation four days idle; the newest-created is first (main).
  const old = Date.now() - 4 * DAY;
  ids.forEach((id, index) =>
    host.threads.set(id, {
      ...host.threads.get(id)!,
      createdAt: old + index,
      updatedAt: old + index,
      latestAttentionAt: old + index,
    }),
  );
  host.threads.set(
    "unassigned",
    makeThreadResponse({
      id: "unassigned",
      projectId: PERSONAL_ID,
      createdAt: old,
      updatedAt: old,
      latestAttentionAt: old,
    }),
  );
  const archived: string[] = [];
  host.harness.inspection.sdk.stub(
    "threads.archive",
    async ({ threadId }: { threadId: string }) => {
      archived.push(threadId);
      const row = host.threads.get(threadId)!;
      host.threads.set(threadId, { ...row, archivedAt: Date.now() });
      return row;
    },
  );
  const completions = async () =>
    (
      (await host.harness.behavior.callRpc("bots_list", {})) as {
        completions: { threadId: string }[];
      }
    ).completions
      .map((row) => row.threadId)
      .sort();
  return { host, bot, ids, main: ids[2]!, archived, completions };
}

describe("automatic completion", () => {
  it("completes idle bot conversations on schedule, except the main one and unassigned chats", async () => {
    const { host, ids, main, completions } = await setup();
    await host.harness.behavior.runSchedule("auto-complete");
    expect(await completions()).toEqual(ids.filter((id) => id !== main).sort());
  });

  it("reopens a completed conversation when it becomes active", async () => {
    const { host, ids, completions } = await setup();
    await host.harness.behavior.callRpc("conversation_complete", {
      threadId: ids[0],
      completed: true,
    });
    expect(await completions()).toEqual([ids[0]]);
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: host.threads.get(ids[0]!)!,
    });
    expect(await completions()).toEqual([]);
    // The idle clock restarted, so the next pass does not complete it again.
    await host.harness.behavior.runSchedule("auto-complete");
    expect(await completions()).not.toContain(ids[0]);
  });

  it("honours the settings: disabled auto-complete and immediate auto-archive", async () => {
    const { host, main, ids, archived, completions } = await setup();
    await host.harness.behavior.setSettings({ autoComplete: false });
    await host.harness.behavior.runSchedule("auto-complete");
    expect(await completions()).toEqual([]);
    await host.harness.behavior.setSettings({
      autoComplete: true,
      autoArchive: true,
      autoArchiveAfterDays: 0,
    });
    await host.harness.behavior.runSchedule("auto-complete");
    expect(archived.sort()).toEqual(ids.filter((id) => id !== main).sort());
    expect(archived).not.toContain(main);
  });

  it("only completes bot conversations, including their children", async () => {
    const { host, ids, completions } = await setup();
    await expect(
      host.harness.behavior.callRpc("conversation_complete", {
        threadId: "unassigned",
        completed: true,
      }),
    ).rejects.toThrow(/Only bot conversations/);
    host.threads.set(
      "child",
      makeThreadResponse({
        id: "child",
        projectId: PERSONAL_ID,
        parentThreadId: ids[0]!,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        latestAttentionAt: Date.now(),
      }),
    );
    await host.harness.behavior.callRpc("conversation_complete", {
      threadId: ids[0],
      completed: true,
    });
    expect(await completions()).toEqual(["child", ids[0]].sort());
  });

  it("skips a completed first conversation when choosing the bot's default recipient", async () => {
    const { host, bot, ids, main } = await setup();
    await host.harness.behavior.callRpc("conversation_complete", {
      threadId: main,
      completed: true,
    });
    const listed = await host.harness.behavior.runCli(["list", "--json"]);
    const entry = (
      JSON.parse(listed.stdout) as { bots: { id: string; mainThreadId: string | null }[] }
    ).bots.find((row) => row.id === bot.id);
    expect(entry?.mainThreadId).toBe(ids[1]);
  });
});
