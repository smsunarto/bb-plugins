import { describe, expect, test } from "vitest";
import { isRateLimit, RETRY_GRACE_MS } from "./fallback.ts";
import { rungEligibility } from "./ladder.ts";
import {
  captainHost,
  newCaptain,
  SERVER_HOST,
  type CaptainHost,
  type FakePool,
} from "./test-host.ts";

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
      kind: "pool",
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

const ANTIGRAVITY = {
  providerId: "acp-antigravity",
  model: "gemini-4-neon",
  reasoningLevel: "high",
};
const CODEX = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" };

/** Set a Tasks preset's permission mode, as a user editing it in Tasks would. */
function setPermission(host: CaptainHost, name: string, mode: string) {
  const preset = presetNamed(host, name);
  if (preset === undefined) throw new Error(`no preset ${name}`);
  preset.permissionMode = mode;
}

/** Take a provider off one machine's list, or off every machine's. */
function dropProvider(host: CaptainHost, id: string, hostId?: string) {
  const list = (host.providerList.value ?? []).filter((provider) => provider.id !== id);
  if (hostId === undefined) host.providerList.value = list;
  else host.providerList.byHost[hostId] = list;
}

describe("rungs on a provider the pool does not route, such as Antigravity", () => {
  test("dispatch starts an ACP rung when the pooled rungs are out, through its own preset", async () => {
    const { host, as } = await ladderHost(NONE_READY);
    await host.harness.behavior.callRpc("setLadder", {
      role: "implement",
      rungs: [
        { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
        ANTIGRAVITY,
      ],
    });

    const result = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("started  rung 2 acp-antigravity gemini-4-neon high");
    expect(presetNamed(host, "Captain Implement · 2")).toMatchObject({
      providerId: "acp-antigravity",
      modelId: "gemini-4-neon",
      permissionMode: "full",
    });
    // Providers are read on the machine the thread spawns on: the project's default source.
    expect(host.providerList.reads).toEqual([SERVER_HOST]);
  });

  test("a rung whose provider lacks the role preset's permission mode is skipped, and a forced one refused", async () => {
    const { host, as } = await ladderHost();
    host.pool.status = { routing: {}, accounts: [] };
    setPermission(host, "Implement", "auto");
    await host.harness.behavior.callRpc("setLadder", {
      role: "implement",
      rungs: [ANTIGRAVITY, CODEX],
    });

    const auto = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--dry-run"]);
    expect(auto.stdout).toContain(
      `rung 2 codex gpt-6-astra high; skipped rung 1 acp-antigravity gemini-4-neon high: acp-antigravity does not take permission mode auto`,
    );

    // Forcing the rung skips the pool, not bb: it refuses before Tasks starts a thread bb rejects.
    const forced = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--rung",
      "1",
      "--json",
    ]);
    expect(forced.exitCode).toBe(1);
    expect(json(forced.stdout).results[0]?.["blockers"]).toEqual([
      {
        reason:
          "rung 1 acp-antigravity gemini-4-neon high: acp-antigravity does not take permission mode auto",
        fix: "set the Implement preset's permission to accept-edits or full, or use another rung",
      },
    ]);
    expect(delegates(host)).toEqual([]);
  });

  test("a provider missing from a machine's list counts as unavailable; an unread list skips no rung", async () => {
    const { host, as } = await ladderHost();
    host.pool.status = { routing: {}, accounts: [] };
    await host.harness.behavior.callRpc("setLadder", {
      role: "implement",
      rungs: [ANTIGRAVITY, CODEX],
    });
    dropProvider(host, "acp-antigravity");

    const missing = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--dry-run"]);
    expect(missing.stdout).toContain(
      `rung 2 codex gpt-6-astra high; skipped rung 1 acp-antigravity gemini-4-neon high: acp-antigravity is not available on ${SERVER_HOST}`,
    );

    const forced = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--rung",
      "1",
      "--json",
    ]);
    expect(json(forced.stdout).results[0]?.["blockers"]).toEqual([
      {
        reason: `rung 1 acp-antigravity gemini-4-neon high: acp-antigravity is not available on ${SERVER_HOST}`,
        fix: `install, enable or sign in to acp-antigravity on ${SERVER_HOST}, or use another rung`,
      },
    ]);

    // Every rung refused by bb: --rung would refuse too, so the fix does not offer it.
    dropProvider(host, "codex");
    const none = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);
    expect(json(none.stdout).results[0]?.["blockers"]).toEqual([
      {
        reason: `no rung of Implement's ladder can start now: rung 1 acp-antigravity gemini-4-neon high: acp-antigravity is not available on ${SERVER_HOST}; rung 2 codex gpt-6-astra high: codex is not available on ${SERVER_HOST}`,
        fix: "fix what each rung names, or add a rung in Captain settings",
      },
    ]);

    host.providerList.value = null;
    const unread = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--dry-run"]);
    expect(unread.stdout).toContain("rung 1 acp-antigravity gemini-4-neon high");
  });

  test("providers are read on the machine the thread spawns on: the preset's machine, else the project's connected source", async () => {
    const { host, as } = await ladderHost();
    host.pool.status = { routing: {}, accounts: [] };
    await host.harness.behavior.callRpc("setLadder", { role: "implement", rungs: [ANTIGRAVITY] });
    // Antigravity is missing on the server, present on the Mac where the repo lives.
    dropProvider(host, "acp-antigravity", SERVER_HOST);
    host.connectedHosts.add("host_mac");
    host.projectSources.set("proj_plugins", [
      { hostId: SERVER_HOST, isDefault: false },
      { hostId: "host_mac", isDefault: true },
    ]);

    const onMac = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--dry-run"]);
    expect(onMac.stdout).toContain("planned");
    expect(onMac.stdout).toContain("rung 1 acp-antigravity gemini-4-neon high");
    expect(host.providerList.reads).toEqual(["host_mac"]);

    // A preset pinned to a machine spawns there, wherever the project lives.
    const implement = presetNamed(host, "Implement");
    if (implement !== undefined) implement.machineId = SERVER_HOST;
    const pinned = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--json"]);
    expect(json(pinned.stdout).results[0]?.["blockers"]).toEqual([
      expect.objectContaining({
        reason: `no rung of Implement's ladder can start now: rung 1 acp-antigravity gemini-4-neon high: acp-antigravity is not available on ${SERVER_HOST}`,
      }),
    ]);

    // A machine that cannot be told, such as a project with no connected source, refuses nothing.
    if (implement !== undefined) implement.machineId = null;
    host.connectedHosts.delete("host_mac");
    host.projectSources.set("proj_plugins", [{ hostId: "host_mac", isDefault: true }]);
    host.providerList.reads.length = 0;
    const unknown = await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--dry-run"]);
    expect(unknown.stdout).toContain("planned");
    expect(host.providerList.reads).toEqual([]);
  });

  test("a rung preset made while the role preset was auto follows it back to full", async () => {
    const { host, as } = await ladderHost();
    host.pool.status = { routing: {}, accounts: [] };
    setPermission(host, "Implement", "auto");
    await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--rung", "2"]);
    expect(presetNamed(host, "Captain Implement · 2")).toMatchObject({
      providerId: "codex",
      permissionMode: "auto",
    });

    setPermission(host, "Implement", "full");
    await host.harness.behavior.callRpc("setLadder", {
      role: "implement",
      rungs: [
        { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
        ANTIGRAVITY,
      ],
    });
    const result = await as([
      "dispatch",
      "BBPLUGINS-1",
      "--role",
      "Implement",
      "--rung",
      "2",
      "--again",
    ]);

    expect(result.exitCode).toBe(0);
    expect(presetNamed(host, "Captain Implement · 2")).toMatchObject({
      providerId: "acp-antigravity",
      permissionMode: "full",
    });
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
    const rung2 = presetNamed(host, "Captain Implement · 2");
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
      "BBPLUGINS-1  -  Review  planned  rung 2 codex gpt-6-astra high; skipped rung 1 claude-code claude-fable-5-2 high: no ready claude account with fable left · preset Captain Review · 2 · machine the repo's source machine · branch crew/x\n",
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
      expect.objectContaining({ presetId: presetNamed(host, "Captain Implement · 1")?.id }),
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
          "no rung of Implement's ladder can start now: rung 1 claude-code claude-opus-5-5 high: no ready claude account with opus left; rung 2 codex gpt-6-astra high: no ready codex account",
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

  test("a ladder saved in settings is what dispatch starts on, through Captain's own preset; the shared one is untouched", async () => {
    const { host, as } = await ladderHost();
    const shared = { ...presetNamed(host, "Implement") };
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
    expect(presetNamed(host, "Captain Implement · 1")).toMatchObject({
      modelId: "claude-sonnet-5-5",
      reasoningLevel: "medium",
    });
    // Tasks' own Implement preset, which other dispatches use, keeps its model.
    expect(presetNamed(host, "Implement")).toEqual(shared);
    expect(host.tasks.calls.filter((call) => call.method === "updatePreset")).toEqual([]);

    // A later ladder change updates Captain's preset, still never the shared one.
    await host.harness.behavior.callRpc("setLadder", {
      role: "implement",
      rungs: [{ providerId: "claude-code", model: "claude-haiku-5-5", reasoningLevel: "low" }],
    });
    await as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--again"]);
    expect(presetNamed(host, "Captain Implement · 1")).toMatchObject({
      modelId: "claude-haiku-5-5",
    });
    expect(presetNamed(host, "Implement")).toEqual(shared);
  });

  test("one dispatch of two tasks onto a rung with no preset yet creates it once and starts both", async () => {
    const { host, as } = await ladderHost();
    host.addTask("BBPLUGINS-2", { title: "Fix the sidebar" });
    expect(presetNamed(host, "Captain Implement · 2")).toBeUndefined();

    const result = await as([
      "dispatch",
      "BBPLUGINS-1",
      "BBPLUGINS-2",
      "--role",
      "Implement",
      "--rung",
      "2",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(json(result.stdout).results.map((item) => item["state"])).toEqual([
      "started",
      "started",
    ]);
    const rung2 = presetNamed(host, "Captain Implement · 2");
    expect(host.tasks.calls.filter((call) => call.method === "createPreset")).toHaveLength(1);
    expect(delegates(host)).toEqual([
      expect.objectContaining({ presetId: rung2?.id }),
      expect.objectContaining({ presetId: rung2?.id }),
    ]);
  });

  test("two dispatch commands at once onto a new rung: the one that loses the create uses the winner's preset", async () => {
    const { host, as } = await ladderHost();
    host.addTask("BBPLUGINS-2", { title: "Fix the sidebar" });

    const [one, two] = await Promise.all([
      as(["dispatch", "BBPLUGINS-1", "--role", "Implement", "--rung", "2"]),
      as(["dispatch", "BBPLUGINS-2", "--role", "Implement", "--rung", "2"]),
    ]);

    expect([one.exitCode, two.exitCode]).toEqual([0, 0]);
    const rung2 = presetNamed(host, "Captain Implement · 2");
    expect(
      host.tasks.presets.filter((preset) => preset.name === "Captain Implement · 2"),
    ).toHaveLength(1);
    expect(delegates(host)).toEqual([
      expect.objectContaining({ presetId: rung2?.id }),
      expect.objectContaining({ presetId: rung2?.id }),
    ]);
  });
});

/** A dispatched Implement thread that then fails on a rate limit bb declined to retry. */
async function rateLimited(
  pool: FakePool,
  options: {
    rung?: string;
    decision?: "decline" | "retry" | "none";
    reported?: boolean;
    error?: unknown;
    /** The Implement ladder the thread starts on, saved before the dispatch. */
    ladder?: unknown[];
  } = {},
) {
  const setup = await ladderHost(ALL_READY);
  const { host, as } = setup;
  if (options.ladder !== undefined) {
    await host.harness.behavior.callRpc("setLadder", { role: "implement", rungs: options.ladder });
  }
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
      data: options.error ?? {
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

    const rung2 = presetNamed(host, "Captain Implement · 2");
    const restarts = delegates(host).slice(1);
    expect(restarts).toEqual([
      expect.objectContaining({
        taskId: host.tasks.tasks[0]?.id,
        presetId: rung2?.id,
        parentThreadId: captainId,
        senderThreadId: captainId,
        extraInstructions: expect.stringContaining("# Role: Implement"),
      }),
    ]);
    const restarted = [...host.threads.keys()].findLast((id) => id.startsWith("thr_crew")) ?? "";
    expect(restarted).not.toBe(failed);
    expect(host.server.store.crewRole(restarted)).toMatchObject({ role: "implement", rung: 2 });
    expect(host.threads.get(failed)?.archivedAt).not.toBeNull();
    expect(toCaptain(host, captainId).map((message) => message.senderThreadId)).toEqual([
      undefined,
    ]);
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

  test("an ACP agent's quota error, which bb records as text with no errorInfo, restarts on the next rung", async () => {
    const { host, captainId, failed } = await rateLimited(CLAUDE_CAPPED, {
      error: ACP_QUOTA_ERROR,
    });

    await host.server.check.pass();

    expect(delegates(host)).toHaveLength(2);
    expect(host.threads.get(failed)?.archivedAt).not.toBeNull();
    expect(toCaptain(host, captainId).map((message) => message.text)).toEqual([
      expect.stringContaining(`${failed} hit a provider rate limit on rung 1`),
    ]);
  });

  const OPUS = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
  const restartedRung = (host: CaptainHost) => {
    const restarted = [...host.threads.keys()].findLast((id) => id.startsWith("thr_crew")) ?? "";
    return host.server.store.crewRole(restarted)?.rung;
  };

  test("passes over a rung bb would refuse: a provider lacking the role preset's mode, or missing", async () => {
    const mode = await rateLimited(CLAUDE_CAPPED, { ladder: [OPUS, ANTIGRAVITY, CODEX] });
    setPermission(mode.host, "Implement", "auto");
    await mode.host.server.check.pass();
    expect(restartedRung(mode.host)).toBe(3);
    expect(toCaptain(mode.host, mode.captainId).map((message) => message.text)).toEqual([
      expect.stringContaining(
        "Skipped rung 2 acp-antigravity gemini-4-neon high: acp-antigravity does not take permission mode auto.",
      ),
    ]);

    const missing = await rateLimited(CLAUDE_CAPPED, { ladder: [OPUS, ANTIGRAVITY, CODEX] });
    dropProvider(missing.host, "acp-antigravity");
    await missing.host.server.check.pass();
    expect(restartedRung(missing.host)).toBe(3);
  });

  test("opens nothing while presets or a provider list are unread, then picks the right rung on a later pass", async () => {
    for (const unread of ["providers", "presets"] as const) {
      const { host, captainId, failed } = await rateLimited(CLAUDE_CAPPED, {
        ladder: [OPUS, ANTIGRAVITY, CODEX],
      });
      setPermission(host, "Implement", "auto");
      if (unread === "providers") host.providerList.value = null;
      else host.tasks.failing.add("listPresets");

      await host.server.check.pass();
      expect(host.server.store.fallback(failed)).toBeNull();
      expect(delegates(host)).toHaveLength(1);
      expect(toCaptain(host, captainId)).toEqual([]);

      host.providerList.value = [
        { id: "claude-code", available: true, permissionModes: ["accept-edits", "auto", "full"] },
        { id: "codex", available: true, permissionModes: ["accept-edits", "auto", "full"] },
        { id: "acp-antigravity", available: true, permissionModes: ["accept-edits", "full"] },
      ];
      host.tasks.failing.delete("listPresets");
      await host.server.check.pass();
      expect(host.server.store.fallback(failed)).toMatchObject({ toRung: 3 });
      expect(restartedRung(host)).toBe(3);
    }
  });

  test("reads Tasks' presets once per pass, for both picking the rung and starting it", async () => {
    const { host } = await rateLimited(CLAUDE_CAPPED);
    host.tasks.calls.length = 0;

    await host.server.check.pass();

    expect(delegates(host)).toHaveLength(1);
    expect(host.tasks.calls.filter((call) => call.method === "listPresets")).toHaveLength(1);
  });

  test("a thread that reported before it failed is not restarted", async () => {
    const { host, captainId } = await rateLimited(CLAUDE_CAPPED, { reported: true });

    await host.server.check.pass();

    expect(delegates(host)).toHaveLength(1);
    expect(toCaptain(host, captainId).filter((m) => m.text.includes("rate limit"))).toEqual([]);
  });
});

/**
 * The `provider/error` data bb recorded on a test instance (bb 0.50.1) when an
 * ACP agent answered `session/prompt` with a JSON-RPC error. The envelope is
 * bb's real one; the text is the quota message the Antigravity CLI (`agy`)
 * ships, served by a stand-in agent because no real quota error was observed.
 */
const ACP_QUOTA_ERROR = {
  providerThreadId: "fake-346648-1",
  message: "Provider error",
  detail: "Internal error: You have exhausted your quota on this model.",
};

describe("isRateLimit", () => {
  test("reads quota wording only from errors no provider classified", () => {
    expect(isRateLimit(ACP_QUOTA_ERROR)).toBe(true);
    for (const detail of [
      "Internal error: RESOURCE_EXHAUSTED",
      "googleapi: Too Many Requests",
      "model gemini-4-neon is out of quota until 2026-11-26T00:00:00Z",
      "Rate limit reached, try again later",
    ]) {
      expect(isRateLimit({ message: "Provider error", detail })).toBe(true);
    }
    // Other ACP failures are not rate limits, even when agy's stderr mentions its /quota command.
    expect(
      isRateLimit({
        message: "Provider error",
        detail:
          'ACP agent "agy" exited unexpectedly (code 1): printmode.go:332] Print mode: running slash command /quota\npanic: runtime error',
      }),
    ).toBe(false);
    // A provider that classified its error is believed, even when its text reads like a quota.
    expect(
      isRateLimit({
        message: "Provider error",
        detail: ACP_QUOTA_ERROR.detail,
        errorInfo: { category: "max-output-tokens", providerCode: null, httpStatusCode: null },
      }),
    ).toBe(false);
  });
});
