import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ArenaService, type Rewrites } from "./service.ts";
import plugin from "../server.ts";
import { ArenaDigests } from "./digests.ts";
import { hostContract } from "../../shared/host-contract.ts";
import type { Integration, Job, Report } from "../../shared/arena.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame: Report = {
  kind: "frame",
  summary: "Frame the task",
  rubric: ["Correct behavior", "Clear ownership", "Meaningful verification"],
  verification: ["bun test"],
};
const candidate: Report = {
  kind: "candidate",
  summary: "One coherent implementation",
  tradeoff: "Small API, fewer extension points",
};
const judge: Report = {
  kind: "judge",
  summary: "Candidate 1 is the clearer base",
  preferredCandidate: 0,
  reframe: false,
  scores: [0, 1].map((index) => ({
    candidate: index,
    criteria: [0, 1, 2].map(() => ({
      score: 4,
      rationale: "The implementation meets this criterion",
    })),
  })),
};
const synthesis: Report = {
  kind: "synthesis",
  summary: "Combined the smaller base with better errors",
  baseCandidate: 0,
  rationale: "Fewer shared assumptions",
  grafts: [{ candidate: 1, change: "Clear errors" }],
  rejected: [],
  checks: [{ command: "bun test", exitCode: 0, output: "Tests passed" }],
};

async function fixture(withDigests = false) {
  const results: string[] = [];
  type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
  type Spawn = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  type Send = Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0];
  const environment: Environment = {
    id: "env_source",
    projectId: "project",
    hostId: "host",
    path: "/work/source",
    status: "ready",
    baseBranch: "main",
    branchName: "main",
    createdAt: 0,
    updatedAt: 0,
    defaultBranch: "main",
    environmentProviderId: null,
    environmentProviderInstanceKey: null,
    environmentProviderSelection: null,
    hostLifecycle: "active",
    isGitRepo: true,
    isWorktree: false,
    managed: false,
    mergeBaseBranch: null,
    name: null,
    lifecycle: { phase: "active", retireAt: null, teardown: null },
    workspaceProvisionType: "unmanaged",
  };
  const parent = makeThreadResponse({
    id: "parent",
    projectId: "project",
    environmentId: environment.id,
    providerId: "codex",
    status: "active",
  });
  const threads = new Map([[parent.id, parent]]);
  const environments = new Map([[environment.id, environment]]);
  const metadata = new Map<string, NonNullable<Spawn["pluginMetadata"]>>();
  const spawned: Spawn[] = [];
  const sent: Send[] = [];
  const lateWorkers: (() => void)[] = [];
  const outputs = new Map<string, string>();
  const receipts = new Map<string, Integration>();
  const snapshots: unknown[] = [];
  const ancestors: string[] = [];
  const state: {
    uncertain: boolean;
    noDispatch: boolean;
    snapshotError: boolean;
    offline: boolean;
    spawnError: string;
    /** Holds result rewrite spawns, as a slow BB response would. */
    rewriteGate?: Promise<void>;
    /** Rewrite spawns create their worker, then lose the response. */
    rewriteUncertain: boolean;
    /** Rewrite spawns lose the response and BB creates the worker only when `late()` runs. */
    rewriteLate: boolean;
    integrationWait?: Promise<Integration>;
    fatalPin: boolean;
    /** The next message to the launching chat fails, as an unreachable BB server would. */
    sendError: boolean;
    integration: Integration;
  } = {
    uncertain: false,
    noDispatch: false,
    snapshotError: false,
    offline: false,
    spawnError: "timeout after dispatch",
    rewriteUncertain: false,
    rewriteLate: false,
    fatalPin: false,
    sendError: false,
    integration: {
      status: "integrated",
      summary: "Verified and integrated",
      checks: [{ command: "bun test", exitCode: 0, output: "Tests passed" }],
    },
  };
  const f = createFakePluginHost({
    pluginId: "scott-engineering",
    experimental_callHostRpc: async (request) => {
      if (request.method === "snapshot" && (state.snapshotError || state.offline)) {
        state.snapshotError = false;
        throw Object.assign(new Error("host offline"), { body: { code: "host_unavailable" } });
      }
      if (
        request.method === "snapshot" &&
        state.fatalPin &&
        hostContract.snapshot.input.parse(request.input).path !== "/work/source"
      )
        throw new Error("git add failed: fetch timed out inside a deterministic error");
      if (request.method === "snapshot") {
        snapshots.push(request.input);
        return { root: "/work/source", base: "a".repeat(40) };
      }
      if (request.method === "prepare")
        return {
          status: "prepared",
          proposalCommit: "b".repeat(40),
          sourceTree: "c".repeat(40),
          combinedTree: "d".repeat(40),
        };
      const { runId } = (
        request.method === "receipt" ? hostContract.receipt.input : hostContract.integrate.input
      ).parse(request.input);
      if (request.method === "receipt") return receipts.get(runId) ?? null;
      const result = await (state.integrationWait ?? state.integration);
      if (result.status === "integrated") receipts.set(runId, result);
      return result;
    },
    sdk: {
      environments: {
        get: async ({ environmentId }) => {
          const env = environments.get(environmentId);
          if (!env) throw new Error("Missing environment");
          return env;
        },
      },
      threads: {
        defaultExecutionOptions: async () => ({ permissionMode: "auto" }),
        experimental_listAncestors: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({ threadId, ancestorIds: ancestors })),
        }),
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return threadId === parent.id ? { ...thread, environment } : thread;
        },
        list: async () =>
          [...threads.values()].filter((thread) => thread.originPluginId === "scott-engineering"),
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        output: async ({ threadId }) => ({ output: outputs.get(threadId) ?? null }),
        spawn: async (input) => {
          spawned.push(input);
          const rewrite = "arenaDigest" in (input.pluginMetadata ?? {});
          if (rewrite) await state.rewriteGate;
          if (rewrite && state.rewriteLate) {
            const id = `worker_${spawned.length}`;
            lateWorkers.push(() => {
              threads.set(
                id,
                makeThreadResponse({
                  id,
                  projectId: "project",
                  environmentId: environment.id,
                  providerId: input.providerId,
                  originPluginId: "scott-engineering",
                  status: "active",
                }),
              );
              metadata.set(id, input.pluginMetadata ?? {});
            });
            throw new Error("timeout before the rewrite was created");
          }
          if (state.noDispatch) {
            state.noDispatch = false;
            throw new Error("timeout before submission");
          }
          const id = `worker_${spawned.length}`;
          const envId = input.environment.type === "reuse" ? environment.id : `env_${id}`;
          if (envId !== environment.id)
            environments.set(envId, {
              ...environment,
              id: envId,
              path: `/work/${id}`,
              isWorktree: true,
              managed: true,
            });
          const thread = makeThreadResponse({
            id,
            parentThreadId: input.parentThreadId ?? null,
            projectId: "project",
            environmentId: envId,
            providerId: input.providerId,
            originPluginId: "scott-engineering",
            status: "active",
          });
          threads.set(id, thread);
          metadata.set(id, input.pluginMetadata ?? {});
          if (rewrite && state.rewriteUncertain) throw new Error("timeout after creating rewrite");
          if (state.uncertain) {
            state.uncertain = false;
            throw new Error(state.spawnError);
          }
          return thread;
        },
        stop: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread) thread.status = "idle";
          return { ok: true };
        },
        archive: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          thread.archivedAt ??= Date.now();
          return { ok: true, archivedThreadIds: [threadId] };
        },
        queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
        send: async (input) => {
          if (state.sendError) {
            state.sendError = false;
            throw new Error("socket hang up");
          }
          // BB answers a missing or deleted sender with a 400.
          if (input.senderThreadId && threads.get(input.senderThreadId)?.deletedAt !== null)
            throw new Error("Sender thread is invalid");
          sent.push(input);
          return { ok: true as const, delivery: "sent" as const };
        },
      },
    },
  });
  const recorder: Rewrites = {
    start: async (_run, job) => {
      results.push(`${job.role}${job.candidate === null ? "" : ` ${job.candidate + 1}`}`);
    },
    sync: async () => true,
    owner: () => null,
    pending: async () => [],
  };
  const digests = new ArenaDigests(f.bb, async () => "digest-model");
  const create = () =>
    new ArenaService(
      f.bb,
      async () => ({ claudeModel: "claude", codexModel: "codex" }),
      withDigests ? digests : recorder,
    );
  let service = create();
  cleanups.push(async () => {
    await service.dispose();
    await f.harness.lifecycle.dispose();
  });
  async function start(requestId = "request") {
    const run = await service.start(parent.id, { task: "Implement the task", requestId });
    await tick();
    return service.get(run.id);
  }
  async function finish(
    id: string,
    role: Job["role"],
    report: Report,
    candidateIndex: number | null = null,
  ) {
    const run = service.get(id);
    const job = run.jobs.find(
      (job) => job.round === run.round && job.role === role && job.candidate === candidateIndex,
    );
    assert.ok(job?.threadId, `No active ${role}`);
    if (role === "synthesis") await service.prepare(id, job.threadId);
    await service.report(id, job.threadId, report);
    const child = threads.get(job.threadId);
    assert.ok(child);
    child.status = "idle";
    await service.threadChanged(child.id);
    return service.get(id);
  }
  async function candidates(id: string) {
    await finish(id, "frame", frame);
    await finish(id, "candidate", candidate, 0);
    return finish(id, "candidate", candidate, 1);
  }
  return {
    f,
    parent,
    threads,
    metadata,
    outputs,
    spawned,
    sent,
    snapshots,
    ancestors,
    receipts,
    state,
    start,
    finish,
    candidates,
    async stop(id: string) {
      await service.stop(id, parent.id);
      for (let i = 0; i < 20; i++) {
        await tick();
        if (service.get(id).phase !== "stopping") break;
      }
      return service.get(id);
    },
    results,
    digests,
    /** BB creates every rewrite worker whose launch response was lost. */
    late() {
      for (const create of lateWorkers.splice(0)) create();
    },
    /** Finishes a worker as BB's idle event would. */
    async idle(threadId: string) {
      const child = threads.get(threadId);
      assert.ok(child);
      child.status = "idle";
      await service.threadChanged(threadId);
    },
    get service() {
      return service;
    },
    async restart() {
      await service.dispose();
      service = create();
      await service.recover(new AbortController().signal);
    },
  };
}

test("runs both candidates before judging and integrates after synthesis", async () => {
  const f = await fixture();
  const run = await f.start();
  assert.equal(run.phase, "framing");
  const candidates = await f.finish(run.id, "frame", frame);
  assert.equal(candidates.phase, "candidates");
  assert.equal(f.spawned.length, 3);
  const first = await f.finish(run.id, "candidate", candidate, 0);
  assert.equal(first.phase, "candidates");
  assert.equal(f.spawned.length, 3);
  await f.finish(run.id, "candidate", candidate, 1);
  assert.equal(f.service.get(run.id).phase, "judging");
  await f.finish(run.id, "judge", judge);
  const result = await f.finish(run.id, "synthesis", synthesis);
  assert.equal(result.phase, "completed");
  assert.equal(result.integration?.status, "integrated");
  assert.equal(f.parent.status, "active");
  // Every accepted result reaches the rewrites, which decide what to rewrite.
  assert.deepEqual(f.results, ["frame", "candidate 1", "candidate 2", "judge", "synthesis"]);
});

test("repeated launches reuse their stable request identity", async () => {
  const f = await fixture();
  const first = await f.start();
  const second = await f.start();
  assert.equal(first.id, second.id);
  assert.equal(f.spawned.length, 1);
  await assert.rejects(
    f.service.start(f.parent.id, { requestId: "request", task: "Different task" }),
  );
});

test("candidate inputs hide the rubric and competitors", async () => {
  const f = await fixture();
  const run = await f.start();
  const next = await f.finish(run.id, "frame", frame);
  const worker = next.jobs.find((job) => job.role === "candidate" && job.candidate === 0);
  assert.ok(worker?.threadId);
  const context = await f.service.context(run.id, worker.threadId);
  assert.equal("frame" in context, false);
  assert.equal("candidates" in context, false);
  assert.equal(context.task, "Implement the task");
  await assert.rejects(f.service.report(run.id, worker.threadId, judge));
  await assert.rejects(f.service.context(run.id, "unrelated"));
});

test("the engine waits for worker idle after accepting a report", async () => {
  const f = await fixture();
  const run = await f.start();
  const job = run.jobs[0];
  assert.ok(job?.threadId);
  await f.service.report(run.id, job.threadId, frame);
  await f.service.threadChanged(job.threadId);
  assert.equal(f.service.get(run.id).phase, "framing");
  assert.equal(f.spawned.length, 1);
});

test("three total rounds is a persisted ceiling", async () => {
  const f = await fixture();
  const run = await f.start();
  for (let round = 1; round <= 3; round++) {
    assert.equal(f.service.get(run.id).round, round);
    await f.candidates(run.id);
    await f.finish(run.id, "judge", { ...judge, reframe: true });
    if (round === 1) await f.restart();
  }
  assert.equal(f.service.get(run.id).phase, "failed");
  assert.equal(f.service.get(run.id).round, 3);
  assert.equal(f.spawned.length, 12);
  await f.restart();
  assert.equal(f.spawned.length, 12);
});

test("restart adopts an uncertain spawn instead of duplicating it", async () => {
  const f = await fixture();
  f.state.uncertain = true;
  const run = await f.start();
  assert.equal(f.spawned.length, 1);
  assert.equal(run.jobs[0]?.threadId, "worker_1");
  await f.restart();
  assert.equal(f.spawned.length, 1);
  assert.equal(f.service.get(run.id).jobs[0]?.threadId, "worker_1");
  await f.finish(run.id, "frame", frame);
  assert.equal(f.spawned.length, 3);
});

test("Stop Arena cancels its workers and does not stop the main chat", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  const result = await f.stop(run.id);
  assert.equal(result.phase, "stopped");
  assert.equal(f.parent.status, "active");
  assert.deepEqual(
    [...f.threads.values()]
      .filter((thread) => thread.originPluginId === "scott-engineering")
      .map((thread) => thread.status),
    ["idle", "idle", "idle"],
  );
  await f.restart();
  assert.equal(f.spawned.length, 3);
  assert.equal(f.service.get(run.id).phase, "stopped");
});

test("Arena remains stopping until its result rewrite has stopped", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  await f.finish(run.id, "candidate", candidate, 0);
  const [digest] = await f.digests.forRun(run.id);
  assert.ok(digest?.threadId);
  const digestThreadId = digest.threadId;
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = threadId === digestThreadId ? "stopping" : "idle";
    return { ok: true };
  });
  assert.equal((await f.stop(run.id)).phase, "stopping");
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  await f.service.threadChanged(digestThreadId);
  assert.equal(f.service.get(run.id).phase, "stopped");
  assert.equal(f.parent.status, "active");
});

test("fatal Arena failure also stops its result rewrites", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.state.fatalPin = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal(f.service.get(run.id).phase, "failed");
  const [digest] = await f.digests.forRun(run.id);
  assert.equal(digest?.status, "failed");
  assert.equal(digest?.threadId && f.threads.get(digest.threadId)?.status, "idle");
});

test("exhausting Arena rounds drains the rewrites from every round", async () => {
  const f = await fixture(true);
  f.state.integration = {
    status: "verification-failed",
    summary: "The check failed",
    checks: [{ command: "bun test", exitCode: 1, output: "Failure" }],
  };
  const run = await f.start();
  for (let round = 1; round <= 3; round++) {
    await f.candidates(run.id);
    await f.finish(run.id, "judge", judge);
    await f.finish(run.id, "synthesis", synthesis);
  }
  assert.equal(f.service.get(run.id).phase, "failed");
  const digests = await f.digests.forRun(run.id);
  assert.equal(digests.length, 9);
  assert.ok(digests.every((digest) => digest.status === "failed"));
  assert.ok(
    digests.every((digest) => digest.threadId && f.threads.get(digest.threadId)?.status === "idle"),
  );
});

test("routine events and confirmed launches recover without listing historical threads", async () => {
  const f = await fixture(true);
  f.f.harness.sdk.stub("threads.list", async () => {
    throw new Error("Routine processing must not scan thread history");
  });
  const run = await f.start();
  await f.restart();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  await f.finish(run.id, "synthesis", synthesis);
  assert.equal(f.service.get(run.id).phase, "completed");
  for (const job of f.service.get(run.id).jobs) {
    assert.ok(job.threadId);
    await f.service.threadChanged(job.threadId);
  }
  const [first, ...rest] = await f.digests.forRun(run.id);
  assert.ok(first?.threadId);
  await f.idle(first.threadId);
  await f.restart();
  assert.equal(f.service.get(run.id).phase, "completed");
  assert.equal(rest.length, 2);
  assert.ok(rest.every((digest) => digest.threadId));
});

test("verification failures consume rounds and never report integration", async () => {
  const f = await fixture();
  f.state.integration = {
    status: "verification-failed",
    summary: "Behavior check failed",
    checks: [{ command: "bun test", exitCode: 1, output: "Expected the new behavior" }],
  };
  const run = await f.start();
  for (let round = 1; round <= 3; round++) {
    await f.candidates(run.id);
    await f.finish(run.id, "judge", judge);
    await f.finish(run.id, "synthesis", synthesis);
  }
  const result = f.service.get(run.id);
  assert.equal(result.phase, "failed");
  assert.equal(result.round, 3);
  assert.equal(result.integration?.status, "verification-failed");
});

test("a judge must score both completed candidates exactly once", async () => {
  const f = await fixture();
  const run = await f.start();
  const state = await f.candidates(run.id);
  const worker = state.jobs.find((job) => job.role === "judge");
  assert.ok(worker?.threadId);
  assert.equal(judge.kind, "judge");
  await assert.rejects(
    f.service.report(run.id, worker.threadId, { ...judge, scores: judge.scores.slice(0, 1) }),
  );
});

test("Stop Arena reconciles a timed-out dispatch before claiming it stopped", async () => {
  const f = await fixture();
  f.state.uncertain = true;
  const run = await f.start();
  assert.equal(run.jobs[0]?.threadId, "worker_1");
  const stopped = await f.stop(run.id);
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.jobs[0]?.threadId, "worker_1");
  assert.equal(f.threads.get("worker_1")?.status, "idle");
  assert.equal(f.spawned.length, 1);
});

test("Stop Arena tolerates a worker deleted before cancellation", async () => {
  const f = await fixture();
  const run = await f.start();
  f.threads.delete("worker_1");
  const stopped = await f.stop(run.id);
  assert.equal(stopped.phase, "stopped");
  assert.equal(f.parent.status, "active");
});

test("restart retires an abandoned launch reservation and resumes within the round limit", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  assert.equal(run.jobs[0]?.threadId, null);
  await f.restart();
  const recovered = f.service.get(run.id);
  assert.equal(recovered.round, 2);
  assert.equal(recovered.phase, "framing");
  assert.equal(recovered.jobs[0]?.dispatch, "retired");
  const stopped = await f.stop(run.id);
  assert.equal(stopped.phase, "stopped");
});

test("a worker arriving for a retired reservation is stopped", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  await f.restart();
  const input = f.spawned[0];
  assert.ok(input);
  const late = makeThreadResponse({
    id: "late",
    projectId: "project",
    parentThreadId: "parent",
    originPluginId: "scott-engineering",
    providerId: input.providerId,
    status: "active",
  });
  f.threads.set(late.id, late);
  f.metadata.set(late.id, input.pluginMetadata ?? {});
  await f.service.threadChanged(late.id);
  assert.equal(late.status, "idle");
  assert.equal(f.service.get(run.id).jobs[0]?.stopConfirmed, true);
  assert.equal(f.service.get(run.id).round, 2);
  await f.stop(run.id);
  f.f.harness.sdk.stub("threads.list", async () => {
    throw new Error("A confirmed retired worker must not trigger startup scans");
  });
  await f.restart();
  assert.equal(f.service.get(run.id).phase, "stopped");
});

test("Stop uses fresh run state after authorization yields", async () => {
  const f = await fixture();
  const run = await f.start();
  const original = f.service.authorize.bind(f.service);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.service.authorize = async (id, caller) => {
    const authorized = await original(id, caller);
    if (caller === f.parent.id) await gate;
    return authorized;
  };
  const stopping = f.stop(run.id);
  await tick();
  await f.finish(run.id, "frame", frame);
  assert.equal(f.spawned.length, 3);
  release?.();
  const stopped = await stopping;
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.jobs.length, 3);
  assert.ok(
    [...f.threads.values()].every(
      (thread) => thread.id === f.parent.id || thread.status === "idle",
    ),
  );
});

test("fatal output capture drains remaining workers before terminal failure", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.state.fatalPin = true;
  await f.finish(run.id, "candidate", candidate, 0);
  const failed = f.service.get(run.id);
  assert.equal(failed.phase, "failed");
  assert.ok(
    [...f.threads.values()].every(
      (thread) => thread.id === f.parent.id || thread.status === "idle",
    ),
  );
});

test("a transient initial host failure resumes without child lifecycle events", async () => {
  const f = await fixture();
  f.state.snapshotError = true;
  const run = await f.start();
  assert.equal(run.phase, "snapshot");
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.equal(f.service.get(run.id).phase, "framing");
});

test("startup drains a late worker even after its run was stopped", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  await f.stop(run.id);
  const input = f.spawned[0];
  assert.ok(input);
  const late = makeThreadResponse({
    id: "late-offline",
    projectId: "project",
    parentThreadId: "parent",
    originPluginId: "scott-engineering",
    providerId: input.providerId,
    status: "active",
  });
  f.threads.set(late.id, late);
  f.metadata.set(late.id, input.pluginMetadata ?? {});
  await f.restart();
  assert.equal(late.status, "idle");
  assert.notEqual(late.archivedAt, null);
  assert.equal(f.service.get(run.id).phase, "stopped");
});

test("recovery uses a persisted three-retry budget with backoff", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  f.state.offline = true;
  const run = await f.start();
  for (const [index, delay] of [5000, 10000, 20000].entries()) {
    ctx.mock.timers.tick(delay);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(f.service.get(run.id).recoveryAttempts, index + 1);
  }
  assert.equal(f.service.get(run.id).phase, "failed");
  await f.restart();
  assert.equal(f.service.get(run.id).recoveryAttempts, 3);
  assert.equal(f.spawned.length, 0);
});

test("a server error after creation reconciles the worker instead of orphaning it", async () => {
  const f = await fixture();
  f.state.uncertain = true;
  f.state.spawnError = "HTTP 500 after thread creation";
  const run = await f.start();
  assert.equal(run.jobs[0]?.threadId, "worker_1");
  await f.stop(run.id);
  assert.equal(f.threads.get("worker_1")?.status, "idle");
  assert.equal(f.spawned.length, 1);
});

test("Stop returns promptly while another run owns the integration gate", async () => {
  const f = await fixture();
  const one = await f.start("first");
  await f.candidates(one.id);
  await f.finish(one.id, "judge", judge);
  let release: ((value: Integration) => void) | undefined;
  f.state.integrationWait = new Promise((resolve) => {
    release = resolve;
  });
  const first = f.finish(one.id, "synthesis", synthesis);
  await tick();
  const two = await f.start("second");
  await f.candidates(two.id);
  await f.finish(two.id, "judge", judge);
  const second = f.finish(two.id, "synthesis", synthesis);
  await tick();
  const result = await f.service.stop(two.id, f.parent.id);
  assert.equal(result.phase, "stopping");
  release?.(f.state.integration);
  await first;
  await second;
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(f.service.get(two.id).phase, "stopped");
  assert.equal(f.service.get(one.id).phase, "completed");
});

test("workers inherit permissions and lifecycle ownership without parent notifications", async () => {
  const f = await fixture();
  await f.start();
  assert.equal(f.spawned[0]?.parentThreadId, undefined);
  assert.equal(f.spawned[0]?.lifecycleOwnerThreadId, f.parent.id);
  assert.equal(f.spawned[0]?.visibility, "hidden");
  assert.equal(f.spawned[0]?.permissionMode, "auto");
});

test("workers cannot use parent status controls to see the full run", async () => {
  const f = await fixture();
  const run = await f.start();
  const worker = run.jobs[0]?.threadId;
  assert.ok(worker);
  await assert.rejects(f.service.owner(run.id, worker), /Only the launching/);
  await assert.rejects(f.service.stop(run.id, worker), /Only the launching/);
  assert.equal((await f.service.owner(run.id, f.parent.id)).id, run.id);
});

test("descendants of Arena workers cannot launch a nested run", async () => {
  const f = await fixture();
  f.threads.set(
    "arena-ancestor",
    makeThreadResponse({ id: "arena-ancestor", originPluginId: "scott-engineering" }),
  );
  f.ancestors.push("arena-ancestor");
  await assert.rejects(f.start(), /Descendants of Arena/);
  assert.equal(f.spawned.length, 0);
});

test("synthesis must prepare and report the exact verification contract", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  const worker = f.service.get(run.id).jobs.find((job) => job.role === "synthesis")?.threadId;
  assert.ok(worker);
  await assert.rejects(f.service.report(run.id, worker, synthesis), /Prepare/);
  const prepared = await f.service.prepare(run.id, worker);
  assert.deepEqual(prepared.verification, ["bun test"]);
  assert.equal(synthesis.kind, "synthesis");
  await assert.rejects(
    f.service.report(run.id, worker, {
      ...synthesis,
      checks: [{ command: "echo passed", exitCode: 0, output: "" }],
    }),
    /each framing/,
  );
  await f.service.report(run.id, worker, synthesis);
});

test("a failed integration supplies real feedback and snapshots current work in a new round", async () => {
  const f = await fixture();
  f.state.integration = {
    status: "changed",
    summary: "Source changed during checks",
    checks: [{ command: "bun test", exitCode: 0, output: "Actual test output" }],
  };
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  const next = await f.finish(run.id, "synthesis", synthesis);
  assert.equal(next.round, 2);
  assert.equal(next.integration, null);
  assert.notEqual(next.snapshotId, run.snapshotId);
  assert.ok(f.snapshots.some((input) => (input as { runId: string }).runId === next.snapshotId));
  const worker = next.jobs.find((job) => job.round === 2)?.threadId;
  assert.ok(worker);
  const context = await f.service.context(run.id, worker);
  assert.deepEqual(context.feedback?.integration, f.state.integration);
});

test("Stop reconciles a successful host apply instead of reporting stopped", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  let release: ((value: Integration) => void) | undefined;
  f.state.integrationWait = new Promise((resolve) => {
    release = resolve;
  });
  const pending = f.finish(run.id, "synthesis", synthesis);
  await tick();
  assert.equal(f.service.get(run.id).phase, "integrating");
  assert.equal((await f.service.stop(run.id, f.parent.id)).phase, "stopping");
  release?.(f.state.integration);
  await pending;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "completed");
  assert.equal(f.service.get(run.id).integration?.status, "integrated");
});

const owner = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.sent.map((message) => ({
    threadId: message.threadId,
    senderThreadId: message.senderThreadId,
    mode: message.mode,
    text: message.input[0]?.type === "text" ? message.input[0].text : "",
  }));
const workerThread = (f: Awaited<ReturnType<typeof fixture>>, runId: string, role: string) =>
  f.service.get(runId).jobs.findLast((job) => job.role === role)?.threadId;

test("a completed run wakes its launching chat and a restart does not repeat it", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  assert.deepEqual(f.sent, []);
  await f.finish(run.id, "synthesis", synthesis);
  for (let i = 0; i < 5; i++) await tick();
  const [message, ...rest] = owner(f);
  assert.deepEqual(rest, []);
  assert.equal(message?.threadId, f.parent.id);
  assert.equal(message?.senderThreadId, workerThread(f, run.id, "synthesis"));
  assert.equal(message?.mode, "queue-if-active");
  assert.match(message?.text ?? "", new RegExp(`${run.id} completed: Verified and integrated`));
  await f.restart();
  assert.equal(f.sent.length, 1);
});

test("a wake comes from the newest Arena worker that still exists, never from the user", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  let release: ((value: Integration) => void) | undefined;
  f.state.integrationWait = new Promise((resolve) => {
    release = resolve;
  });
  const pending = f.finish(run.id, "synthesis", synthesis);
  await tick();
  assert.equal(f.service.get(run.id).phase, "integrating");
  f.threads.delete(workerThread(f, run.id, "synthesis") ?? "");
  const judgeThread = f.threads.get(workerThread(f, run.id, "judge") ?? "");
  if (judgeThread) judgeThread.deletedAt = Date.now();
  release?.(f.state.integration);
  await pending;
  for (let i = 0; i < 5; i++) await tick();
  const [message, ...rest] = owner(f);
  assert.deepEqual(rest, []);
  assert.equal(message?.senderThreadId, workerThread(f, run.id, "candidate"));
});

test("a run that fails before any worker starts still wakes its launching chat", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  f.state.offline = true;
  const run = await f.start();
  for (const delay of [5000, 10000, 20000]) {
    ctx.mock.timers.tick(delay);
    for (let i = 0; i < 10; i++) await tick();
  }
  assert.equal(f.service.get(run.id).phase, "failed");
  assert.deepEqual(
    owner(f).map((message) => message.senderThreadId),
    [undefined],
  );
});

test("a failed run wakes its launching chat and Stop does not", async () => {
  const f = await fixture();
  f.state.integration = {
    status: "verification-failed",
    summary: "Behavior check failed",
    checks: [{ command: "bun test", exitCode: 1, output: "Expected the new behavior" }],
  };
  const run = await f.start();
  for (let round = 1; round <= 3; round++) {
    await f.candidates(run.id);
    await f.finish(run.id, "judge", judge);
    await f.finish(run.id, "synthesis", synthesis);
  }
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "failed");
  assert.equal(owner(f).length, 1);
  assert.match(owner(f)[0]?.text ?? "", new RegExp(`${run.id} failed: Behavior check failed`));
  const stopped = await f.start("stopped");
  await f.stop(stopped.id);
  await f.restart();
  assert.equal(f.sent.length, 1);
});

test("a failed wake retries with backoff, then falls back to restart", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  f.state.sendError = true;
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  await f.finish(run.id, "synthesis", synthesis);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "completed");
  assert.deepEqual(f.sent, []);
  ctx.mock.timers.tick(5000);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(owner(f).length, 1);
  assert.equal(f.service.get(run.id).ownerNotice, "sent");

  const lost = await f.start("lost");
  f.f.harness.sdk.stub("threads.send", async () => {
    throw new Error("socket hang up");
  });
  await f.candidates(lost.id);
  await f.finish(lost.id, "judge", judge);
  await f.finish(lost.id, "synthesis", synthesis);
  for (const delay of [5000, 10000, 20000]) {
    ctx.mock.timers.tick(delay);
    for (let i = 0; i < 5; i++) await tick();
  }
  assert.equal(f.service.get(lost.id).ownerNotice, "pending");
  f.f.harness.sdk.stub("threads.send", async (input) => {
    f.sent.push(input);
    return { ok: true as const, delivery: "sent" as const };
  });
  await f.restart();
  assert.equal(owner(f).length, 2);
  assert.match(owner(f)[1]?.text ?? "", new RegExp(`${lost.id} completed`));
});

test("Stop on a failing run keeps its failure and wakes the launching chat", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "stopping";
    return { ok: true };
  });
  f.state.fatalPin = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal(f.service.get(run.id).phase, "failing");
  assert.deepEqual(f.sent, []);
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  assert.equal((await f.service.stop(run.id, f.parent.id)).phase, "failing");
  for (let i = 0; i < 20 && f.service.get(run.id).phase === "failing"; i++) await tick();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "failed");
  assert.equal(owner(f).length, 1);
  assert.match(owner(f)[0]?.text ?? "", new RegExp(`${run.id} failed: git add failed`));
});

test("a run that finishes during recovery keeps one wake retry chain that dispose clears", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "stopping";
    return { ok: true };
  });
  f.state.fatalPin = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal(f.service.get(run.id).phase, "failing");
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  let attempts = 0;
  f.f.harness.sdk.stub("threads.send", async () => {
    attempts += 1;
    throw new Error("socket hang up");
  });
  await f.restart();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "failed");
  assert.equal(attempts, 1);
  ctx.mock.timers.tick(5000);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(attempts, 2);
  await f.service.dispose();
  ctx.mock.timers.tick(3600000);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(attempts, 2);
});

test("a failed run's wake reports why it failed, not its cleanup progress", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.f.harness.sdk.stub("threads.stop", async () => {
    throw new Error("stop rejected");
  });
  f.state.fatalPin = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal(f.service.get(run.id).phase, "failing");
  assert.match(f.service.get(run.id).error ?? "", /stop rejected/);
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  await f.service.stop(run.id, f.parent.id);
  for (let i = 0; i < 20 && f.service.get(run.id).phase === "failing"; i++) await tick();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "failed");
  const text = owner(f)[0]?.text ?? "";
  assert.match(text, new RegExp(`${run.id} failed: git add failed`));
  assert.doesNotMatch(text, /stop rejected|Retry/);
});

test("successful progress resets recovery for separate transient episodes", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  async function recover() {
    ctx.mock.timers.tick(5000);
    for (let i = 0; i < 15; i++) await tick();
    assert.equal(f.service.get(run.id).recoveryAttempts, 0);
  }
  f.state.snapshotError = true;
  const run = await f.start();
  await recover();
  assert.equal(f.service.get(run.id).phase, "framing");
  await f.finish(run.id, "frame", frame);
  for (const index of [0, 1]) {
    f.state.snapshotError = true;
    await f.finish(run.id, "candidate", candidate, index);
    await recover();
  }
  assert.equal(f.service.get(run.id).phase, "judging");
  await f.finish(run.id, "judge", judge);
  f.state.snapshotError = true;
  await f.finish(run.id, "synthesis", synthesis);
  await recover();
  assert.equal(f.service.get(run.id).phase, "completed");
});

/** Waits for the run to leave `stopping`, as the card's poll would. */
async function settled(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  for (let i = 0; i < 40 && f.service.get(id).phase === "stopping"; i++) await tick();
  return f.service.get(id);
}
const rewriteSpawns = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.spawned.filter((input) => "arenaDigest" in (input.pluginMetadata ?? {}));

test("Stop waits for a rewrite launch in flight, then stops that worker", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  let release = () => {};
  f.state.rewriteGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = f.service.get(run.id).jobs.find((job) => job.candidate === 0)?.threadId;
  assert.ok(worker);
  await f.service.report(run.id, worker, candidate);
  while (!rewriteSpawns(f).length) await tick();
  assert.equal((await f.service.stop(run.id, f.parent.id)).phase, "stopping");
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "stopping");
  release();
  assert.equal((await settled(f, run.id)).phase, "stopped");
  const [digest] = await f.digests.forRun(run.id);
  assert.equal(digest?.status, "failed");
  assert.equal(digest?.threadId && f.threads.get(digest.threadId)?.status, "idle");
  assert.equal(f.parent.status, "active");
  assert.equal(rewriteSpawns(f).length, 1);
});

test("Stop adopts a rewrite whose launch response was lost and stops it", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.state.rewriteUncertain = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal((await f.digests.forRun(run.id))[0]?.threadId, null);
  assert.equal((await f.stop(run.id)).phase, "stopped");
  const [digest] = await f.digests.forRun(run.id);
  assert.ok(digest?.threadId);
  assert.equal(digest.status, "failed");
  assert.equal(f.threads.get(digest.threadId)?.status, "idle");
  assert.equal(f.parent.status, "active");
});

test("a rewrite worker that appears after Stop is stopped by its own event", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.state.rewriteLate = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal((await f.stop(run.id)).phase, "stopped");
  f.late();
  const late = [...f.threads.values()].find(
    (thread) => thread.status === "active" && "arenaDigest" in (f.metadata.get(thread.id) ?? {}),
  );
  assert.ok(late);
  await f.service.threadChanged(late.id);
  assert.equal(late.status, "idle");
  const [digest] = await f.digests.forRun(run.id);
  assert.equal(digest?.threadId, late.id);
  assert.equal(digest?.status, "failed");
  assert.equal(f.service.get(run.id).phase, "stopped");
});

test("a rewrite worker that appears while the plugin is down after Stop is stopped on restart", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.state.rewriteLate = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal((await f.stop(run.id)).phase, "stopped");
  f.late();
  await f.restart();
  const [digest] = await f.digests.forRun(run.id);
  assert.ok(digest?.threadId);
  assert.equal(f.threads.get(digest.threadId)?.status, "idle");
  assert.equal(digest.status, "failed");
  f.f.harness.sdk.stub("threads.list", async () => {
    throw new Error("A settled rewrite must not trigger startup scans");
  });
  await f.restart();
  assert.equal(f.service.get(run.id).phase, "stopped");
});

test("a restart looks for a lost rewrite once and then stops searching history", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  f.state.rewriteLate = true;
  await f.finish(run.id, "candidate", candidate, 0);
  await f.restart();
  assert.equal((await f.digests.forRun(run.id))[0]?.status, "failed");
  f.f.harness.sdk.stub("threads.list", async () => {
    throw new Error("An abandoned rewrite must not trigger startup scans");
  });
  await f.restart();
  f.late();
  const late = [...f.threads.values()].find(
    (thread) => thread.status === "active" && "arenaDigest" in (f.metadata.get(thread.id) ?? {}),
  );
  assert.ok(late);
  f.outputs.set(late.id, '{"summary":"Plain words.","tradeoff":"Costs a little."}');
  await f.idle(late.id);
  const [digest] = await f.digests.forRun(run.id);
  assert.equal(digest?.status, "done");
  assert.equal(digest?.result?.summary, "Plain words.");
});

test("a restart resumes a stop that was waiting on a rewrite worker", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.finish(run.id, "frame", frame);
  await f.finish(run.id, "candidate", candidate, 0);
  const [digest] = await f.digests.forRun(run.id);
  assert.ok(digest?.threadId);
  const digestThreadId = digest.threadId;
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = threadId === digestThreadId ? "stopping" : "idle";
    return { ok: true };
  });
  assert.equal((await f.stop(run.id)).phase, "stopping");
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  await f.restart();
  assert.equal(f.service.get(run.id).phase, "stopped");
  assert.equal((await f.digests.forRun(run.id))[0]?.status, "failed");
  assert.equal(f.parent.status, "active");
});

test("a completed run lets its rewrites finish", async () => {
  const f = await fixture(true);
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  await f.finish(run.id, "synthesis", synthesis);
  assert.equal(f.service.get(run.id).phase, "completed");
  const synthesisKey = f.service.get(run.id).jobs.find((job) => job.role === "synthesis")?.key;
  const rewrite = (await f.digests.forRun(run.id)).find((item) => item.jobKey === synthesisKey);
  assert.ok(rewrite?.threadId);
  assert.equal(f.threads.get(rewrite.threadId)?.status, "active");
  f.outputs.set(
    rewrite.threadId,
    '{"summary":"Combined.","rationale":"One owner.","grafts":["Errors."],"rejected":[]}',
  );
  await f.idle(rewrite.threadId);
  const done = (await f.digests.forRun(run.id)).find((item) => item.jobKey === synthesisKey);
  assert.equal(done?.status, "done");
  assert.equal(f.service.get(run.id).phase, "completed");
});

test("an interrupted integration drains its rewrites before failing", async () => {
  const f = await fixture(true);
  f.state.integration = { status: "interrupted", summary: "Host restarted", checks: [] };
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  await f.finish(run.id, "synthesis", synthesis);
  const failed = f.service.get(run.id);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "Host restarted");
  const digests = await f.digests.forRun(run.id);
  assert.equal(digests.length, 3);
  assert.ok(digests.every((digest) => digest.status === "failed"));
  assert.ok(
    digests.every((digest) => digest.threadId && f.threads.get(digest.threadId)?.status === "idle"),
  );
});

test("a retired launch is looked for after one restart, not on every restart", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  await f.restart();
  assert.equal(f.service.get(run.id).jobs[0]?.stopConfirmed, true);
  f.f.harness.sdk.stub("threads.list", async () => {
    throw new Error("A searched launch must not trigger startup scans");
  });
  await f.restart();
  await f.stop(run.id);
  await f.restart();
  assert.equal(f.service.get(run.id).phase, "stopped");
});

test("Stop waits for a retired worker before accepting an integration receipt", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  const synthesis = f.service.get(run.id).jobs.find((job) => job.role === "synthesis");
  assert.ok(synthesis?.threadId);
  await f.service.prepare(run.id, synthesis.threadId);
  f.receipts.set(run.id, f.state.integration);
  const input = f.spawned[0];
  assert.ok(input);
  const late = makeThreadResponse({
    id: "retired-stopping",
    projectId: "project",
    originPluginId: "scott-engineering",
    providerId: input.providerId,
    status: "active",
  });
  f.threads.set(late.id, late);
  f.metadata.set(late.id, input.pluginMetadata ?? {});
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = threadId === late.id ? "stopping" : "idle";
    return { ok: true };
  });
  assert.equal((await f.stop(run.id)).phase, "stopping");
  assert.equal(f.service.get(run.id).integration, null);
  assert.equal(f.service.get(run.id).jobs[0]?.stopConfirmed, undefined);
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  await f.service.threadChanged(late.id);
  assert.equal(f.service.get(run.id).phase, "completed");
  assert.equal(f.service.get(run.id).jobs[0]?.stopConfirmed, true);
  assert.equal(f.parent.status, "active");
});

test("fatal failure waits for a retired worker and its idle event finishes the drain", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  const input = f.spawned[0];
  assert.ok(input);
  const late = makeThreadResponse({
    id: "retired-failing",
    projectId: "project",
    originPluginId: "scott-engineering",
    providerId: input.providerId,
    status: "active",
  });
  f.threads.set(late.id, late);
  f.metadata.set(late.id, input.pluginMetadata ?? {});
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = threadId === late.id ? "stopping" : "idle";
    return { ok: true };
  });
  await f.service.threadChanged(late.id);
  await f.finish(run.id, "frame", frame);
  f.state.fatalPin = true;
  await f.finish(run.id, "candidate", candidate, 0);
  assert.equal(f.service.get(run.id).phase, "failing");
  f.f.harness.sdk.stub("threads.stop", async ({ threadId }) => {
    const child = f.threads.get(threadId);
    if (child) child.status = "idle";
    return { ok: true };
  });
  await f.service.threadChanged(late.id);
  assert.equal(f.service.get(run.id).phase, "failed");
  assert.equal(f.service.get(run.id).jobs[0]?.stopConfirmed, true);
  assert.equal(f.parent.status, "active");
});

const archived = (f: Awaited<ReturnType<typeof fixture>>, runId: string) =>
  f.service
    .get(runId)
    .jobs.map((job) => (f.threads.get(job.threadId ?? "")?.archivedAt ?? null) !== null);

test("an ended run archives its workers so BB removes their checkouts", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  assert.deepEqual(archived(f, run.id), [false, false, false, false, false]);
  await f.finish(run.id, "synthesis", synthesis);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "completed");
  assert.deepEqual(archived(f, run.id), [true, true, true, true, true]);
  const stopped = await f.start("stopped");
  await f.finish(stopped.id, "frame", frame);
  assert.equal((await f.stop(stopped.id)).phase, "stopped");
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(archived(f, stopped.id), [true, true, true]);
});

test("a restart archives the workers of a run that ended while archiving failed", async () => {
  const f = await fixture();
  const archive = async ({ threadId }: { threadId: string }) => {
    const thread = f.threads.get(threadId);
    if (thread) thread.archivedAt = Date.now();
    return { ok: true as const, archivedThreadIds: [threadId] };
  };
  const run = await f.start();
  const frameWorker = run.jobs[0]?.threadId;
  f.f.harness.sdk.stub("threads.archive", async ({ threadId }) => {
    if (threadId === frameWorker) throw new Error("socket hang up");
    return archive({ threadId });
  });
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  await f.finish(run.id, "synthesis", synthesis);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.service.get(run.id).phase, "completed");
  assert.equal(f.service.get(run.id).ownerNotice, "sent");
  assert.deepEqual(archived(f, run.id), [false, true, true, true, true]);
  f.f.harness.sdk.stub("threads.archive", archive);
  await f.restart();
  assert.deepEqual(archived(f, run.id), [true, true, true, true, true]);
});

test("a worker that turns up after its run stopped is stopped and archived by its own event", async () => {
  const f = await fixture();
  f.state.noDispatch = true;
  const run = await f.start();
  assert.equal((await f.stop(run.id)).phase, "stopped");
  const input = f.spawned[0];
  assert.ok(input);
  const late = makeThreadResponse({
    id: "late-after-stop",
    projectId: "project",
    originPluginId: "scott-engineering",
    providerId: input.providerId,
    status: "active",
  });
  f.threads.set(late.id, late);
  f.metadata.set(late.id, input.pluginMetadata ?? {});
  await f.service.threadChanged(late.id);
  assert.equal(late.status, "idle");
  assert.notEqual(late.archivedAt, null);
});

test("archiving workers later keeps the time a run ended", async () => {
  const f = await fixture();
  const run = await f.start();
  await f.candidates(run.id);
  await f.finish(run.id, "judge", judge);
  await f.finish(run.id, "synthesis", synthesis);
  const endedAt = f.service.get(run.id).endedAt;
  assert.ok(endedAt);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(archived(f, run.id), [true, true, true, true, true]);
  assert.equal(f.service.get(run.id).endedAt, endedAt);

  // A run that ended before Arena archived workers has neither an end time nor archive marks.
  const legacy = await f.start("legacy");
  await f.finish(legacy.id, "frame", frame);
  await f.stop(legacy.id);
  for (let i = 0; i < 5; i++) await tick();
  const db = f.f.bb.storage.database();
  const row = db
    .prepare<[string], { payload: string }>("SELECT payload FROM arena_runs WHERE id = ?")
    .get(legacy.id);
  assert.ok(row);
  const stored = JSON.parse(row.payload);
  delete stored.endedAt;
  for (const job of stored.jobs) delete job.archived;
  db.prepare("UPDATE arena_runs SET payload = ? WHERE id = ?").run(
    JSON.stringify(stored),
    legacy.id,
  );
  for (const thread of f.threads.values()) thread.archivedAt = null;
  await f.restart();
  assert.deepEqual(archived(f, legacy.id), [true, true, true]);
  assert.equal(f.service.get(legacy.id).endedAt, stored.updatedAt);
});

test("canonical and legacy Arena tools share SDK schemas and authorization on an existing run", async () => {
  const f = await fixture();
  const started = await f.start();
  await f.candidates(started.id);
  const run = await f.finish(started.id, "judge", judge);
  const worker = run.jobs.find((job) => job.role === "synthesis");
  assert.ok(worker?.threadId);
  f.threads.set("stranger", makeThreadResponse({ id: "stranger", projectId: "project" }));
  const otherRun = await f.start("other-request");
  const otherWorker = otherRun.jobs.find((job) => job.role === "frame");
  assert.ok(otherWorker?.threadId);
  await plugin(f.f.bb);
  const { harness } = f.f;
  const records = harness.inspection.registrations.agentTools;
  for (const operation of ["context", "prepare", "report"]) {
    const canonical = records.find(({ name }) => name === `dev_mode_arena_${operation}`);
    const alias = records.find(({ name }) => name === `scott_engineering_arena_${operation}`);
    assert.ok(canonical && alias);
    assert.deepEqual(alias.inputSchema, canonical.inputSchema);
    assert.equal(alias.description, canonical.description);
    assert.equal(alias.instructions, null);
    const input = operation === "report" ? { runId: run.id, report: synthesis } : { runId: run.id };
    for (const name of [canonical.name, alias.name]) {
      await assert.rejects(
        harness.behavior.callAgentTool(name, input, { threadId: "stranger" }),
        /This thread does not own the Arena run/,
      );
      await assert.rejects(
        harness.behavior.callAgentTool(name, input, { threadId: otherWorker.threadId }),
        /This thread has no reserved Arena assignment/,
      );
      const result = JSON.parse(
        (await harness.behavior.callAgentTool(name, input, {
          threadId: worker.threadId,
        })) as string,
      );
      if (operation === "context") {
        assert.equal(result.task, run.task);
        assert.equal(result.base, run.base);
      } else if (operation === "prepare") {
        assert.equal(result.preparation.status, "prepared");
        assert.deepEqual(result.verification, frame.verification);
      } else {
        assert.deepEqual(result, { accepted: true });
      }
    }
  }
});
