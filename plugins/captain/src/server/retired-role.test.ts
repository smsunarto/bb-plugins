import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { describe, expect, test } from "vitest";
import { captainHost, newCaptain } from "./test-host.ts";

/**
 * Data written before the Plan role was removed: a crew row, a fallback, a
 * served spec and a saved ladder that name `plan`, and Tasks rows attached
 * through the `Plan` and `Captain Plan · 2` presets. Each reads as no role.
 */
async function retiredHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addTask("BBPLUGINS-2", { title: "Split the sidebar" });
  host.addTask("BBPLUGINS-3", { title: "Old rung" });
  const as = (argv: string[]) => host.harness.behavior.runCli(argv, { threadId: captainId });
  const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const db = () => host.bb.storage.database();
  return { host, captainId, as, rpc, db };
}

/** Dispatch Implement, then rewrite its records as a Plan thread's, with the given preset. */
async function planThread(
  ctx: Awaited<ReturnType<typeof retiredHost>>,
  key: string,
  presetName: string,
): Promise<string> {
  const { host, captainId, as, db } = ctx;
  const result = await as(["dispatch", key, "--role", "Implement", "--json"]);
  if (result.exitCode !== 0) throw new Error(result.stdout);
  const thread =
    (JSON.parse(result.stdout) as { results: { thread: string }[] }).results[0]?.thread ?? "";
  const task = host.tasks.tasks.find((entry) => entry.key === key);
  if (task === undefined) throw new Error(`no task ${key}`);
  host.attach(task.id, thread, presetName);
  const spec = JSON.stringify({ kind: "crew", captain: captainId, drive: null, role: "plan" });
  db().prepare("UPDATE crew_roles SET role = 'plan' WHERE thread_id = ?").run(thread);
  db()
    .prepare(
      `INSERT INTO served_instructions (thread_id, captain_id, spec, text, fingerprint, served_at)
       VALUES (?, ?, ?, '# Role: Plan', 'old', 1) ON CONFLICT (thread_id) DO UPDATE SET spec = excluded.spec`,
    )
    .run(thread, captainId, spec);
  host.updateThread(thread, { status: "idle" });
  return thread;
}

function line(stdout: string, thread: string): string {
  return stdout.split("\n").find((entry) => entry.includes(thread)) ?? "";
}

describe("a retired Plan role in stored data", () => {
  test("status, check and the banner read a plan crew row as a thread with no role", async () => {
    const ctx = await retiredHost();
    const { host, captainId, as, rpc } = ctx;
    const planned = await planThread(ctx, "BBPLUGINS-2", "Plan");
    const rung = await planThread(ctx, "BBPLUGINS-3", "Captain Plan · 2");
    host.addThread({ id: "thr_failed", status: "error", parentThreadId: captainId });
    host.bb.storage
      .database()
      .prepare(
        `INSERT INTO fallbacks (failed_thread_id, captain_id, task_id, task_key, role, from_rung,
           from_label, to_rung, to_label, base_branch, skipped, created_at)
         VALUES ('thr_failed', ?, 'task_x', 'BBPLUGINS-2', 'plan', 1, 'claude-code x high', 2,
           'codex y high', NULL, '[]', 1)`,
      )
      .run(captainId);

    expect(host.server.store.crewRole(planned)).toBeNull();
    expect(host.server.store.fallback("thr_failed")).toBeNull();

    // Old presets alone: one thread has no crew row at all, only its `Captain Plan · 2` attachment.
    host.bb.storage.database().prepare("DELETE FROM crew_roles WHERE thread_id = ?").run(rung);
    host.updateThread(planned, { hasPendingInteraction: true });
    host.interactions.set(planned, [
      {
        id: "int_plan",
        threadId: planned,
        status: "pending",
        createdAt: 1_000,
        payload: { kind: "plugin", title: "secrets request: TOKEN", data: null },
      },
    ]);

    const status = await as(["status", "--all"]);
    expect(status.exitCode).toBe(0);
    expect(line(status.stdout, planned)).toContain("BBPLUGINS-2");
    expect(line(status.stdout, rung)).toContain("BBPLUGINS-3");
    expect(line(status.stdout, planned)).not.toContain("Plan");
    expect(line(status.stdout, rung)).not.toContain("Plan");

    const before = host.sent.length;
    host.setNow(host.now() + 60 * 60_000);
    const passes = [await host.server.check.pass(), await host.server.check.pass()];
    expect(passes.map((pass) => pass.skipped)).toEqual([[], []]);
    // No stall wake, no instruction-change message, no fallback restart; and no row backfilled.
    expect(host.sent.slice(before)).toEqual([]);
    expect(host.server.store.crewRole(planned)).toBeNull();
    expect(host.server.store.hasCrewRow(rung)).toBe(false);

    const crew = (await rpc("crew", { captainId })) as { items: Record<string, unknown>[] };
    expect(crew.items).toContainEqual(
      expect.objectContaining({
        kind: "blocked",
        threadId: planned,
        task: "BBPLUGINS-2",
        role: null,
      }),
    );
  });

  test("a plan crew row's session gets no role contract, even while a dispatch is pending", async () => {
    const ctx = await retiredHost();
    const { host, captainId, as } = ctx;
    const planned = await planThread(ctx, "BBPLUGINS-2", "Plan");
    const sessions: (string | null | undefined)[] = [];
    host.tasks.onSpawn = async () => {
      const resolved = await host.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: planned, parentThreadId: captainId },
        }),
      );
      sessions.push(resolved.instructions);
    };

    const dispatched = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);

    expect(dispatched.exitCode).toBe(0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toContain("# Role:");
  });

  test("an old Plan child with no crew row, only its Plan attachment, gets no Implement contract", async () => {
    const ctx = await retiredHost();
    const { host, captainId, as, db } = ctx;
    const planned = await planThread(ctx, "BBPLUGINS-2", "Plan");
    db().prepare("DELETE FROM crew_roles WHERE thread_id = ?").run(planned);
    const sessions: (string | null | undefined)[] = [];
    host.tasks.onSpawn = async () => {
      const resolved = await host.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: planned, parentThreadId: captainId },
        }),
      );
      sessions.push(resolved.instructions);
    };

    const dispatched = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);

    expect(dispatched.exitCode).toBe(0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toContain("# Role:");
  });

  test("an active child with a stored Plan row is not read again for a backfill", async () => {
    const ctx = await retiredHost();
    const { host } = ctx;
    const planned = await planThread(ctx, "BBPLUGINS-2", "Plan");
    host.updateThread(planned, { status: "active" });
    const snapshots = () =>
      host.tasks.calls.filter(
        (call) => call.method === "crewSnapshot" && JSON.stringify(call.input).includes(planned),
      ).length;
    const before = snapshots();

    const passes = [await host.server.check.pass(), await host.server.check.pass()];

    expect(passes.map((pass) => pass.skipped)).toEqual([[], []]);
    expect(snapshots()).toBe(before);
    expect(host.server.store.hasCrewRow(planned)).toBe(true);
    expect(host.server.store.crewRole(planned)).toBeNull();
  });

  test("a saved Plan ladder is ignored by the ladders read and leaves the others editable", async () => {
    const { host, rpc } = await retiredHost();
    host.server.store.setLadderJson(
      "plan",
      JSON.stringify([{ providerId: "codex", model: "gpt-6-astra", reasoningLevel: "xhigh" }]),
      1,
    );

    const read = (await rpc("ladders", {})) as { roles: { role: string; label: string }[] };
    expect(read.roles.map((role) => role.role)).toEqual(["implement", "review"]);
    await expect(
      rpc("setLadder", {
        role: "implement",
        rungs: [{ providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" }],
      }),
    ).resolves.toMatchObject({ role: "implement", custom: true });
    await expect(rpc("setLadder", { role: "plan", rungs: null })).rejects.toThrow();
  });

  test("dispatch --role Plan is refused and points to Implement", async () => {
    const { host, as } = await retiredHost();
    const spawnsBefore = host.tasks.calls.filter((call) => call.method === "delegate").length;

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Plan", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).blockers).toEqual([
      {
        reason: "the Plan role is gone; Implement plans before it builds",
        fix: 'pass --role Implement; for research or design only, say "no code" in the brief',
      },
    ]);
    expect(host.tasks.calls.filter((call) => call.method === "delegate").length).toBe(spawnsBefore);
  });
});
