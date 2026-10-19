import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ArenaService } from "./service.ts";
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

async function fixture() {
  type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
  type Spawn = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
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
  const receipts = new Map<string, Integration>();
  const snapshots: unknown[] = [];
  const ancestors: string[] = [];
  const state: {
    uncertain: boolean;
    noDispatch: boolean;
    snapshotError: boolean;
    offline: boolean;
    spawnError: string;
    integrationWait?: Promise<Integration>;
    fatalPin: boolean;
    integration: Integration;
  } = {
    uncertain: false,
    noDispatch: false,
    snapshotError: false,
    offline: false,
    spawnError: "timeout after dispatch",
    fatalPin: false,
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
        spawn: async (input) => {
          spawned.push(input);
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
        queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
      },
    },
  });
  let service = new ArenaService(f.bb, async () => ({
    claudeModel: "claude",
    codexModel: "codex",
  }));
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
    spawned,
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
    get service() {
      return service;
    },
    async restart() {
      await service.dispose();
      service = new ArenaService(f.bb, async () => ({
        claudeModel: "claude",
        codexModel: "codex",
      }));
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
  assert.equal(f.service.get(run.id).round, 2);
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
