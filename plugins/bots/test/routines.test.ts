import { afterEach, describe, expect, it } from "vitest";
import type { RoutineView } from "../lib/routine-schema";
import { ROUTINE_SCRIPT } from "../lib/routines";
import { backend, PERSONAL_ID, project, request } from "./backend-fixture";

const instances: Awaited<ReturnType<typeof backend>>[] = [];
async function setup() {
  const host = await backend([project(), project("other")]);
  instances.push(host);
  return host;
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});
const fields = {
  name: "Morning brief",
  instruction: "Summarize new support tickets.",
  cron: "0 9 * * 1-5",
  timezone: "America/Los_Angeles",
  projectId: "project",
};
const asJSON = (value: unknown) => JSON.parse(value as string);

async function withRoutine() {
  const host = await setup();
  const bot = await host.create();
  const routine = (await host.harness.behavior.callRpc("routine_save", {
    botId: bot.id,
    ...fields,
  })) as RoutineView;
  return { host, bot, routine };
}

describe("routines", () => {
  it("schedules a routine as a script automation that hands the run back to Bots", async () => {
    const { host, routine } = await withRoutine();
    const [automation] = host.automations.rows.values();
    expect(routine.automationId).toBe(automation!.id);
    expect(automation).toMatchObject({
      projectId: "project",
      name: "Atlas · Morning brief",
      trigger: { triggerType: "schedule", cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
      execution: { script: ROUTINE_SCRIPT, env: { BB_BOT_ROUTINE_ID: routine.id } },
    });
    expect(routine.automation).toMatchObject({ enabled: true });
    expect(routine.threadId).toBeNull();
  });

  it("rejects unknown timezones and projects the bot is not linked to", async () => {
    const host = await setup();
    const bot = await host.create();
    await expect(
      host.harness.behavior.callRpc("routine_save", {
        botId: bot.id,
        ...fields,
        timezone: "Mars/Base",
      }),
    ).rejects.toThrow(/Unknown timezone/);
    await expect(
      host.harness.behavior.callRpc("routine_save", {
        botId: bot.id,
        ...fields,
        projectId: "other",
      }),
    ).rejects.toThrow(/linked projects/);
    expect(host.automations.rows.size).toBe(0);
  });

  it("stores nothing when Automations is unavailable, and reports it on read", async () => {
    const { host, bot } = await withRoutine();
    host.automations.setUnavailable(true);
    await expect(
      host.harness.behavior.callRpc("routine_save", { botId: bot.id, ...fields, name: "Second" }),
    ).rejects.toThrow(/not running/);
    const listed = (await host.harness.behavior.callRpc("routines_list", { botId: bot.id })) as {
      routines: RoutineView[];
    };
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]!.automation).toBeNull();
    expect(listed.routines[0]!.automationError).toMatch(/unavailable/);
  });

  it("starts the routine's conversation on the first run, then reuses it", async () => {
    const { host, bot, routine } = await withRoutine();
    const first = asJSON(
      (await host.harness.behavior.runCli(["routines", "fire", routine.id, "--json"])).stdout,
    );
    expect(first.delivery).toBe("started");
    const thread = host.threads.get(first.threadId)!;
    expect(thread.projectId).toBe("project");
    const bound = (await host.harness.behavior.callRpc("thread_bot", {
      threadId: first.threadId,
    })) as {
      botId: string;
    };
    expect(bound.botId).toBe(bot.id);
    // A routine conversation never takes over as the bot's main conversation.
    const main = (await host.harness.behavior.callRpc("conversation_create", {
      botId: bot.id,
      request: request(),
    })) as { threadId: string };
    const listed = (await host.harness.behavior.callRpc("routines_list", { botId: bot.id })) as {
      routines: RoutineView[];
    };
    expect(listed.routines[0]!.threadId).toBe(first.threadId);
    expect(host.store.require(bot.id).mainThreadId).toBe(main.threadId);

    const second = asJSON(
      (await host.harness.behavior.runCli(["routines", "fire", routine.id, "--json"])).stdout,
    );
    expect(second).toMatchObject({ threadId: first.threadId, delivery: "sent" });
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toMatchObject({ threadId: first.threadId, mode: "queue-if-active" });
    expect(host.sent[0]!.text).toContain("Summarize new support tickets.");
    expect(host.sent[0]!.text).toContain(routine.id);
  });

  it("starts a fresh conversation when the old one was archived", async () => {
    const { host, routine } = await withRoutine();
    const first = asJSON(
      (await host.harness.behavior.runCli(["routines", "fire", routine.id, "--json"])).stdout,
    );
    host.threads.set(first.threadId, { ...host.threads.get(first.threadId)!, archivedAt: 5 });
    const next = asJSON(
      (await host.harness.behavior.runCli(["routines", "fire", routine.id, "--json"])).stdout,
    );
    expect(next.delivery).toBe("started");
    expect(next.threadId).not.toBe(first.threadId);
  });

  it("pauses, resumes, tests, edits, and deletes through Automations", async () => {
    const { host, routine } = await withRoutine();
    const act = (action: string) =>
      host.harness.behavior.callRpc("routine_action", {
        routineId: routine.id,
        action,
      }) as Promise<{
        routine: RoutineView | null;
        run: { status: string } | null;
      }>;
    expect((await act("pause")).routine!.automation!.enabled).toBe(false);
    expect((await act("resume")).routine!.automation!.enabled).toBe(true);
    expect((await act("run")).run!.status).toBe("succeeded");
    const runs = (await host.harness.behavior.callRpc("routine_runs", {
      routineId: routine.id,
    })) as {
      runs: unknown[];
    };
    expect(runs.runs).toHaveLength(1);

    const edited = (await host.harness.behavior.callRpc("routine_save", {
      botId: routine.botId,
      routineId: routine.id,
      ...fields,
      cron: "0 8 * * *",
    })) as RoutineView;
    expect(edited.automationId).toBe(routine.automationId);
    expect(host.automations.rows.get(routine.automationId!)!.trigger.cron).toBe("0 8 * * *");

    // Moving projects replaces the automation, since automations belong to one project.
    const moved = (await host.harness.behavior.callRpc("routine_save", {
      botId: routine.botId,
      routineId: routine.id,
      ...fields,
      projectId: PERSONAL_ID,
    })) as RoutineView;
    expect(moved.automationId).not.toBe(routine.automationId);
    expect([...host.automations.rows.keys()]).toEqual([moved.automationId]);
    expect(moved.automation!.enabled).toBe(true);

    expect((await act("delete")).routine).toBeNull();
    expect(host.automations.rows.size).toBe(0);
    const listed = (await host.harness.behavior.callRpc("routines_list", {
      botId: routine.botId,
    })) as {
      routines: unknown[];
    };
    expect(listed.routines).toHaveLength(0);
  });

  it("lets a bot's conversation manage only its own routines", async () => {
    const host = await setup();
    const atlas = await host.create("Atlas");
    const nova = await host.create("Nova");
    const conversation = (await host.harness.behavior.callRpc("conversation_create", {
      botId: atlas.id,
      request: request(),
    })) as { threadId: string };
    const ctx = { threadId: conversation.threadId, projectId: "project" };
    const created = asJSON(
      await host.harness.behavior.callAgentTool(
        "bot_routine_update",
        {
          action: "create",
          name: "Digest",
          instruction: "Post a digest.",
          cron: "0 * * * *",
          timezone: "UTC",
        },
        ctx,
      ),
    ) as RoutineView;
    expect(created).toMatchObject({ botId: atlas.id, projectId: "project" });
    expect(host.automations.rows.get(created.automationId!)!.createdByThreadId).toBe(
      conversation.threadId,
    );
    await expect(
      host.harness.behavior.callAgentTool(
        "bot_routine_update",
        { action: "create", name: "No schedule" },
        ctx,
      ),
    ).rejects.toThrow(/needs instruction, cron, timezone/);

    const listed = asJSON(await host.harness.behavior.callAgentTool("bot_routine_list", {}, ctx));
    expect(listed.routines.map((routine: RoutineView) => routine.id)).toEqual([created.id]);

    const other = (await host.harness.behavior.callRpc("routine_save", {
      botId: nova.id,
      ...fields,
    })) as RoutineView;
    await expect(
      host.harness.behavior.callAgentTool(
        "bot_routine_update",
        { action: "delete", routineId: other.id },
        ctx,
      ),
    ).rejects.toThrow(/another bot/);
  });

  it("caps routines per bot", async () => {
    const { host, bot } = await withRoutine();
    for (let index = 1; index < 50; index++)
      await host.harness.behavior.callRpc("routine_save", {
        botId: bot.id,
        ...fields,
        name: `R${index}`,
      });
    await expect(
      host.harness.behavior.callRpc("routine_save", { botId: bot.id, ...fields, name: "R50" }),
    ).rejects.toThrow(/at most 50/);
  });

  it("moves a paused routine to a new project paused, with a new conversation there", async () => {
    const { host, bot, routine } = await withRoutine();
    const fire = async () =>
      asJSON(
        (await host.harness.behavior.runCli(["routines", "fire", routine.id, "--json"])).stdout,
      );
    const first = await fire();
    await host.harness.behavior.callRpc("routine_action", {
      routineId: routine.id,
      action: "pause",
    });
    const moved = (await host.harness.behavior.callRpc("routine_save", {
      botId: bot.id,
      routineId: routine.id,
      ...fields,
      projectId: PERSONAL_ID,
    })) as RoutineView;
    expect(moved.automation!.enabled).toBe(false);
    expect(moved.threadId).toBeNull();
    expect([...host.automations.rows.keys()]).toEqual([moved.automationId]);
    const next = await fire();
    expect(next.delivery).toBe("started");
    expect(next.threadId).not.toBe(first.threadId);
    expect(host.threads.get(next.threadId)!.projectId).toBe(PERSONAL_ID);
  });

  it("schedules a routine again when its automation was deleted outside Bots", async () => {
    const { host, bot, routine } = await withRoutine();
    host.automations.rows.delete(routine.automationId!);
    const broken = (await host.harness.behavior.callRpc("routines_list", { botId: bot.id })) as {
      routines: RoutineView[];
    };
    expect(broken.routines[0]!.automationError).toMatch(/deleted/);
    const repaired = (await host.harness.behavior.callRpc("routine_save", {
      botId: bot.id,
      routineId: routine.id,
      ...fields,
    })) as RoutineView;
    expect(repaired.automationId).not.toBe(routine.automationId);
    expect(repaired.automation!.enabled).toBe(true);
    expect(host.automations.rows.size).toBe(1);
  });

  it("refuses runs from a stale automation or an unlinked project", async () => {
    const { host, bot, routine } = await withRoutine();
    const fire = (...extra: string[]) =>
      host.harness.behavior.runCli(["routines", "fire", routine.id, ...extra]);
    const stale = await fire("--automation", "auto-stale");
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toMatch(/no longer schedules/);
    expect((await fire("--automation", routine.automationId!)).exitCode).toBe(0);
    await host.harness.behavior.callRpc("state_apply", {
      botId: bot.id,
      change: { target: "project", action: "leave", projectId: "project" },
    });
    const unlinked = await fire();
    expect(unlinked.exitCode).not.toBe(0);
    expect(unlinked.stderr).toMatch(/no longer linked/);
    expect(host.store.require(bot.id).linkedProjectIds).not.toContain("project");
  });
});
