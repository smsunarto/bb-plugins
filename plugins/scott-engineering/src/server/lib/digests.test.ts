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
          return thread;
        },
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return thread;
        },
        getPluginMetadata: async ({ threadId }) => (metadata.get(threadId) ?? {}) as never,
        output: async ({ threadId }) => ({ output: outputs.get(threadId) ?? null }),
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
  /** Finishes a rewrite worker with the given reply, as BB's idle event would. */
  async function reply(threadId: string, output: string) {
    outputs.set(threadId, output);
    const thread = threads.get(threadId);
    assert.ok(thread);
    thread.status = "idle";
    await digests.threadChanged(threadId);
  }
  return { f, run, spawned, threads, outputs, digests, reply };
}

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
  await restarted.recover();
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
