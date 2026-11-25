import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { captainHost, newCaptain, type CaptainHost, type FakeOptions } from "./test-host.ts";

const run = (host: CaptainHost, argv: string[], threadId?: string) =>
  host.harness.behavior.runCli(argv, threadId === undefined ? {} : { threadId });

type Json = {
  ok: boolean;
  results: Record<string, unknown>[];
  blockers: { reason: string; fix: string }[];
};
const json = (stdout: string) => JSON.parse(stdout) as Json;

/** The crew thread the fake Tasks spawned last. */
const lastSpawned = (host: CaptainHost) =>
  [...host.threads.keys()].findLast((id) => id.startsWith("thr_crew")) ?? "";

const delegates = (host: CaptainHost) =>
  host.tasks.calls.filter((call) => call.method === "delegate").map((call) => call.input);

/** A Captain over bb-plugins (Tasks key BBPLUGINS) with two tasks, and its presets created by `new`. */
async function crewHost(options: FakeOptions = {}) {
  const host = await captainHost(options);
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.addTask("BBPLUGINS-2", { title: "Fix the sidebar" });
  host.pushes.length = 0;
  const as = (argv: string[]) => run(host, argv, captainId);
  return { host, captainId, as };
}

/** Dispatch one role and return the new thread id. */
async function dispatched(
  as: (argv: string[]) => ReturnType<typeof run>,
  key: string,
  role: string,
) {
  const result = await as(["dispatch", key, "--role", role, "--json"]);
  if (result.exitCode !== 0) throw new Error(`dispatch failed: ${result.stdout}${result.stderr}`);
  return String(json(result.stdout).results[0]?.["thread"]);
}

describe("bb captain dispatch", () => {
  test("spawns through Tasks with the Captain as parent, stuck, the role's preset, report contract and role contract", async () => {
    const { host, captainId, as } = await crewHost();
    const result = await as(["dispatch", "bbplugins-1", "--role", "Implement"]);
    const implement = host.tasks.presets.find((preset) => preset.name === "Captain Implement · 1");

    expect(result.exitCode).toBe(0);
    const [key, threadId, role, state] = result.stdout.trim().split(/\s{2,}/u);
    expect([key, role, state]).toEqual(["BBPLUGINS-1", "Implement", "started"]);
    expect(delegates(host)).toEqual([
      {
        taskId: host.tasks.tasks[0]?.id,
        presetId: implement?.id,
        parentThreadId: captainId,
        senderThreadId: captainId,
        parentNotifications: "stuck",
        reportContract: expect.stringContaining("--notify-parent"),
        extraInstructions: expect.stringContaining("# Role: Implement"),
      },
    ]);
    expect(host.server.store.crewRole(threadId ?? "")).toEqual({
      threadId,
      captainId,
      role: "implement",
      reportDueSince: host.now(),
      contractSent: true,
      rung: 1,
      baseBranch: null,
    });
    expect(host.pushes).toEqual([
      { method: "threadNotifications.set", input: { threadId, level: "input-only" } },
    ]);
  });

  test("a Tasks that refuses senderThreadId still starts the thread: one retry without it", async () => {
    const { host, captainId, as } = await crewHost();
    host.tasks.delegateMode = "no-sender";

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(json(result.stdout).results[0]).toMatchObject({
      state: "started",
      thread: lastSpawned(host),
    });
    const [first, retry] = delegates(host);
    expect(delegates(host)).toHaveLength(2);
    expect(first).toMatchObject({ parentThreadId: captainId, senderThreadId: captainId });
    expect(retry).toEqual({ ...(first as object), senderThreadId: undefined });
    expect(retry).not.toHaveProperty("senderThreadId");
    expect([...host.threads.keys()].filter((id) => id.startsWith("thr_crew"))).toHaveLength(1);
  });

  test("any other Tasks refusal is not retried", async () => {
    const { host, as } = await crewHost();
    host.tasks.delegateMode = "refuse";

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout).results[0]).toMatchObject({ state: "failed" });
    expect(delegates(host)).toHaveLength(1);
  });

  test("crew stay agent-facing: neither dispatch nor a reload marks them for GenUI", async () => {
    const { host, captainId, as } = await crewHost();
    const crewId = await dispatched(as, "BBPLUGINS-1", "Implement");

    await host.reload();

    expect(host.metadata.has(`${crewId} genui`)).toBe(false);
    expect(host.metadata.has(`${captainId} genui`)).toBe(true);
    const marked = host.harness.inspection.sdk
      .callsTo("threads.updatePluginMetadata")
      .map(([args]) => (args as { threadId: string }).threadId);
    expect(marked).not.toContain(crewId);
  });

  test("checks every task before spawning: one bad key starts nothing", async () => {
    const { host, as } = await crewHost({
      tasksProjects: [{ id: "tp_ramp", name: "Rampage", prefix: "RAMP", linkedBbProjectId: null }],
    });
    host.addTask("RAMP-3");

    const result = await as([
      "dispatch",
      "BBPLUGINS-1",
      "BBPLUGINS-9",
      "RAMP-3",
      "--role",
      "Implement",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout).blockers).toEqual([
      { reason: "no task BBPLUGINS-9", fix: "bb tasks list" },
      {
        reason: "RAMP-3 is not in this Captain's repos (BBPLUGINS)",
        fix: "bb captain repo add <project> --tasks RAMP",
      },
    ]);
    expect(delegates(host)).toHaveLength(0);
  });

  test("refuses Implement and Review in one call, and roles that are not dispatched", async () => {
    const { host, as } = await crewHost();

    const both = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement,Review"]);
    const merge = await as(["dispatch", "BBPLUGINS-1", "--role", "Merge"]);

    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("dispatch --role Implement first, then --role Review");
    expect(merge.exitCode).toBe(1);
    expect(merge.stderr).toContain("Merge is not started through dispatch");
    expect(delegates(host)).toHaveLength(0);
  });

  test("Review starts from its Implement thread's worktree branch; --base-branch overrides it", async () => {
    const { host, as } = await crewHost();
    const implementer = await dispatched(as, "BBPLUGINS-1", "Implement");
    const branch = host.threads.get(implementer)?.environmentBranchName;

    const review = await as(["dispatch", "BBPLUGINS-1", "--role", "Review"]);
    const override = await as([
      "dispatch",
      "BBPLUGINS-2",
      "--role",
      "Review",
      "--base-branch",
      "scott/sidebar",
    ]);

    expect(review.exitCode).toBe(0);
    expect(override.exitCode).toBe(0);
    expect(branch).toMatch(/^crew\//u);
    expect(delegates(host).slice(1)).toEqual([
      expect.objectContaining({
        baseBranch: branch,
        extraInstructions: expect.stringContaining("# Role: Review"),
      }),
      expect.objectContaining({ baseBranch: "scott/sidebar" }),
    ]);
  });

  test("refuses Review with no Implement thread, or one in a shared checkout, naming --base-branch", async () => {
    const { host, captainId, as } = await crewHost();
    host.addThread({
      id: "thr_shared",
      parentThreadId: captainId,
      environmentIsWorktree: false,
      environmentBranchName: "gitbutler/workspace",
    });
    host.attach(host.tasks.tasks[1]?.id ?? "", "thr_shared", "Implement");

    const result = await as([
      "dispatch",
      "BBPLUGINS-1",
      "BBPLUGINS-2",
      "--role",
      "Review",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout).results).toEqual([
      expect.objectContaining({
        id: "BBPLUGINS-1",
        state: "refused",
        blockers: [
          {
            reason: "BBPLUGINS-1 has no live Implement thread",
            fix: "bb captain dispatch BBPLUGINS-1 --role Implement first, or bb captain dispatch BBPLUGINS-1 --role Review --base-branch <task branch>",
          },
        ],
      }),
      expect.objectContaining({
        id: "BBPLUGINS-2",
        state: "refused",
        blockers: [
          {
            reason:
              "BBPLUGINS-2's Implement thread thr_shared runs in a shared checkout (gitbutler/workspace), not on its own branch",
            fix: "bb captain dispatch BBPLUGINS-2 --role Review --base-branch <task branch>",
          },
        ],
      }),
    ]);
    expect(delegates(host)).toHaveLength(0);
  });

  test("a rerun reports the live thread as exists; --again starts another", async () => {
    const { host, as } = await crewHost();
    const first = await dispatched(as, "BBPLUGINS-1", "Implement");

    const again = await as(["dispatch", "BBPLUGINS-1", "--role", "implement", "--json"]);
    const forced = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--again",
      "--json",
    ]);

    expect(json(again.stdout).results[0]).toMatchObject({ state: "exists", thread: first });
    expect(json(forced.stdout).results[0]).toMatchObject({ state: "started" });
    expect(delegates(host)).toHaveLength(2);
  });

  test("two dispatches of one task at once start one thread", async () => {
    const { host, as } = await crewHost();

    const [one, two] = await Promise.all([
      as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]),
      as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]),
    ]);

    const states = [one, two].map((result) => json(result.stdout).results[0]?.["state"]);
    expect(states.sort()).toEqual(["exists", "started"]);
    expect(delegates(host)).toHaveLength(1);
  });

  test("on a deadline it finds the thread Tasks started, and records it", async () => {
    const { host, captainId, as } = await crewHost({ tasksDeadlineMs: 50 });
    host.tasks.delegateMode = "hang";

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);

    const spawned = lastSpawned(host);
    expect(result.exitCode).toBe(0);
    expect(json(result.stdout).results[0]).toMatchObject({ state: "started", thread: spawned });
    expect(result.stderr).toContain(`found its new thread ${spawned}`);
    expect(host.server.store.crewRole(spawned)).toMatchObject({ captainId, role: "implement" });
  });

  test("a deadline with no thread on the task yet fails; the retry finds the late thread as exists", async () => {
    const { host, captainId, as } = await crewHost({ tasksDeadlineMs: 50 });
    host.tasks.delegateMode = "hang-unattached";

    const first = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);
    const late = lastSpawned(host);
    const roleAfterFailure = host.server.store.crewRole(late);
    // Tasks attaches the thread after its spawn returned late.
    host.attach(host.tasks.tasks[0]?.id ?? "", late, "Implement");
    host.tasks.delegateMode = "ok";
    const retry = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);

    expect(first.exitCode).toBe(1);
    expect(json(first.stdout).results[0]).toMatchObject({ state: "failed" });
    expect(first.stdout).toContain("a thread that started late reports exists");
    expect(roleAfterFailure).toBeNull();
    expect(json(retry.stdout).results[0]).toMatchObject({ state: "exists", thread: late });
    expect(delegates(host)).toHaveLength(1);
    // The retry backfilled what the failed dispatch never wrote.
    expect(host.server.store.crewRole(late)).toMatchObject({ captainId, role: "implement" });
  });

  test("a session built before Tasks answers gets the pending role; the entry is gone afterwards", async () => {
    const { host, captainId, as } = await crewHost();
    const firstSessions: (string | null | undefined)[] = [];
    host.tasks.onSpawn = async (threadId) => {
      const resolved = await host.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: threadId, parentThreadId: captainId },
        }),
      );
      firstSessions.push(resolved.instructions);
    };

    await dispatched(as, "BBPLUGINS-1", "Implement");
    const stranger = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_other", parentThreadId: captainId },
      }),
    );

    expect(firstSessions).toHaveLength(1);
    expect(firstSessions[0]).toContain("# Role: Implement");
    expect(stranger.instructions).not.toContain("# Role:");
  });

  test("overlapping Review dispatches on two tasks: the first child keeps its contract and lenses", async () => {
    const { host, captainId, as } = await crewHost();
    await dispatched(as, "BBPLUGINS-1", "Implement");
    await dispatched(as, "BBPLUGINS-2", "Implement");
    let first: string | null = null;
    const pending: { second?: ReturnType<typeof as> } = {};
    const firstSessions: { skills: unknown; instructions: string | null | undefined }[] = [];
    host.tasks.onSpawn = async (threadId) => {
      if (first === null) {
        // Review A's child exists, A's delegate has not returned: start Review B now.
        first = threadId;
        pending.second = as(["dispatch", "BBPLUGINS-2", "--role", "Review"]);
        await pending.second;
        return;
      }
      // Inside B's spawn, both dispatches are pending: rebuild A's session.
      const resolved = await host.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { id: first, parentThreadId: captainId } }),
      );
      firstSessions.push({ skills: resolved.skills, instructions: resolved.instructions });
    };

    const a = await as(["dispatch", "BBPLUGINS-1", "--role", "Review"]);

    expect(a.exitCode).toBe(0);
    expect((await pending.second)?.exitCode).toBe(0);
    expect(firstSessions).toHaveLength(1);
    expect(firstSessions[0]?.instructions).toContain("# Role: Review");
    expect(firstSessions[0]?.skills).toEqual(["captain-review-lenses"]);
  });

  test("--dry-run prints the rung, preset, machine and branch and spawns nothing", async () => {
    const { host, as } = await crewHost();

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "BBPLUGINS-1  -  Implement  planned  rung 1 claude-code claude-opus-5-5 high · preset Captain Implement · 1 · machine the repo's source machine · branch the default branch\n",
    );
    expect(delegates(host)).toHaveLength(0);
  });
});

describe("with Tasks unavailable", () => {
  test("dispatch, verdict and status refuse with the fix, and nothing spawns", async () => {
    const { host, as } = await crewHost();
    await dispatched(as, "BBPLUGINS-2", "Implement");
    host.tasks.down = true;

    const results = await Promise.all([
      as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]),
      as(["verdict", "BBPLUGINS-1", "review", "passed"]),
      as(["status"]),
    ]);

    for (const result of results) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("bb plugin enable scott-tasks");
    }
    expect(delegates(host)).toHaveLength(1);
  });

  test("with no crew, status still lists the asks from data.db", async () => {
    const { host, as } = await crewHost();
    await as([
      "ask",
      "Pick an account",
      "--task",
      "BBPLUGINS-1",
      "--option",
      "A",
      "--option",
      "B",
      "--detail",
      "Seats.",
    ]);
    host.tasks.down = true;

    const result = await as(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^1 ask · cursor c_\w+\na1  ask  BBPLUGINS-1  Pick an account  0s\n$/u,
    );
  });
});

describe("bb captain dispatch --thread", () => {
  test("refuses a fork and changes nothing", async () => {
    const { host, as } = await crewHost();
    host.addThread({ id: "thr_fork", originKind: "fork" });

    const result = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--thread",
      "thr_fork",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("thr_fork is a fork");
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
    expect(host.tasks.calls.filter((call) => call.method === "taskThreadsAttach")).toHaveLength(0);
  });

  test("an idle thread gets parent and stuck, the role's preset, and its contract on the first tell", async () => {
    const { host, captainId, as } = await crewHost();
    host.addThread({ id: "thr_old", status: "idle" });

    const adopted = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--thread",
      "thr_old",
      "--json",
    ]);

    expect(adopted.exitCode).toBe(0);
    expect(json(adopted.stdout).results[0]).toMatchObject({
      state: "adopted",
      contractSent: false,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.update")[0]?.[0]).toEqual({
      threadId: "thr_old",
      parentThreadId: captainId,
      parentNotifications: "stuck",
    });
    expect(host.tasks.calls.find((call) => call.method === "taskThreadsAttach")?.input).toEqual({
      taskId: host.tasks.tasks[0]?.id,
      threadId: "thr_old",
      presetName: "Implement",
    });
    expect(host.sent).toEqual([]);
    expect(host.server.store.crewRole("thr_old")).toMatchObject({
      reportDueSince: null,
      contractSent: false,
    });

    host.setNow(9_000);
    await as(["tell", "BBPLUGINS-1", "--message", "Start with the tests."]);
    await as(["tell", "BBPLUGINS-1", "--message", "And the docs."]);

    expect(host.sent.map((message) => message.text.includes("You are now crew"))).toEqual([
      true,
      false,
    ]);
    expect(host.sent[0]?.text).toContain("# Role: Implement");
    expect(host.sent[0]?.text).toMatch(/Start with the tests\.$/u);
    expect(host.server.store.crewRole("thr_old")).toMatchObject({
      reportDueSince: 9_000,
      contractSent: true,
    });
  });

  test("an active thread is steered with its contract at once and owes a report", async () => {
    const { host, captainId, as } = await crewHost();
    host.addThread({ id: "thr_busy", status: "active" });

    const adopted = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Review",
      "--thread",
      "thr_busy",
      "--json",
    ]);

    expect(json(adopted.stdout).results[0]).toMatchObject({ state: "adopted", contractSent: true });
    expect(host.sent).toEqual([
      {
        threadId: "thr_busy",
        text: expect.stringContaining("# Role: Review"),
        mode: "steer-if-active",
        senderThreadId: captainId,
      },
    ]);
    expect(host.server.store.crewRole("thr_busy")).toMatchObject({
      role: "review",
      reportDueSince: host.now(),
      contractSent: true,
    });
    expect(adopted.stderr ?? "").toBe("");
  });

  test("adopting a thread outside full permission mode prints one warning line", async () => {
    const { host, as } = await crewHost();
    host.addThread({ id: "thr_auto", status: "idle" });
    host.permissionModes.set("thr_auto", "auto");

    const adopted = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--thread",
      "thr_auto",
    ]);

    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toContain("adopted");
    expect(adopted.stderr).toBe(
      "warning: thr_auto runs in auto permission mode; Captain tells cannot approve escalations for it\n",
    );
  });
});

describe("bb captain verdict", () => {
  test("the owned fields are defined at startup", async () => {
    const { host } = await crewHost();
    expect([...host.tasks.fieldDefinitions]).toEqual([
      ["review", ["findings", "passed", "skipped"]],
      ["triage", ["reproduced", "not-reproduced", "needs-info", "duplicate", "skipped"]],
    ]);
  });

  test("writes the field with the head it judged and moves a ship-ready task to in_review", async () => {
    const { host, as } = await crewHost();

    const result = await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", "abc123"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("BBPLUGINS-1  recorded  review passed @abc123\n");
    expect(host.tasks.calls.find((call) => call.method === "setField")?.input).toEqual({
      taskId: host.tasks.tasks[0]?.id,
      key: "review",
      value: "passed",
      head: "abc123",
    });
    expect(host.tasks.tasks[0]?.status).toBe("in_review");
  });

  test("findings leave the status alone; skipped needs a reason, posted once as the Captain", async () => {
    const { host, captainId, as } = await crewHost();

    const findings = await as(["verdict", "BBPLUGINS-1", "review", "findings"]);
    const bare = await as(["verdict", "BBPLUGINS-2", "review", "skipped"]);
    await as(["verdict", "BBPLUGINS-2", "review", "skipped", "--reason", "Docs only"]);
    await as(["verdict", "BBPLUGINS-2", "review", "skipped", "--reason", "Docs only"]);

    expect(findings.exitCode).toBe(0);
    expect(host.tasks.tasks[0]?.status).toBe("todo");
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain('--reason "<why>"');
    expect(host.tasks.comments.map((c) => [c.body, c.authorName, c.source, c.threadId])).toEqual([
      ["Verdict: review skipped. Docs only", "Plugins Captain", "agent", captainId],
    ]);
  });

  test("--ship opens the ship ask only after review passed or skipped", async () => {
    const { host, captainId, as } = await crewHost();

    const early = await as(["verdict", "BBPLUGINS-1", "review", "findings", "--ship"]);
    const ship = await as([
      "verdict",
      "BBPLUGINS-1",
      "review",
      "passed",
      "--head",
      "a".repeat(40),
      "--ship",
      "--json",
    ]);

    expect(early.exitCode).toBe(1);
    expect(early.stderr).toContain("BBPLUGINS-1's review is findings");
    const results = json(ship.stdout).results;
    expect(results[1]).toMatchObject({
      id: "a1",
      state: "open",
      kind: "ship",
      task: "BBPLUGINS-1",
      text: "Merge BBPLUGINS-1: Render PR images",
      options: ["Merge", "Hold"],
    });
    // The refused call wrote nothing; the second wrote one field.
    expect(host.tasks.calls.filter((call) => call.method === "setField")).toHaveLength(1);
    expect(host.tasks.comments[0]?.body).toMatch(
      /^Asked: Merge BBPLUGINS-1: Render PR images \(a1\)/u,
    );
    expect(host.tasks.comments[0]?.body).toContain("fast-forward the target branch");
    expect(host.pushes).toEqual([
      {
        method: "notifications.send",
        input: {
          title: "Merge BBPLUGINS-1: Render PR images",
          body: "Plugins Captain · BBPLUGINS-1 · ship",
          threadId: captainId,
        },
      },
    ]);
  });

  test("a review verdict without --ship supersedes a ship ask for another head or a failed review", async () => {
    const { host, captainId, as } = await crewHost();
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", first, "--ship"]);
    await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", first]);
    const kept = host.server.store.ask("a1");

    await as(["verdict", "BBPLUGINS-1", "review", "findings", "--head", first]);
    const merge = await as(["ask", "resolve", "a1", "--answer", "Merge"]);
    await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", second, "--ship"]);
    await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", "B".repeat(40)]);

    expect(kept?.answer).toBeNull();
    expect(host.server.store.ask("a1")).toMatchObject({ answer: "Superseded" });
    expect(host.server.store.ask("a1")?.answerDeliveredAt).not.toBeNull();
    expect(merge.exitCode).toBe(1);
    expect(merge.stderr).toContain('a1 was already answered "Superseded"');
    expect(host.server.store.ask("a2")?.answer).toBeNull();
    expect(host.tasks.comments.map((comment) => comment.body)).toContain(
      `Superseded: a1 does not match the recorded review findings at ${first}; a Merge on it grants nothing.`,
    );
    // The Captain hears of no superseded answer.
    expect(
      host.sent.filter(
        (message) => message.threadId === captainId && message.text.includes("Superseded"),
      ),
    ).toEqual([]);
  });

  test("--ship needs the full head, and a new head supersedes the open ship ask", async () => {
    const { host, as } = await crewHost();
    const first = "a".repeat(40);
    const second = "b".repeat(40);

    const bare = await as(["verdict", "BBPLUGINS-1", "review", "passed", "--ship"]);
    const short = await as([
      "verdict",
      "BBPLUGINS-1",
      "review",
      "passed",
      "--head",
      "abc1234",
      "--ship",
    ]);
    const atFirst = await as([
      "verdict",
      "BBPLUGINS-1",
      "review",
      "passed",
      "--head",
      first,
      "--ship",
      "--json",
    ]);
    const atSecond = await as([
      "verdict",
      "BBPLUGINS-1",
      "review",
      "passed",
      "--head",
      second,
      "--ship",
      "--json",
    ]);
    const rerun = await as([
      "verdict",
      "BBPLUGINS-1",
      "review",
      "passed",
      "--head",
      second,
      "--ship",
      "--json",
    ]);

    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("--ship needs the head the review judged");
    expect(short.exitCode).toBe(1);
    expect(short.stderr).toContain("--ship needs the full 40-character head");
    expect(json(atFirst.stdout).results[1]).toMatchObject({ id: "a1", state: "open" });
    expect(json(atSecond.stdout).results[1]).toMatchObject({ id: "a2", state: "open" });
    expect(json(rerun.stdout).results[1]).toMatchObject({ id: "a2", state: "exists" });
    expect(host.tasks.comments.map((comment) => comment.body)).toEqual([
      expect.stringContaining(`Review passed at ${first}.`),
      `Superseded: a1 does not match the recorded review passed at ${second}; a Merge on it grants nothing.`,
      expect.stringContaining(`Review passed at ${second}.`),
    ]);
  });
});

describe("bb captain ask", () => {
  test("a decision needs its task and two options; an ask is one line of at most 80 characters", async () => {
    const { host, as } = await crewHost();

    const result = await as([
      "ask",
      "x".repeat(81),
      "--option",
      "Only one option",
      "--detail",
      "Blocked on the account.",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout).blockers.map((blocker) => blocker.fix)).toEqual([
      'shorten it, such as "Pick the Unity account for cloud crew"; put the rest in --detail',
      "pass --task <key>",
      "pass --option <recommended> --option <other>",
      'shorten it to a label, such as "Redis", with no ⭐ or other marker; move the detail into --detail-file',
    ]);
    expect(
      host.server.store.asksOf(host.server.registry.byName("Plugins")?.threadId ?? ""),
    ).toEqual([]);
  });

  test("ask refuses a ship ask: only verdict --ship opens one, naming its head", async () => {
    const { host, as } = await crewHost();
    await as(["verdict", "BBPLUGINS-2", "review", "passed", "--head", "abc123"]);

    const result = await as([
      "ask",
      "Merge BBPLUGINS-2",
      "--kind",
      "ship",
      "--task",
      "BBPLUGINS-2",
      "--detail",
      "Reviewed by the Captain.",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "a ship ask opens only with the review verdict that names its head",
    );
    expect(result.stderr).toContain(
      "once Review has passed: bb captain verdict BBPLUGINS-2 review passed --head <sha> --ship",
    );
    expect(
      host.server.store.asksOf(host.server.registry.byName("Plugins")?.threadId ?? ""),
    ).toEqual([]);
  });

  test("opens once: an Asked: comment as the Captain and one push; a rerun reports exists", async () => {
    const { host, captainId, as } = await crewHost();
    const argv = [
      "ask",
      "Pick the Unity account for cloud crew",
      "--task",
      "BBPLUGINS-1",
      "--option",
      "Studio",
      "--option",
      "Personal",
      "--detail",
      "Cloud crew needs a seat. Studio has spare seats.",
    ];

    const first = await as(argv);
    const again = await as(argv);

    expect(first.stdout).toBe(
      "a1  open  decision  BBPLUGINS-1  Pick the Unity account for cloud crew\n",
    );
    expect(again.stdout).toBe(
      "a1  exists  decision  BBPLUGINS-1  Pick the Unity account for cloud crew\n",
    );
    expect(host.tasks.comments.map((c) => [c.body, c.authorName, c.threadId])).toEqual([
      [
        "Asked: Pick the Unity account for cloud crew (a1)\n\n1. Studio (recommended)\n2. Personal\n\nCloud crew needs a seat. Studio has spare seats.",
        "Plugins Captain",
        captainId,
      ],
    ]);
    expect(host.pushes.filter((push) => push.method === "notifications.send")).toHaveLength(1);
  });

  test("resolve records the answer, posts it, and delivers it to the Captain; a failed send is retried by a rerun", async () => {
    const { host, captainId, as } = await crewHost();
    await as([
      "ask",
      "Pick an account",
      "--task",
      "BBPLUGINS-1",
      "--option",
      "Studio",
      "--option",
      "Personal",
      "--detail",
      "Seats.",
    ]);
    host.sendFails.add(captainId);
    host.setNow(5_000);

    // The user's shell has no thread: resolve needs none.
    const failed = await run(host, ["ask", "resolve", "a1", "--answer", "Studio", "--json"]);
    const conflicting = await run(host, ["ask", "resolve", "a1", "--answer", "Personal"]);
    host.sendFails.delete(captainId);
    host.setNow(6_000);
    const retried = await run(host, ["ask", "resolve", "A1", "--answer", "Studio"]);

    expect(json(failed.stdout).results[0]).toMatchObject({
      state: "undelivered",
      answer: "Studio",
      delivered: false,
    });
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain('a1 was already answered "Studio"');
    expect(retried.stdout).toBe("a1  answered  decision  BBPLUGINS-1  Studio\n");
    expect(host.server.store.ask("a1")).toMatchObject({
      answer: "Studio",
      answeredAt: 5_000,
      answerDeliveredAt: 6_000,
    });
    expect(host.sent).toEqual([
      {
        threadId: captainId,
        text: '[captain] a1 answered "Studio" · BBPLUGINS-1 Pick an account',
        mode: "steer-if-active",
      },
    ]);
    expect(
      host.tasks.comments.filter((c) => c.body.startsWith("Answered:")).map((c) => c.body),
    ).toEqual(["Answered: Studio (a1)"]);
  });

  test("an option over 12 columns is refused on decision, access and improve asks; 12 opens trimmed, though the comment adds (recommended)", async () => {
    const { host, captainId, as } = await crewHost();
    const ask = (kind: string, first: string) =>
      as([
        "ask",
        "Pick the cache backend",
        "--kind",
        kind,
        "--task",
        "BBPLUGINS-1",
        "--option",
        first,
        "--option",
        "SQLite",
        "--detail",
        "Builds re-download deps.",
      ]);

    const decision = await ask("decision", "Redis caches!");
    const access = await ask("access", "Grant the key");
    const improve = await ask("improve", "缓存后端缓存后端");
    const opened = await ask("decision", "  Redis cache!  ");

    expect(decision.exitCode).toBe(1);
    expect(decision.stderr).toContain(
      'option "Redis caches!" is 13 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row; fix: shorten it to a label, such as "Redis", with no ⭐ or other marker; move the detail into --detail-file',
    );
    expect(access.exitCode).toBe(1);
    expect(access.stderr).toContain('option "Grant the key" is 13 columns');
    expect(improve.exitCode).toBe(1);
    expect(improve.stderr).toContain('option "缓存后端缓存后端" is 16 columns');
    expect(opened.exitCode).toBe(0);
    expect(host.server.store.asksOf(captainId).map((a) => a.options)).toEqual([
      ["Redis cache!", "SQLite"],
    ]);
    expect(host.tasks.comments.at(-1)?.body).toContain("1. Redis cache! (recommended)");
  });

  test("an open ask stored before the cap still reads, answers, and retries its push on a rerun", async () => {
    const { host, captainId, as } = await crewHost();
    const long = "Keep the in-memory cache for now";
    host.server.store.openAsk({
      captainId,
      taskKey: "BBPLUGINS-1",
      kind: "decision",
      text: "Pick the cache backend",
      detail: "Builds re-download deps.",
      options: [long, "Move to Redis"],
      askedAt: 1_000,
    });
    const rerun = (...options: string[]) =>
      as([
        "ask",
        "Pick the cache backend",
        "--task",
        "BBPLUGINS-1",
        ...options.flatMap((option) => ["--option", option]),
        "--detail",
        "Builds re-download deps.",
      ]);
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);

    const same = await rerun(long, "Move to Redis");
    const changed = await rerun("Keep", "Redis");

    expect(same.exitCode).toBe(0);
    expect(same.stdout).toBe("a1  exists  decision  BBPLUGINS-1  Pick the cache backend\n");
    expect(same.stderr).toBe("");
    expect(host.pushes.filter((push) => push.method === "notifications.send")).toHaveLength(1);
    expect(changed.exitCode).toBe(0);
    expect(changed.stderr).toBe(
      "note: a1 is already open, so it keeps its options; the new --option values were ignored\n",
    );
    expect(await rpc("asks", { captainId })).toEqual({
      items: [expect.objectContaining({ key: "ask:a1", options: [long, "Move to Redis"] })],
    });
    expect(await rpc("resolveAsk", { askId: "a1", answer: long })).toEqual({
      state: "answered",
      warnings: [],
    });
  });

  test("a rerun that gives no options gets no ignored-options note", async () => {
    const { as } = await crewHost();
    const argv = ["ask", "Grant the Unity key", "--kind", "access", "--detail", "Cloud crew."];

    await as([...argv, "--option", "Grant", "--option", "Deny"]);
    const again = await as(argv);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe("a1  exists  access  -  Grant the Unity key\n");
    expect(again.stderr).toBe("");
  });

  test("identical legacy options can retry a push, and a refusing rerun skips the column check", async () => {
    const { host, captainId, as } = await crewHost();
    const draft = {
      captainId,
      taskKey: "BBPLUGINS-1",
      kind: "decision" as const,
      text: "Pick the cache backend",
      detail: "Builds re-download deps.",
      options: ["Keep\nthe in-memory cache", "Redis"],
      askedAt: 1_000,
    };
    host.server.store.openAsk(draft);
    const ask = (detail: string, first: string = draft.options[0]!) =>
      as([
        "ask",
        draft.text,
        "--task",
        draft.taskKey,
        "--option",
        first,
        "--option",
        "Redis",
        "--detail",
        detail,
        "--json",
      ]);

    const identical = await ask(draft.detail);
    expect(json(identical.stdout).results[0]).toMatchObject({ state: "exists" });
    expect(host.pushes.filter((push) => push.method === "notifications.send")).toHaveLength(1);
    const refused = await ask(" ", "Use\nother cache");
    expect(json(refused.stdout).blockers.map((blocker) => blocker.reason)).toEqual([
      expect.stringContaining("an ask needs detail"),
      expect.stringContaining("spans lines"),
    ]);
    expect(host.server.store.asksOf(captainId).map((a) => a.options)).toEqual([draft.options]);
  });

  test("a current task key wins over a former key on an earlier task", async () => {
    const { host, as } = await crewHost();
    const former = host.tasks.tasks[0]!;
    former.formerKeys = ["BBPLUGINS-2"];
    const opened = await as([
      "ask",
      "Pick the cache backend",
      "--task",
      "BBPLUGINS-2",
      "--option",
      "Redis",
      "--option",
      "SQLite",
      "--detail",
      "Builds re-download deps.",
      "--json",
    ]);
    expect(json(opened.stdout).results[0]).toMatchObject({ task: "BBPLUGINS-2" });
  });

  test("a long-option rerun that no longer matches its open ask is refused, even when the ask is answered mid-command", async () => {
    const { host, captainId, as } = await crewHost();
    const ask = (...options: string[]) =>
      as([
        "ask",
        "Pick the cache backend",
        "--task",
        "BBPLUGINS-1",
        ...options.flatMap((option) => ["--option", option]),
        "--detail",
        "Builds re-download deps.",
      ]);
    await ask("Redis", "SQLite");

    const [racing] = await Promise.all([
      ask("x".repeat(70), "Move to Redis!!"),
      host.harness.behavior.callRpc("resolveAsk", { askId: "a1", answer: "Redis" }),
    ]);
    const after = await ask("x".repeat(70), "Move to Redis!!");

    expect(racing.exitCode).toBe(1);
    expect(after.exitCode).toBe(1);
    expect(after.stderr).toContain(`option "${"x".repeat(23)}…" is 70 columns`);
    expect(host.server.store.asksOf(captainId).map((a) => a.id)).toEqual(["a1"]);
  });

  test("a long-option rerun under a moved task's old key is refused", async () => {
    const { host, captainId, as } = await crewHost();
    const ask = (...options: string[]) =>
      as([
        "ask",
        "Pick the cache backend",
        "--task",
        "BBPLUGINS-1",
        ...options.flatMap((option) => ["--option", option]),
        "--detail",
        "Builds re-download deps.",
      ]);
    await ask("Redis", "SQLite");
    const task = host.tasks.tasks.find((entry) => entry.key === "BBPLUGINS-1");
    if (task === undefined) throw new Error("no BBPLUGINS-1");
    Object.assign(task, { key: "BBPLUGINS-9", formerKeys: ["BBPLUGINS-1"] });

    const moved = await ask("x".repeat(70), "Move to Redis!!");

    expect(moved.exitCode).toBe(1);
    expect(moved.stderr).toContain(`option "${"x".repeat(23)}…" is 70 columns`);
    expect(moved.stderr).toContain('option "Move to Redis!!" is 15 columns');
    expect(host.server.store.asksOf(captainId).map((a) => [a.id, a.taskKey])).toEqual([
      ["a1", "BBPLUGINS-1"],
    ]);
  });
});

describe("the Merge gate: only the Captain or the user acts for a Captain", () => {
  const head = "a".repeat(40);
  const verdictArgs = ["verdict", "BBPLUGINS-1", "review", "passed", "--head", head, "--ship"];
  const askArgs = [
    "ask",
    "Pick a seat",
    "--task",
    "BBPLUGINS-1",
    "--option",
    "A",
    "--option",
    "B",
    "--detail",
    "Seats.",
  ];

  test("crew cannot record a verdict or open an ask, with or without --captain", async () => {
    const { host, captainId, as } = await crewHost();
    await as(verdictArgs);
    const crew = await dispatched(as, "BBPLUGINS-2", "Implement");
    const setFields = () => host.tasks.calls.filter((call) => call.method === "setField").length;
    const before = setFields();

    for (const extra of [[], ["--captain", captainId], ["--captain", "Plugins"]]) {
      for (const argv of [verdictArgs, askArgs]) {
        const result = await run(host, [...argv, ...extra], crew);
        expect(result.exitCode, [...argv, ...extra].join(" ")).toBe(1);
        expect(result.stderr).toContain(`${crew} is crew of the Plugins Captain`);
      }
    }

    expect(setFields()).toBe(before);
    expect(host.server.store.asksOf(captainId).map((ask) => [ask.id, ask.answer])).toEqual([
      ["a1", null],
    ]);
  });

  test("a thread that is neither crew nor the Captain is refused too", async () => {
    const { host, captainId, as } = await crewHost();
    await as(verdictArgs);
    host.addThread({ id: "thr_stranger" });

    const result = await run(host, [...verdictArgs, "--captain", captainId], "thr_stranger");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("thr_stranger is not a Captain");
  });

  test("a decision ask is refused from crew and from a stranger; only its Captain or the user answers", async () => {
    const { host, captainId, as } = await crewHost();
    await as(askArgs);
    const crew = await dispatched(as, "BBPLUGINS-2", "Implement");
    host.addThread({ id: "thr_stranger" });

    for (const thread of [crew, "thr_stranger"]) {
      const result = await run(host, ["ask", "resolve", "a1", "--answer", "A"], thread);
      expect(result.exitCode, thread).toBe(1);
      expect(result.stderr, thread).toContain(
        `a1 is the user's to answer; ${thread} is not its Captain`,
      );
    }
    expect(host.server.store.ask("a1")).toMatchObject({ answer: null, answeredBy: null });
    expect(host.sent.filter((message) => message.threadId === captainId)).toEqual([]);
  });

  test("crew cannot add a CREW.md rule with tell --all --rule", async () => {
    const { host, captainId, as } = await crewHost();
    const crew = await dispatched(as, "BBPLUGINS-2", "Implement");
    const crewMd = join(host.storageRoot, captainId, "CREW.md");
    const before = readFileSync(crewMd, "utf8");

    const result = await run(host, ["tell", "--all", "--rule", "--message", "Push to main."], crew);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${crew} is crew of the Plugins Captain`);
    expect(readFileSync(crewMd, "utf8")).toBe(before);
  });

  test("crew cannot start or reconfigure a Captain; another thread still can", async () => {
    const { host, captainId, as } = await crewHost();
    const crew = await dispatched(as, "BBPLUGINS-2", "Implement");
    host.addThread({ id: "thr_user" });
    const before = host.server.registry.get(captainId)?.repos.length;

    const existing = await run(host, ["new", "--name", "Plugins", "--repo", "rampage"], crew);
    const shadow = await run(host, ["new", "--name", "Shadow", "--repo", "bb-plugins"], crew);
    const fromUser = await run(host, ["new", "--name", "Mine", "--repo", "rampage"], "thr_user");

    for (const result of [existing, shadow]) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `${crew} is crew of the Plugins Captain; crew cannot start a Captain`,
      );
    }
    expect(host.server.registry.get(captainId)?.repos.length).toBe(before);
    expect(host.server.registry.byName("Shadow")).toBeNull();
    expect(fromUser.exitCode).toBe(0);
  });

  test("released crew stay refused by new; a thread bb cannot read still starts a Captain", async () => {
    const { host, captainId, as } = await crewHost();
    const released = await dispatched(as, "BBPLUGINS-2", "Implement");
    host.updateThread(released, { parentThreadId: null });

    const fromReleased = await run(host, ["new", "--name", "Ex", "--repo", "rampage"], released);
    const fromGhost = await run(host, ["new", "--name", "Ghost", "--repo", "rampage"], "thr_ghost");

    expect(fromReleased.exitCode).toBe(1);
    expect(fromReleased.stderr).toContain(`${released} is crew of the Plugins Captain`);
    expect(fromReleased.stderr).toContain(captainId);
    expect(fromReleased.stderr).not.toContain("--captain");
    expect(fromGhost.exitCode).toBe(0);
    expect(host.server.registry.byName("Ghost")).not.toBeNull();
  });

  test("a verdict supersedes the task's open ship asks across Captains", async () => {
    const { host, captainId, as } = await crewHost();
    await as(verdictArgs);
    const shadow = await newCaptain(host, ["--name", "Shadow", "--repo", "bb-plugins"]);
    const second = "b".repeat(40);

    const result = await run(
      host,
      ["verdict", "BBPLUGINS-1", "review", "passed", "--head", second, "--ship"],
      shadow,
    );

    expect(result.exitCode).toBe(0);
    expect(host.server.store.ask("a1")).toMatchObject({
      captainId,
      answer: "Superseded",
      answeredBy: "captain",
    });
    expect(host.server.store.ask("a2")).toMatchObject({ captainId: shadow, answer: null });
    expect(
      host.tasks.comments
        .filter((comment) => comment.body.startsWith("Superseded: a1"))
        .map((comment) => [comment.body, comment.authorName, comment.threadId]),
    ).toEqual([
      [
        `Superseded: a1, the Plugins Captain's ship ask, does not match the recorded review passed at ${second}; a Merge on it grants nothing.`,
        "Shadow Captain",
        shadow,
      ],
    ]);
    // The owning Captain hears its ask closed; the recording one hears nothing.
    expect(host.server.store.ask("a1")?.answerDeliveredAt).not.toBeNull();
    expect(host.sent.filter((message) => message.text.includes("Superseded"))).toEqual([
      {
        threadId: captainId,
        text: expect.stringContaining('[captain] a1 answered "Superseded" · BBPLUGINS-1'),
        mode: "steer-if-active",
      },
    ]);
  });

  test("a failed send of a cross-Captain supersede is left for the background check", async () => {
    const { host, captainId, as } = await crewHost();
    await as(verdictArgs);
    const shadow = await newCaptain(host, ["--name", "Shadow", "--repo", "bb-plugins"]);
    host.sendFails.add(captainId);

    const result = await run(
      host,
      ["verdict", "BBPLUGINS-1", "review", "findings", "--head", head],
      shadow,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("a1: answer not delivered to the Captain");
    expect(host.server.store.ask("a1")).toMatchObject({
      answer: "Superseded",
      answerDeliveredAt: null,
      deliveryAttempts: 1,
    });
  });

  test("a calling thread bb does not know is refused with a blocker", async () => {
    const { host, captainId } = await crewHost();

    const result = await run(host, ["status", "--captain", captainId, "--json"], "thr_ghost");

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout).blockers[0]?.reason).toContain(
      "could not read the calling thread thr_ghost",
    );
  });

  test("a Captain acts only for itself; the user's terminal names any Captain", async () => {
    const { host, captainId } = await crewHost();
    const other = await newCaptain(host, ["--name", "Other", "--repo", "rampage"]);

    const fromOther = await run(host, [...verdictArgs, "--captain", captainId], other);
    const fromUser = await run(host, [
      "verdict",
      "BBPLUGINS-1",
      "review",
      "passed",
      "--head",
      head,
      "--captain",
      captainId,
    ]);

    expect(fromOther.exitCode).toBe(1);
    expect(fromOther.stderr).toContain("acts only for the Other Captain");
    expect(fromUser.exitCode).toBe(0);
  });

  test("only the user answers a ship ask; the record says who answered", async () => {
    const { host, captainId, as } = await crewHost();
    await as(verdictArgs);

    const byCaptain = await as(["ask", "resolve", "a1", "--answer", "Merge"]);
    expect(byCaptain.exitCode).toBe(1);
    expect(byCaptain.stderr).toContain("only the user answers Merge or Hold");
    expect(host.server.store.ask("a1")?.answer).toBeNull();

    host.sendFails.add(captainId);
    const byUser = await run(host, ["ask", "resolve", "a1", "--answer", "Merge"]);
    host.sendFails.delete(captainId);
    // The Captain may rerun the same answer to retry its send; that keeps the user as its source.
    const retried = await as(["ask", "resolve", "a1", "--answer", "Merge"]);
    const shown = await as(["ask", "show", "a1", "--json"]);

    expect(byUser.exitCode).toBe(0);
    expect(retried.exitCode).toBe(0);
    expect(host.server.store.ask("a1")).toMatchObject({ answer: "Merge", answeredBy: "user" });
    expect(json(shown.stdout).results[0]).toMatchObject({
      id: "a1",
      kind: "ship",
      task: "BBPLUGINS-1",
      answer: "Merge",
      answeredBy: "user",
      detail: expect.stringContaining(`Review passed at ${head}.`),
    });
    expect((await as(["ask", "show", "a1"])).stdout).toBe(
      "a1  answered  ship  BBPLUGINS-1  Merge  by user\n",
    );
  });

  test("the banner answers as the user; another plugin cannot answer", async () => {
    const { host, as } = await crewHost();
    await as(verdictArgs);

    await expect(
      host.harness.behavior.callRpc(
        "resolveAsk",
        { askId: "a1", answer: "Merge" },
        { experimental_caller: { kind: "plugin", pluginId: "other" } },
      ),
    ).rejects.toThrow("only the user answers an ask");
    expect(host.server.store.ask("a1")?.answer).toBeNull();

    await host.harness.behavior.callRpc("resolveAsk", { askId: "a1", answer: "Merge" });
    expect(host.server.store.ask("a1")?.answeredBy).toBe("user");
  });

  test("a Captain may answer its own decision ask, recorded as the Captain; a superseded ship ask is never the user's", async () => {
    const { host, as } = await crewHost();
    await as(askArgs);
    await as(verdictArgs);

    expect((await as(["ask", "resolve", "a1", "--answer", "A"])).exitCode).toBe(0);
    await as(["verdict", "BBPLUGINS-1", "review", "findings", "--head", head]);

    expect(host.server.store.ask("a1")).toMatchObject({ answer: "A", answeredBy: "captain" });
    expect(host.server.store.ask("a2")).toMatchObject({
      answer: "Superseded",
      answeredBy: "captain",
    });
    expect((await as(["ask", "show", "a2"])).stdout).toContain("Superseded  by captain");
  });
});

describe("bb captain tell", () => {
  test("reaches only the role named on a task, steers it from the Captain, and moves its report-due mark", async () => {
    const { host, captainId, as } = await crewHost();
    const implementer = await dispatched(as, "BBPLUGINS-1", "Implement");
    const reviewer = await dispatched(as, "BBPLUGINS-1", "Review");
    host.setNow(7_000);

    const result = await as([
      "tell",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--message",
      "Fix the null check.",
    ]);

    expect(result.stdout).toBe(`${implementer}  told  BBPLUGINS-1  Implement\n`);
    expect(host.sent).toEqual([
      {
        threadId: implementer,
        text: "Fix the null check.",
        mode: "steer-if-active",
        senderThreadId: captainId,
      },
    ]);
    expect(host.server.store.crewRole(implementer)?.reportDueSince).toBe(7_000);
    expect(host.server.store.crewRole(reviewer)?.reportDueSince).toBe(1_000);
  });

  test("--rule appends to CREW.md once, steers only active crew, queues it for idle crew, and owes no report", async () => {
    const { host, captainId, as } = await crewHost();
    const active = await dispatched(as, "BBPLUGINS-1", "Implement");
    const idle = await dispatched(as, "BBPLUGINS-2", "Implement");
    host.updateThread(active, { status: "active" });
    host.updateThread(idle, { status: "idle" });
    const crewFile = join(host.storageRoot, captainId, "CREW.md");
    writeFileSync(crewFile, "- Run the linter before reporting.");
    host.setNow(8_000);

    const first = await as(["tell", "--all", "--rule", "--message", "Never push to main."]);
    const again = await as(["tell", "--all", "--rule", "--message", "Never push to main."]);

    expect(first.stdout).toBe(
      [
        "CREW.md  appended  Never push to main.",
        `${active}  told  BBPLUGINS-1  Implement`,
        `${idle}  queued  BBPLUGINS-2  Implement  idle; gets it with its next message`,
        "",
      ].join("\n"),
    );
    // A rerun sends nothing new: the active thread has the rule, the idle one still waits.
    expect(again.stdout).toBe(
      [
        "CREW.md  kept  rule already there",
        `${active}  kept  BBPLUGINS-1  Implement  already has this rule`,
        `${idle}  queued  BBPLUGINS-2  Implement  idle; gets it with its next message`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(crewFile, "utf8")).toBe(
      "- Run the linter before reporting.\n- Never push to main.\n",
    );
    expect(host.sent.map((message) => message.threadId)).toEqual([active]);
    expect(host.sent[0]?.senderThreadId).toBe(captainId);
    expect(host.sent[0]?.text).toContain("This message owes no report.");
    expect(host.sent[0]?.text).toMatch(/Never push to main\.$/u);
    for (const threadId of [active, idle])
      expect(host.server.store.crewRole(threadId)?.reportDueSince).toBe(1_000);
  });

  test("a rule told while a thread is idle tops its next tell once; a thread dispatched after it gets none", async () => {
    const { host, as } = await crewHost();
    const idle = await dispatched(as, "BBPLUGINS-1", "Implement");
    host.updateThread(idle, { status: "idle" });
    await as(["tell", "--all", "--rule", "--message", "Never push to main."]);
    await as(["tell", "--all", "--rule", "--message", "Run the linter\nbefore reporting."]);
    const later = await dispatched(as, "BBPLUGINS-2", "Implement");
    host.updateThread(later, { status: "idle" });

    const told = await as(["tell", "BBPLUGINS-1", "BBPLUGINS-2", "--message", "Rebase on main."]);
    await as(["tell", "BBPLUGINS-1", "--message", "Push the branch."]);

    expect(told.stdout).toBe(
      [
        `${idle}  told  BBPLUGINS-1  Implement  with 2 unseen rules`,
        `${later}  told  BBPLUGINS-2  Implement`,
        "",
      ].join("\n"),
    );
    const toIdle = host.sent.filter((message) => message.threadId === idle).map((m) => m.text);
    expect(toIdle).toHaveLength(2);
    expect(toIdle[0]).toMatch(/^Rules from the "Plugins" Captain that you have not received yet/u);
    expect(toIdle[0]).toContain(
      "- Never push to main.\n- Run the linter\n  before reporting.\n\n---\n\nRebase on main.",
    );
    expect(toIdle[0]?.split("Never push to main.")).toHaveLength(2);
    expect(toIdle[1]).toBe("Push the branch.");
    expect(host.sent.filter((message) => message.threadId === later).map((m) => m.text)).toEqual([
      "Rebase on main.",
    ]);
  });

  test("a failed send leaves the rule unseen, so the next send that succeeds carries it", async () => {
    const { host, as } = await crewHost();
    const idle = await dispatched(as, "BBPLUGINS-1", "Implement");
    host.updateThread(idle, { status: "idle" });
    await as(["tell", "--all", "--rule", "--message", "Never push to main."]);
    host.sendFails.add(idle);

    const failed = await as(["tell", "BBPLUGINS-1", "--message", "Rebase on main."]);
    host.sendFails.delete(idle);
    await as(["tell", "BBPLUGINS-1", "--message", "Rebase on main."]);

    expect(failed.stdout).toBe(`${idle}  failed  BBPLUGINS-1  Implement  thread ${idle} is busy\n`);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]?.text).toContain("- Never push to main.\n\n---\n\nRebase on main.");
  });

  test("an adopted idle thread gets rules told after its adoption above its contract", async () => {
    const { host, as } = await crewHost();
    await as(["tell", "--all", "--rule", "--message", "Older rule, already in CREW.md."]);
    host.addThread({ id: "thr_old", status: "idle" });
    await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--thread", "thr_old"]);

    const rule = await as(["tell", "--all", "--rule", "--message", "Never push to main."]);
    await as(["tell", "BBPLUGINS-1", "--message", "Start with the tests."]);

    expect(rule.stdout).toContain("thr_old  queued  BBPLUGINS-1  Implement");
    const [text] = host.sent.map((message) => message.text);
    expect(host.sent).toHaveLength(1);
    expect(text).not.toContain("Older rule");
    expect(text).toMatch(/^Rules from the "Plugins" Captain/u);
    expect(text?.indexOf("- Never push to main.")).toBeLessThan(
      text?.indexOf("You are now crew") ?? -1,
    );
    expect(text).toMatch(/Start with the tests\.$/u);
  });

  test("a send that fails is that target's failure alone: exit 3, and its report-due mark stays", async () => {
    const { host, as } = await crewHost();
    const reached = await dispatched(as, "BBPLUGINS-1", "Implement");
    const busy = await dispatched(as, "BBPLUGINS-2", "Implement");
    host.sendFails.add(busy);
    host.setNow(9_000);

    const result = await as(["tell", "BBPLUGINS-1", "BBPLUGINS-2", "--message", "Rebase on main."]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe(
      `${reached}  told  BBPLUGINS-1  Implement\n${busy}  failed  BBPLUGINS-2  Implement  thread ${busy} is busy\n`,
    );
    expect(host.server.store.crewRole(reached)?.reportDueSince).toBe(9_000);
    expect(host.server.store.crewRole(busy)?.reportDueSince).toBe(1_000);
  });

  test("an unknown target sends nothing", async () => {
    const { host, as } = await crewHost();
    await dispatched(as, "BBPLUGINS-1", "Implement");

    const result = await as(["tell", "BBPLUGINS-1", "thr_nobody", "--message", "Hi"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("thr_nobody is not live crew of this Captain");
    expect(host.sent).toEqual([]);
  });

  test("--message-file - is refused with the file route, since stdin flags take one line", async () => {
    const { host, as } = await crewHost();
    await dispatched(as, "BBPLUGINS-1", "Implement");

    const result = await as(["tell", "BBPLUGINS-1", "--message-file", "-"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "write the text to a file and pass its path; --message-stdin takes one line only",
    );
    expect(host.sent).toEqual([]);
  });
});

describe("bb captain status", () => {
  /** A Captain with one crew thread in each state the default read shows, plus a working one. */
  async function busyCaptain() {
    const ctx = await crewHost();
    const { host, captainId, as } = ctx;
    host.addTask("BBPLUGINS-3", { title: "Blocked task" });
    const working = await dispatched(as, "BBPLUGINS-1", "Implement");
    const stalled = await dispatched(as, "BBPLUGINS-2", "Implement");
    const blocked = await dispatched(as, "BBPLUGINS-3", "Implement");
    host.updateThread(stalled, { status: "idle" });
    host.updateThread(blocked, { status: "idle", hasPendingInteraction: true });
    host.interactions.set(blocked, [
      {
        id: "int_1",
        threadId: blocked,
        status: "pending",
        createdAt: 1_000,
        payload: { kind: "plugin", title: "secrets request: UNITY_TOKEN", data: null },
      },
    ]);
    host.setNow(1_000 + 40 * 60_000);
    await as([
      "ask",
      "Pick an account",
      "--task",
      "BBPLUGINS-1",
      "--option",
      "A",
      "--option",
      "B",
      "--detail",
      "Seats.",
    ]);
    host.setNow(1_000 + 60 * 60_000);
    return { ...ctx, captainId, working, stalled, blocked };
  }

  test("a counts line, then the rows that need action, ids first", async () => {
    const { as, stalled, blocked } = await busyCaptain();

    const result = await as(["status"]);

    const [counts, ...rows] = result.stdout.trim().split("\n");
    expect(counts).toMatch(/^1 ask · 1 blocked · 1 stalled · 1 working · cursor c_[0-9a-z]+$/u);
    expect(rows).toEqual([
      "a1  ask  BBPLUGINS-1  Pick an account  20m",
      `BBPLUGINS-3  blocked  ${blocked}  Implement  secrets request: UNITY_TOKEN · in_progress  1h`,
      `BBPLUGINS-2  stalled  ${stalled}  Implement  idle, no report since it fell due · in_progress  1h`,
    ]);
  });

  test("a report clears the stall; a ship-ready review shows as ready; --all adds every row", async () => {
    const { host, as, working, stalled } = await busyCaptain();
    host.report("BBPLUGINS-2", stalled);
    await as(["verdict", "BBPLUGINS-1", "review", "passed", "--head", "abc"]);

    const result = await as(["status", "--all", "--json"]);

    const body = JSON.parse(result.stdout) as {
      counts: Record<string, number>;
      rows: { id: string; state: string; thread: string | null }[];
    };
    expect(body.counts).toMatchObject({
      ask: 1,
      blocked: 1,
      stalled: 0,
      ready: 1,
      working: 1,
      idle: 1,
    });
    expect(body.rows.map((row) => [row.id, row.state, row.thread])).toEqual([
      ["a1", "ask", null],
      ["BBPLUGINS-3", "blocked", expect.any(String)],
      ["BBPLUGINS-1", "ready", null],
      ["BBPLUGINS-1", "working", working],
      ["BBPLUGINS-2", "idle", stalled],
    ]);
  });

  test("--all shows archived crew and marks a task whose Review thread is working", async () => {
    const { host, as, working } = await busyCaptain();
    const reviewer = await dispatched(as, "BBPLUGINS-1", "Review");
    host.updateThread(reviewer, { status: "active" });
    const done = await dispatched(as, "BBPLUGINS-2", "Review");
    host.updateThread(done, { archivedAt: host.now() });

    const plain = await as(["status"]);
    const all = await as(["status", "--all"]);

    expect(plain.stdout).not.toContain(done);
    const line = (stdout: string, thread: string) =>
      stdout.split("\n").find((entry) => entry.includes(thread)) ?? "";
    expect(line(all.stdout, done)).toMatch(
      new RegExp(`^BBPLUGINS-2  archived  ${done}  Review  `, "u"),
    );
    expect(line(all.stdout, working)).toContain("review running");
    expect(line(all.stdout, reviewer)).not.toContain("review running");
  });

  test("--since returns only rows changed after the cursor, plus every stalled and blocked row", async () => {
    const { host, as, working } = await busyCaptain();
    const before = await as(["status", "--json"]);
    const cursor = (JSON.parse(before.stdout) as { cursor: string }).cursor;
    host.setNow(host.now() + 60_000);
    host.report("BBPLUGINS-1", working, "Final: done");

    const since = await as(["status", "--since", cursor, "--json"]);
    const unchanged = await as([
      "status",
      "--since",
      (JSON.parse(since.stdout) as { cursor: string }).cursor,
      "--json",
    ]);
    const bad = await as(["status", "--since", "yesterday"]);

    const ids = (stdout: string) =>
      (JSON.parse(stdout) as { rows: { id: string; state: string }[] }).rows.map(
        (row) => `${row.id} ${row.state}`,
      );
    expect(ids(since.stdout)).toEqual([
      "BBPLUGINS-3 blocked",
      "BBPLUGINS-2 stalled",
      "BBPLUGINS-1 working",
    ]);
    expect(ids(unchanged.stdout)).toEqual(["BBPLUGINS-3 blocked", "BBPLUGINS-2 stalled"]);
    expect(bad.exitCode).toBe(1);
  });
});
