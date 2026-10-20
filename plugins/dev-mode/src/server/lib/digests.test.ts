import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ArenaDigests, parseReply } from "./digests.ts";
import { runSchema, type ArenaRun, type Job, type Report } from "../../shared/arena.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const model = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "xhigh",
  serviceTier: "fast",
} as const;
const candidate: Report = {
  kind: "candidate",
  summary: "Persisted cancellation in arena_runs.payload with a reconcile() pass on boot.",
  tradeoff: "More persistence code; registry rejected.",
};
const synthesis: Report = {
  kind: "synthesis",
  summary: "Base C1 + C2 reconcile",
  baseCandidate: 0,
  rationale: "Single SoT",
  grafts: [{ candidate: 1, change: "reconcile after uncertain spawn" }],
  rejected: ["in-mem registry"],
  checks: [{ command: "bun test", exitCode: 0, output: "" }],
};

function job(report: Report, candidateIndex: number | null): Job {
  return {
    key: randomUUID(),
    round: 1,
    role: report.kind,
    candidate: candidateIndex,
    model,
    dispatch: "started",
    threadId: "worker",
    environmentId: "env",
    path: null,
    commit: null,
    report,
    outcome: "running",
    error: null,
    retried: false,
  };
}

function fixture() {
  type Spawn = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  const spawned: Spawn[] = [];
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, unknown>();
  const outputs = new Map<string, string>();
  const state: { spawnGate?: Promise<void>; uncertain: boolean; stopPending: boolean } = {
    uncertain: false,
    stopPending: false,
  };
  const f = createFakePluginHost({
    pluginId: "scott-engineering",
    sdk: {
      threads: {
        spawn: async (input) => {
          spawned.push(input);
          const thread = makeThreadResponse({
            id: `digest_${spawned.length}`,
            originPluginId: "scott-engineering",
            status: "active",
          });
          threads.set(thread.id, thread);
          metadata.set(thread.id, input.pluginMetadata ?? {});
          await state.spawnGate;
          if (state.uncertain) throw new Error("timeout after creating rewrite");
          return thread;
        },
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return thread;
        },
        getPluginMetadata: async ({ threadId }) => (metadata.get(threadId) ?? {}) as never,
        output: async ({ threadId }) => ({ output: outputs.get(threadId) ?? null }),
        list: async ({ offset = 0, limit = 100 } = {}) =>
          [...threads.values()].slice(offset, offset + limit),
        stop: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread) thread.status = state.stopPending ? "stopping" : "idle";
          return { ok: true };
        },
        queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
      },
    },
  });
  cleanups.push(() => f.harness.lifecycle.dispose());
  const run: ArenaRun = runSchema.parse({
    version: 1,
    id: randomUUID(),
    requestId: "request",
    task: "Make cancellation reliable",
    parentThreadId: "parent",
    projectId: "project",
    environmentId: "env",
    hostId: "host",
    root: "/work",
    base: null,
    models: [model, model],
    lead: model,
    round: 1,
    phase: "candidates",
    jobs: [],
    integration: null,
    error: null,
    startedAt: 0,
    updatedAt: 0,
  });
  const digests = new ArenaDigests(f.bb, async () => "gpt-6-luna");
  /** Delivers a worker's lifecycle event, as ArenaService does under the run's gate. */
  function event(threadId: string) {
    const owner = digests.owner(metadata.get(threadId));
    assert.ok(owner);
    return digests.sync(run, { jobKey: owner.jobKey, threadId });
  }
  /** Finishes a rewrite worker with the given reply, as BB's idle event would. */
  async function reply(threadId: string, output: string) {
    outputs.set(threadId, output);
    const thread = threads.get(threadId);
    assert.ok(thread);
    thread.status = "idle";
    await event(threadId);
  }
  return { f, run, spawned, threads, metadata, outputs, digests, event, reply, state };
}

test("a cancelled run launches no rewrite", async () => {
  const f = fixture();
  f.run.phase = "stopping";
  await f.digests.start(f.run, job(candidate, 0));
  assert.equal(f.spawned.length, 0);
  assert.deepEqual(await f.digests.forRun(f.run.id), []);
});

test("a drain stops rewrites and reports a worker that has not stopped yet", async () => {
  const f = fixture();
  await f.digests.start(f.run, job(candidate, 0));
  f.run.phase = "stopping";
  f.state.stopPending = true;
  assert.equal(await f.digests.sync(f.run, "drain"), false);
  assert.equal(f.threads.get("digest_1")?.status, "stopping");
  assert.equal((await f.digests.forRun(f.run.id))[0]?.status, "running");
  f.state.stopPending = false;
  assert.equal(await f.event("digest_1"), true);
  assert.equal((await f.digests.forRun(f.run.id))[0]?.status, "failed");
  assert.equal(await f.digests.sync(f.run, "drain"), true);
  assert.deepEqual(await f.digests.pending(), []);
});

test("a drain adopts a rewrite whose launch response was lost", async () => {
  const f = fixture();
  f.state.uncertain = true;
  await f.digests.start(f.run, job(candidate, 0));
  assert.equal((await f.digests.forRun(f.run.id))[0]?.threadId, null);
  f.run.phase = "failing";
  assert.equal(await f.digests.sync(f.run, "drain"), true);
  assert.equal(f.threads.get("digest_1")?.status, "idle");
  const [digest] = await f.digests.forRun(f.run.id);
  assert.equal(digest?.threadId, "digest_1");
  assert.equal(digest?.status, "failed");
});

test("a lost launch a drain cannot find is searched once more by the next restart", async () => {
  const f = fixture();
  f.state.uncertain = true;
  await f.digests.start(f.run, job(candidate, 0));
  const child = f.threads.get("digest_1");
  assert.ok(child);
  f.threads.delete(child.id);
  f.run.phase = "stopping";
  assert.equal(await f.digests.sync(f.run, "drain"), true);
  assert.equal((await f.digests.forRun(f.run.id))[0]?.status, "failed");
  // BB created the worker while the plugin was down.
  f.threads.set(child.id, child);
  f.run.phase = "stopped";
  assert.deepEqual(await f.digests.pending(), [f.run.id]);
  assert.equal(await f.digests.sync(f.run, "restart"), true);
  assert.equal(child.status, "idle");
  assert.equal((await f.digests.forRun(f.run.id))[0]?.threadId, child.id);
  assert.deepEqual(await f.digests.pending(), []);
});

test("a restart abandons a lost launch it cannot find, but the worker's event still binds it", async () => {
  const f = fixture();
  f.state.uncertain = true;
  await f.digests.start(f.run, job(candidate, 0));
  const child = f.threads.get("digest_1");
  assert.ok(child);
  f.threads.delete(child.id);
  assert.equal(await f.digests.sync(f.run, "restart"), true);
  assert.equal((await f.digests.forRun(f.run.id))[0]?.status, "failed");
  assert.deepEqual(await f.digests.pending(), []);
  f.threads.set(child.id, child);
  f.run.phase = "stopping";
  await f.event(child.id);
  assert.equal(child.status, "idle");
  const [digest] = await f.digests.forRun(f.run.id);
  assert.equal(digest?.threadId, child.id);
  assert.equal(digest?.status, "failed");
});

test("cancellation waits for a completed rewrite worker that resumed, including after reload", async () => {
  const f = fixture();
  await f.digests.start(f.run, job(candidate, 0));
  await f.reply("digest_1", '{"summary":"Readable result","tradeoff":"One store"}');
  const child = f.threads.get("digest_1");
  assert.ok(child);
  child.status = "active";
  f.run.phase = "stopping";
  f.state.stopPending = true;
  assert.equal(await f.digests.sync(f.run, "drain"), false);
  assert.equal(child.status, "stopping");
  assert.equal((await f.digests.forRun(f.run.id))[0]?.status, "done");
  const restarted = new ArenaDigests(f.f.bb, async () => "gpt-6-luna");
  assert.deepEqual(await restarted.pending(), [f.run.id]);
  f.state.stopPending = false;
  assert.equal(await restarted.sync(f.run, "restart"), true);
  assert.equal(child.status, "idle");
  assert.deepEqual(await restarted.pending(), []);
  assert.equal((await restarted.forRun(f.run.id))[0]?.result?.summary, "Readable result");
  // A later lifecycle event must enforce cancellation even after a confirmed stop.
  child.status = "active";
  f.run.phase = "stopped";
  await f.event(child.id);
  assert.equal(child.status, "idle");
});

test("a transient worker lookup error leaves the rewrite recoverable", async () => {
  const f = fixture();
  await f.digests.start(f.run, job(candidate, 0));
  f.f.harness.sdk.stub("threads.get", async () => {
    throw new Error("connection reset");
  });
  await assert.rejects(f.event("digest_1"), /connection reset/);
  assert.equal((await f.digests.forRun(f.run.id))[0]?.status, "running");
  f.f.harness.sdk.stub("threads.get", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    assert.ok(child);
    return child;
  });
  f.run.phase = "stopping";
  await f.digests.sync(f.run, "restart");
  assert.equal(f.threads.get("digest_1")?.status, "idle");
});

test("a lost stop response for a resumed rewrite stays recoverable after reload", async () => {
  const f = fixture();
  await f.digests.start(f.run, job(candidate, 0));
  await f.reply("digest_1", '{"summary":"Readable result","tradeoff":"One store"}');
  f.run.phase = "stopped";
  await f.digests.sync(f.run, "drain");
  const child = f.threads.get("digest_1");
  assert.ok(child);
  child.status = "active";
  f.f.harness.sdk.stub("threads.stop", async () => {
    throw new Error("connection reset");
  });
  await assert.rejects(f.event(child.id), /connection reset/);
  const restarted = new ArenaDigests(f.f.bb, async () => "gpt-6-luna");
  assert.deepEqual(await restarted.pending(), [f.run.id]);
  f.f.harness.sdk.stub("threads.stop", async () => {
    child.status = "idle";
    return { ok: true };
  });
  await restarted.sync(f.run, "restart");
  assert.equal(child.status, "idle");
  assert.deepEqual(await restarted.pending(), []);
});

test("a finished candidate gets one hidden GPT-6 Luna fast rewrite that lands on the card", async () => {
  const { f, run, spawned, digests, reply } = fixture();
  const result = job(candidate, 0);
  await digests.start(run, result);
  await digests.start(run, result);
  assert.equal(spawned.length, 1);
  const spawn = spawned[0];
  assert.ok(spawn);
  assert.equal(spawn.providerId, "codex");
  assert.equal(spawn.model, "gpt-6-luna");
  assert.equal(spawn.serviceTier, "fast");
  assert.equal(spawn.visibility, "hidden");
  assert.equal(spawn.lifecycleOwnerThreadId, "parent");
  assert.equal(spawn.parentThreadId, undefined);
  assert.match(spawn.prompt ?? "", /reconcile\(\) pass on boot/);
  assert.equal((await digests.forRun(run.id))[0]?.status, "running");

  await reply(
    "digest_1",
    '```json\n{"summary":"Cancellation is saved with the run, so a restart can still stop every worker.","tradeoff":"Adds startup recovery code."}\n```',
  );
  const [digest] = await digests.forRun(run.id);
  assert.equal(digest?.status, "done");
  assert.deepEqual(digest?.result, {
    kind: "candidate",
    summary: "Cancellation is saved with the run, so a restart can still stop every worker.",
    tradeoff: "Adds startup recovery code.",
  });
  assert.ok(
    f.harness.inspection.realtimeSignals.some(
      (signal) =>
        signal.channel === "arena.changed" &&
        (signal.payload as { runId?: string }).runId === run.id,
    ),
  );
});

test("an unusable reply leaves the worker's original text in place", async () => {
  const { run, digests, reply } = fixture();
  await digests.start(run, job(candidate, 1));
  await reply("digest_1", "Sure! Here is a friendlier version of the summary.");
  const [digest] = await digests.forRun(run.id);
  assert.equal(digest?.status, "failed");
  assert.equal(digest?.result, null);
});

test("only candidate and synthesis results are rewritten", async () => {
  const { run, spawned, digests } = fixture();
  await digests.start(run, {
    ...job(candidate, null),
    role: "frame",
    report: { kind: "frame", summary: "s", rubric: ["a", "b", "c"], verification: ["bun test"] },
  });
  assert.equal(spawned.length, 0);
  await digests.start(run, job(synthesis, null));
  assert.equal(spawned.length, 1);
  assert.match(spawned[0]?.prompt ?? "", /From Candidate 2: reconcile after uncertain spawn/);
});

test("a rewrite that finished while the plugin was down settles on recovery", async () => {
  const { f, run, threads, outputs } = fixture();
  const first = new ArenaDigests(f.bb, async () => "gpt-6-luna");
  await first.start(run, job(synthesis, null));
  outputs.set(
    "digest_1",
    '{"summary":"Combines both.","rationale":"Candidate 1 keeps one owner.","grafts":["Rechecks workers after a lost launch."],"rejected":["A second in-memory list."]}',
  );
  const thread = threads.get("digest_1");
  assert.ok(thread);
  thread.status = "idle";
  // A replacement load shares the KV records but never received the idle event.
  const restarted = new ArenaDigests(f.bb, async () => "gpt-6-luna");
  assert.deepEqual(await restarted.pending(), [run.id]);
  await restarted.sync(run, "restart");
  const [digest] = await restarted.forRun(run.id);
  assert.equal(digest?.status, "done");
  assert.equal(digest?.result?.summary, "Combines both.");
});

test("a synthesis rewrite must keep every graft and rejected idea", () => {
  const stored = { kind: "synthesis" as const, grafts: 1, rejected: 1 };
  const complete = parseReply(
    '{"summary":"s","rationale":"r","grafts":["g"],"rejected":["x"],"extra":1}',
    stored,
  );
  assert.deepEqual(complete, {
    kind: "synthesis",
    summary: "s",
    rationale: "r",
    grafts: ["g"],
    rejected: ["x"],
  });
  assert.equal(
    parseReply('{"summary":"s","rationale":"r","grafts":[],"rejected":["x"]}', stored),
    null,
  );
  assert.equal(parseReply("not json", stored), null);
});
