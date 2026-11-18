import { describe, expect, test } from "vitest";
import { RETRY_GRACE_MS } from "./fallback.ts";
import { rungEligibility } from "./ladder.ts";
import { captainHost, newCaptain, type CaptainHost, type FakePool } from "./test-host.ts";

type Json = {
  ok: boolean;
  results: Record<string, unknown>[];
  blockers: { reason: string; fix: string }[];
};
const json = (stdout: string) => JSON.parse(stdout) as Json;
const FAR = 9_000_000_000_000;

/** Claude out for Opus and Fable: one account exhausted, one with both weekly family caps hit. */
const CLAUDE_CAPPED: FakePool = {
  routing: { claude: true, codex: true },
  accounts: [
    { provider: "claude", enabled: true, status: "exhausted" },
    {
      provider: "claude",
      enabled: true,
      status: "ready",
      familyWeekly: {
        opus: { utilization: 1, resetAt: FAR, status: "rejected" },
        fable: { utilization: 1, resetAt: FAR, status: "rejected" },
      },
    },
    { provider: "codex", enabled: true, status: "ready" },
  ],
};
const ALL_READY: FakePool = {
  routing: { claude: true, codex: true },
  accounts: [
    { provider: "claude", enabled: true, status: "ready" },
    { provider: "codex", enabled: true, status: "ready" },
  ],
};
const NONE_READY: FakePool = {
  routing: { claude: true, codex: true },
  accounts: [
    { provider: "claude", enabled: true, status: "exhausted" },
    { provider: "codex", enabled: false, status: "ready" },
  ],
};

async function ladderHost(pool: FakePool = ALL_READY) {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.addTask("BBPLUGINS-1", { title: "Render PR images" });
  host.pool.status = pool;
  host.pushes.length = 0;
  host.tasks.calls.length = 0;
  const as = (argv: string[]) => host.harness.behavior.runCli(argv, { threadId: captainId });
  return { host, captainId, as };
}

const delegates = (host: CaptainHost) =>
  host.tasks.calls.filter((call) => call.method === "delegate").map((call) => call.input);
const presetNamed = (host: CaptainHost, name: string) =>
  host.tasks.presets.find((preset) => preset.name === name);
const toCaptain = (host: CaptainHost, captainId: string) =>
  host.sent.filter((message) => message.threadId === captainId);

describe("rung eligibility", () => {
  test("a ready account counts only while its weekly cap for the rung's model family is not hit", () => {
    const now = 1_000;
    const rung = (model: string) => ({ providerId: "claude-code", model, reasoningLevel: "high" });
    expect(rungEligibility(rung("claude-opus-5-5"), CLAUDE_CAPPED, now)).toEqual({
      eligible: false,
      reason: "no ready claude account with opus left",
    });
    expect(rungEligibility(rung("claude-sonnet-5-5"), CLAUDE_CAPPED, now)).toEqual({
      eligible: true,
    });
    // A cap whose reset has passed no longer holds the account back.
    expect(rungEligibility(rung("claude-opus-5-5"), CLAUDE_CAPPED, FAR + 1)).toEqual({
      eligible: true,
    });
    // A provider the pool does not route, or an unread pool, is never skipped.
    expect(
      rungEligibility(
        { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
        { routing: { codex: false }, accounts: [] },
        now,
      ),
    ).toEqual({ eligible: true });
    expect(rungEligibility(rung("claude-opus-5-5"), null, now)).toEqual({ eligible: true });
  });
});

describe("bb captain dispatch on a ladder", () => {
  test("starts on the first rung with an eligible account, through that rung's own preset, and says which", async () => {
    const { host, as } = await ladderHost(CLAUDE_CAPPED);

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "started  rung 2 codex gpt-6-astra high; skipped rung 1 claude-code claude-opus-5-5 high: no ready claude account with opus left",
    );
    const rung2 = presetNamed(host, "Implement · 2");
    // Rung 2 copies rung 1's preset fields; only the model differs.
    expect(rung2).toMatchObject({
      providerId: "codex",
      modelId: "gpt-6-astra",
      reasoningLevel: "high",
      permissionMode: "full",
      environmentKind: "new-worktree",
    });
    expect(delegates(host)).toEqual([expect.objectContaining({ presetId: rung2?.id })]);
    const threadId = result.stdout.trim().split(/\s{2,}/u)[1] ?? "";
    expect(host.server.store.crewRole(threadId)).toMatchObject({ role: "implement", rung: 2 });
  });

  test("--dry-run names the rung it would use and changes no preset", async () => {
    const { host, as } = await ladderHost(CLAUDE_CAPPED);

    const result = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Review",
      "--dry-run",
      "--base-branch",
      "crew/x",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "BBPLUGINS-1  -  Review  planned  rung 2 codex gpt-6-astra high; skipped rung 1 claude-code claude-fable-5-2 high: no ready claude account with fable left · preset Review · 2 · machine the repo's source machine · branch crew/x\n",
    );
    const writes = host.tasks.calls.filter((call) =>
      ["createPreset", "updatePreset", "delegate"].includes(call.method),
    );
    expect(writes).toEqual([]);
  });

  test("--rung forces a rung even when it is not eligible; a rung past the ladder is refused", async () => {
    const { host, as } = await ladderHost(CLAUDE_CAPPED);

    const forced = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--rung", "1"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("started  rung 1 claude-code claude-opus-5-5 high (forced)");
    expect(delegates(host)).toEqual([
      expect.objectContaining({ presetId: presetNamed(host, "Implement")?.id }),
    ]);

    const past = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--rung",
      "3",
      "--again",
    ]);
    expect(past.exitCode).not.toBe(0);
    expect(past.stdout + past.stderr).toContain("Implement's ladder has 2 rungs, not 3");
    expect(delegates(host)).toHaveLength(1);
  });

  test("with no eligible rung it refuses, names each rung's reason, and starts nothing", async () => {
    const { host, as } = await ladderHost(NONE_READY);

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout).results[0]?.["blockers"]).toEqual([
      {
        reason:
          "no rung of Implement's ladder has an eligible account: rung 1 claude-code claude-opus-5-5 high: no ready claude account with opus left; rung 2 codex gpt-6-astra high: no ready codex account",
        fix: expect.stringContaining("--rung <n>"),
      },
    ]);
    expect(delegates(host)).toEqual([]);
  });

  test("a rerun with no eligible rung reports the live thread as exists, not refused", async () => {
    const { host, as } = await ladderHost(ALL_READY);
    const first = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);
    expect(first.exitCode).toBe(0);
    host.pool.status = NONE_READY;

    const rerun = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);

    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toContain("exists");
    expect(delegates(host)).toHaveLength(1);
  });

  test("a ladder saved in settings is what dispatch starts on, and rung 1's preset follows it", async () => {
    const { host, as } = await ladderHost();
    await host.harness.behavior.callRpc("setLadder", {
      role: "implement",
      rungs: [{ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" }],
    });
    const ladders = (await host.harness.behavior.callRpc("ladders", {})) as {
      roles: { role: string; custom: boolean; rungs: unknown[] }[];
    };
    expect(ladders.roles.find((entry) => entry.role === "implement")).toMatchObject({
      custom: true,
      rungs: [{ model: "claude-sonnet-5-5" }],
    });

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);

    expect(result.stdout).toContain("rung 1 claude-code claude-sonnet-5-5 medium");
    expect(presetNamed(host, "Implement")).toMatchObject({
      modelId: "claude-sonnet-5-5",
      reasoningLevel: "medium",
    });
  });
});

/** A dispatched Implement thread that then fails on a rate limit bb declined to retry. */
async function rateLimited(
  pool: FakePool,
  options: { rung?: string; decision?: "decline" | "retry" | "none"; reported?: boolean } = {},
) {
  const setup = await ladderHost(ALL_READY);
  const { host, as } = setup;
  const argv = ["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"];
  const started = await as(options.rung === undefined ? argv : [...argv, "--rung", options.rung]);
  const failed = String(json(started.stdout).results[0]?.["thread"]);
  if (options.reported === true) host.report("BBPLUGINS-1", failed);
  host.setNow(host.now() + 1_000);
  host.updateThread(failed, { status: "error", updatedAt: host.now() });
  host.events.set(failed, [
    {
      type: "provider/error",
      createdAt: host.now(),
      data: {
        message: "Provider error",
        detail:
          "API Error: Request rejected (429) · No Account Pooler account is currently eligible.",
        errorInfo: { category: "rate-limit", providerCode: null, httpStatusCode: 429 },
      },
    },
  ]);
  const decision = options.decision ?? "decline";
  if (decision !== "none") {
    host.retryDecisions.set(failed, {
      requestId: "creq_1",
      observedAt: host.now() + 50,
      availability: { kind: "blocked", retryAt: FAR },
      decision:
        decision === "decline"
          ? { kind: "decline", reason: "beyond-maximum-wait" }
          : { kind: "retry", reason: "scheduled", sendAt: host.now() + 60_000 },
    });
  }
  host.pool.status = pool;
  host.sent.length = 0;
  return { ...setup, failed };
}

describe("rate-limit fallback", () => {
  test("restarts the task and role on the next eligible rung, archives the failed thread, and wakes the Captain once", async () => {
    const { host, captainId, failed } = await rateLimited(CLAUDE_CAPPED);

    await host.server.check.pass();

    const rung2 = presetNamed(host, "Implement · 2");
    const restarts = delegates(host).slice(1);
    expect(restarts).toEqual([
      expect.objectContaining({
        taskId: host.tasks.tasks[0]?.id,
        presetId: rung2?.id,
        parentThreadId: captainId,
        extraInstructions: expect.stringContaining("# Role: Implement"),
      }),
    ]);
    const restarted = [...host.threads.keys()].findLast((id) => id.startsWith("thr_crew")) ?? "";
    expect(restarted).not.toBe(failed);
    expect(host.server.store.crewRole(restarted)).toMatchObject({ role: "implement", rung: 2 });
    expect(host.threads.get(failed)?.archivedAt).not.toBeNull();
    expect(toCaptain(host, captainId).map((message) => message.text)).toEqual([
      `[captain] BBPLUGINS-1 Implement ${failed} hit a provider rate limit on rung 1 (claude-code claude-opus-5-5 high); restarted on rung 2 (codex gpt-6-astra high) as ${restarted} with the same brief, and archived ${failed}.`,
    ]);

    // A second pass, and a thread.failed nudge, find nothing left to do.
    await host.server.check.pass();
    expect(delegates(host)).toHaveLength(2);
    expect(toCaptain(host, captainId)).toHaveLength(1);
  });

  test("a pass cut off between the restart and the archive is finished by the next, without a second restart", async () => {
    const { host, captainId, failed } = await rateLimited(CLAUDE_CAPPED);
    host.archiveFails.add(failed);

    await host.server.check.pass();
    expect(delegates(host)).toHaveLength(2);
    expect(toCaptain(host, captainId)).toEqual([]);

    host.archiveFails.delete(failed);
    await host.server.check.pass();
    expect(delegates(host)).toHaveLength(2);
    expect(host.threads.get(failed)?.archivedAt).not.toBeNull();
    expect(toCaptain(host, captainId)).toHaveLength(1);
  });

  test("a thread the Captain already dispatched by hand counts as the restart: no second start", async () => {
    const { host, as, captainId, failed } = await rateLimited(CLAUDE_CAPPED);
    const manual = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--again",
      "--json",
    ]);
    const manualId = String(json(manual.stdout).results[0]?.["thread"]);
    expect(manualId).not.toBe(failed);

    await host.server.check.pass();

    expect(delegates(host)).toHaveLength(2);
    expect(host.threads.get(failed)?.archivedAt).not.toBeNull();
    expect(toCaptain(host, captainId).map((message) => message.text)).toEqual([
      expect.stringContaining(`as ${manualId} with the same brief`),
    ]);
  });

  test("after the last rung it wakes the Captain as blocked, starts nothing and keeps the failed thread", async () => {
    const { host, captainId, failed } = await rateLimited(NONE_READY, { rung: "2" });

    await host.server.check.pass();
    await host.server.check.pass();

    expect(delegates(host)).toHaveLength(1);
    expect(host.threads.get(failed)?.archivedAt).toBeNull();
    const wakes = toCaptain(host, captainId).map((message) => message.text);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatch(
      new RegExp(
        `^\\[captain\\] Blocked: BBPLUGINS-1 Implement ${failed} hit a provider rate limit on rung 2 \\(codex gpt-6-astra high\\), and no later rung`,
        "u",
      ),
    );
  });

  test("leaves a retry bb queued to bb, and waits out the grace when provider-retry has not decided", async () => {
    const queued = await rateLimited(CLAUDE_CAPPED, { decision: "retry" });
    await queued.host.server.check.pass();
    expect(delegates(queued.host)).toHaveLength(1);
    expect(toCaptain(queued.host, queued.captainId)).toEqual([]);

    const undecided = await rateLimited(CLAUDE_CAPPED, { decision: "none" });
    await undecided.host.server.check.pass();
    expect(delegates(undecided.host)).toHaveLength(1);
    undecided.host.setNow(undecided.host.now() + RETRY_GRACE_MS);
    await undecided.host.server.check.pass();
    expect(delegates(undecided.host)).toHaveLength(2);
  });

  test("a thread that reported before it failed is not restarted", async () => {
    const { host, captainId } = await rateLimited(CLAUDE_CAPPED, { reported: true });

    await host.server.check.pass();

    expect(delegates(host)).toHaveLength(1);
    expect(toCaptain(host, captainId).filter((m) => m.text.includes("rate limit"))).toEqual([]);
  });
});
