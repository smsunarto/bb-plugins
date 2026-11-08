import { afterEach, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { RoutineView } from "../lib/routine-schema";
import { backend, project, request } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

const fields = {
  name: "Morning brief",
  instruction: "Summarize new support tickets.",
  cron: "0 9 * * 1-5",
  timezone: "America/Los_Angeles",
  projectId: "project",
};
const MODELS = {
  modelLoadError: null,
  models: [
    {
      id: "opus",
      model: "claude-opus-5-5",
      displayName: "Opus 5.5",
      description: "",
      isDefault: true,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "high", description: "" },
        { reasoningEffort: "xhigh", description: "" },
      ],
    },
  ],
};

async function scope() {
  const host = await backend([project()]);
  hosts.push(host);
  host.harness.inspection.sdk.stub("providers.models", async () => MODELS as never);
  const conversation = async (name: string, builtin = false) => {
    const bot = await host.create(name);
    if (builtin) host.store.mutate(bot.id, (current) => ({ ...current, builtin: "dr-bot" }));
    const { threadId } = (await host.harness.behavior.callRpc("conversation_create", {
      botId: bot.id,
      request: request(),
    })) as { threadId: string };
    const call = async (tool: string, input: unknown) =>
      JSON.parse(
        String(
          await host.harness.behavior.callAgentTool(tool, input, {
            threadId,
            projectId: "project",
          }),
        ),
      );
    return { bot, threadId, call };
  };
  const fire = async (routineId: string) =>
    JSON.parse(
      (await host.harness.behavior.runCli(["routines", "fire", routineId, "--json"])).stdout!,
    ) as { threadId: string; delivery: string };
  return { host, conversation, fire };
}

it("lets Dr. Bot read and change another bot, and read every bot at once", async () => {
  const { host, conversation } = await scope();
  const doctor = await conversation("Dr. Bot", true);
  const vega = await conversation("Vega");

  const identity = await doctor.call("bot_read_state", { target: "identity", bot: "vega" });
  expect(identity).toMatchObject({ botId: vega.bot.id });
  await doctor.call("bot_update_state", {
    bot: vega.bot.id,
    target: "settings",
    action: "set",
    values: { tone: "brief" },
  });
  expect((await vega.call("bot_read_state", { target: "settings" })).state.values).toMatchObject({
    tone: "brief",
  });

  const all = await doctor.call("bot_read_state", { target: "identity", bot: "*" });
  expect(all.bots.map((entry: { botId: string }) => entry.botId).sort()).toEqual(
    host.store
      .list()
      .map((bot) => bot.id)
      .sort(),
  );

  const created = (await doctor.call("bot_routine_update", {
    bot: "Vega",
    action: "create",
    ...fields,
  })) as RoutineView;
  expect(created.botId).toBe(vega.bot.id);
  expect(
    (await doctor.call("bot_routine_list", { bot: "Vega" })).routines.map(
      (routine: RoutineView) => routine.id,
    ),
  ).toEqual([created.id]);
  await doctor.call("bot_skill_update", {
    bot: "Vega",
    action: "write",
    name: "triage",
    content: "---\nname: triage\ndescription: Use when triaging.\n---\n\nSteps.\n",
  });
  expect((await vega.call("bot_skill_read", {})).skills).toEqual([
    { name: "triage", description: "Use when triaging." },
  ]);
});

it("keeps other bots scoped to themselves", async () => {
  const { conversation } = await scope();
  await conversation("Dr. Bot", true);
  const atlas = await conversation("Atlas");
  const vega = await conversation("Vega");

  for (const [tool, input] of [
    ["bot_read_state", { target: "identity", bot: "Vega" }],
    ["bot_read_state", { target: "identity", bot: "*" }],
    ["bot_routine_list", { bot: vega.bot.id }],
    ["bot_skill_read", { bot: "Vega" }],
  ] as const)
    await expect(atlas.call(tool, input)).rejects.toThrow(/Only Dr. Bot/);
  // Naming itself is allowed.
  expect(await atlas.call("bot_read_state", { target: "identity", bot: "Atlas" })).toMatchObject({
    botId: atlas.bot.id,
  });
});

it("starts a new subthread every run when threadMode is new, and reuses one by default", async () => {
  const { host, fire } = await scope();
  const bot = await host.create();
  const reuse = (await host.harness.behavior.callRpc("routine_save", {
    botId: bot.id,
    ...fields,
  })) as RoutineView;
  expect(reuse.threadMode).toBe("reuse");
  const fresh = (await host.harness.behavior.callRpc("routine_save", {
    botId: bot.id,
    ...fields,
    name: "Hourly scan",
    threadMode: "new",
  })) as RoutineView;

  const [a, b] = [await fire(reuse.id), await fire(reuse.id)];
  expect(b).toMatchObject({ threadId: a.threadId, delivery: "sent" });
  const [c, d] = [await fire(fresh.id), await fire(fresh.id)];
  expect(c.delivery).toBe("started");
  expect(d.delivery).toBe("started");
  expect(d.threadId).not.toBe(c.threadId);
});

it("runs a routine on its own model, validated against the bot's machine", async () => {
  const { host, fire } = await scope();
  const bot = await host.create();
  const execution = {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
  };
  await expect(
    host.harness.behavior.callRpc("routine_save", {
      botId: bot.id,
      ...fields,
      execution: { ...execution, model: "astra" },
    }),
  ).rejects.toThrow(/no model astra/);
  await expect(
    host.harness.behavior.callRpc("routine_save", {
      botId: bot.id,
      ...fields,
      execution: { ...execution, reasoningLevel: "max" },
    }),
  ).rejects.toThrow(/does not support reasoningLevel max/);

  const routine = (await host.harness.behavior.callRpc("routine_save", {
    botId: bot.id,
    ...fields,
  })) as RoutineView;
  const first = await fire(routine.id);
  const updated = (await host.harness.behavior.callRpc("routine_save", {
    botId: bot.id,
    routineId: routine.id,
    ...fields,
    execution,
  })) as RoutineView;
  expect(updated).toMatchObject({ execution, threadId: null });

  const second = await fire(routine.id);
  expect(second.threadId).not.toBe(first.threadId);
  const spawn = host.harness.inspection.sdk
    .callsTo("threads.spawn")
    .map(([args]) => args as { providerId?: string; model?: string; reasoningLevel?: string })
    .at(-1);
  expect(spawn).toMatchObject(execution);
});

it("reports each routine's latest run from its conversation", async () => {
  const { host, conversation, fire } = await scope();
  const atlas = await conversation("Atlas");
  const routine = (await atlas.call("bot_routine_update", {
    action: "create",
    ...fields,
  })) as RoutineView;
  expect((await atlas.call("bot_routine_list", {})).routines[0].lastRun).toBeNull();

  const { threadId } = await fire(routine.id);
  host.threads.set(threadId, {
    ...host.threads.get(threadId)!,
    runtime: makeThreadResponse({ id: threadId }).runtime,
  });
  host.harness.inspection.sdk.stub(
    "threads.output",
    async () =>
      ({
        output: "BLOCKED: the Discord token is missing.",
      }) as never,
  );

  const [listed] = (await atlas.call("bot_routine_list", {})).routines;
  expect(listed.lastRun).toMatchObject({
    threadId,
    reply: "BLOCKED: the Discord token is missing.",
  });
});

it("tells each bot its home folder and main chats how to delegate, within the prompt budget", async () => {
  const { host } = await scope();
  const bot = await host.create("Atlas");
  host.store.mutate(bot.id, (current) => ({ ...current, builtin: "dr-bot" }));
  const { botInstructions } = await import("../lib/bot-instructions");
  const home = { path: "~/bb-bots/atlas-123", hostId: "host-home" };

  const short = botInstructions(host.store.require(bot.id), undefined, true, home);
  expect(short).toContain("`~/bb-bots/atlas-123` on machine host-home");
  expect(short).toContain('--parent-self --project "$BB_PROJECT_ID"');

  // Dr. Bot's main chat in another bot's project, with full memory and SOUL.
  const full = botInstructions(
    {
      ...host.store.require(bot.id),
      name: "n".repeat(120),
      soul: "s".repeat(4000),
      memory: "m".repeat(3000),
    },
    {
      id: '"'.repeat(80),
      name: '"'.repeat(100),
      role: "unjoined",
      ownerBotId: '"'.repeat(80),
      ownerName: '"'.repeat(120),
    },
    true,
    home,
  );
  expect(full.length).toBeLessThanOrEqual(4096);
  expect(full).toContain("`data/` folder");
  expect(full).toContain("use bot_read_state for complete state");
});

it("does not show a run reply from a conversation moved to another bot", async () => {
  const { host, conversation, fire } = await scope();
  const atlas = await conversation("Atlas");
  const vega = await conversation("Vega");
  const routine = (await atlas.call("bot_routine_update", {
    action: "create",
    ...fields,
  })) as RoutineView;
  const { threadId } = await fire(routine.id);
  host.harness.inspection.sdk.stub("threads.output", async () => ({ output: "secret" }) as never);
  await host.harness.behavior.callRpc("conversation_set_bot", { threadId, botId: vega.bot.id });

  const [listed] = (await atlas.call("bot_routine_list", {})).routines;
  expect(listed.lastRun).toMatchObject({ threadId, status: "reassigned", reply: null });
});
