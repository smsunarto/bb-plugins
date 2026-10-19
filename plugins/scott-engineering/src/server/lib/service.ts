import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "@bb-kit/core/rpc";
import { instructionFiles } from "@bb-kit/core/instructions";
import { z } from "zod";
import {
  MAX_ROUNDS,
  roleLabel,
  runSchema,
  terminal,
  type ArenaRun,
  type Job,
  type Model,
  type Report,
} from "../../shared/arena.ts";
import { hostContract } from "../../shared/host-contract.ts";

export const files = instructionFiles(import.meta.url);
const metadataSchema = z.object({ arena: z.object({ runId: z.uuid(), jobKey: z.uuid() }) });
const transientError = z.union([
  z.object({ body: z.object({ code: z.literal("host_unavailable") }) }),
  z.object({ code: z.enum(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]) }),
  z.object({
    cause: z.object({
      code: z.enum(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]),
    }),
  }),
]);
const recoveryDelays = [5000, 10000, 20000];
const busy = new Set(["pending", "starting", "active", "stopping"]);
type Stage = { role: Job["role"]; next: ArenaRun["phase"] };
const stages: Partial<Record<ArenaRun["phase"], Stage>> = {
  framing: { role: "frame", next: "candidates" },
  candidates: { role: "candidate", next: "judging" },
  judging: { role: "judge", next: "synthesizing" },
  synthesizing: { role: "synthesis", next: "integrating" },
};
/** Names a hidden worker in its thread header, e.g. "Arena candidate 2 (Codex)". */
function workerTitle(run: ArenaRun, job: Job) {
  const role = roleLabel(job.role, job.candidate).toLowerCase();
  const family = job.model.providerId === "codex" ? "Codex" : "Claude";
  return `Arena ${role} (${family})${run.round > 1 ? ` · round ${run.round}/${MAX_ROUNDS}` : ""}`;
}
export type Models = { claudeModel: string; codexModel: string };
type ArenaApi = Pick<Context["bb"], "pluginId" | "storage" | "log" | "sdk" | "hosts" | "realtime">;

export class ArenaService {
  private readonly db: ReturnType<BbPluginApi["storage"]["database"]>;
  private readonly gates = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private lifecycle: AbortSignal = new AbortController().signal;
  private readonly bb: ArenaApi;
  private readonly models: () => Promise<Models>;
  /** Called once a candidate or synthesis report is accepted; never blocks the run. */
  private readonly onResult: (run: ArenaRun, job: Job) => Promise<void>;

  constructor(
    bb: ArenaApi,
    models: () => Promise<Models>,
    onResult: (run: ArenaRun, job: Job) => Promise<void> = async () => {},
  ) {
    this.bb = bb;
    this.models = models;
    this.onResult = onResult;
    this.db = bb.storage.database();
    bb.storage.migrate(this.db, [
      "CREATE TABLE arena_runs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, request_id TEXT NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(parent, request_id))",
      "CREATE INDEX arena_runs_parent ON arena_runs(parent)",
    ]);
  }

  get(id: string): ArenaRun {
    const row = this.db
      .prepare<[string], { payload: string }>("SELECT payload FROM arena_runs WHERE id = ?")
      .get(id);
    if (!row) throw new Error("Arena run not found");
    return runSchema.parse(JSON.parse(row.payload));
  }

  private all(includeRetired = false) {
    return this.db
      .prepare<[], { payload: string }>(
        includeRetired
          ? "SELECT payload FROM arena_runs"
          : "SELECT payload FROM arena_runs WHERE phase NOT IN ('completed','failed','stopped')",
      )
      .all()
      .map((row) => runSchema.parse(JSON.parse(row.payload)))
      .filter(
        (run) => !terminal.has(run.phase) || run.jobs.some((job) => job.dispatch === "retired"),
      );
  }

  private save(run: ArenaRun) {
    const current = this.get(run.id);
    if (
      (current.phase === "stopping" || current.phase === "stopped") &&
      !["stopping", "stopped"].includes(run.phase) &&
      !(run.phase === "completed" && run.integration?.status === "integrated") &&
      !(run.phase === "failed" && run.integration?.status === "interrupted")
    )
      throw new Error("Arena was stopped");
    run.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    this.db
      .prepare("UPDATE arena_runs SET phase = ?, payload = ? WHERE id = ?")
      .run(run.phase, JSON.stringify(run), run.id);
    this.bb.realtime.publish("arena.changed", { runId: run.id, threadId: run.parentThreadId });
  }

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.gates.set(id, next);
    void next
      .finally(() => {
        if (this.gates.get(id) === next) this.gates.delete(id);
      })
      .catch(() => {});
    return next;
  }

  private host() {
    return this.bb.hosts.experimental_client({ contract: hostContract });
  }

  private model(providerId: Model["providerId"], models: Models): Model {
    return {
      providerId,
      model: providerId === "codex" ? models.codexModel : models.claudeModel,
      reasoningLevel: "xhigh",
      serviceTier: providerId === "codex" ? "fast" : "default",
    };
  }

  async start(caller: string, input: { task: string; requestId: string }) {
    return this.serial(`parent:${caller}`, async () => {
      const previous = this.db
        .prepare<[string, string], { payload: string }>(
          "SELECT payload FROM arena_runs WHERE parent = ? AND request_id = ?",
        )
        .get(caller, input.requestId);
      const prior = previous ? runSchema.parse(JSON.parse(previous.payload)) : undefined;
      if (prior) {
        if (prior.task !== input.task)
          throw new Error("This requestId belongs to a different task");
        this.kick(prior.id);
        return prior;
      }
      const parent = await this.bb.sdk.threads.get({ threadId: caller, include: "environment" });
      if (parent.originPluginId === this.bb.pluginId)
        throw new Error("Arena workers cannot launch nested runs");
      const ancestry = await this.bb.sdk.threads.experimental_listAncestors({
        threadIds: [caller],
      });
      const ancestors = await Promise.all(
        (ancestry.threads.find((item) => item.threadId === caller)?.ancestorIds ?? []).map(
          (threadId) => this.bb.sdk.threads.get({ threadId }),
        ),
      );
      if (ancestors.some((thread) => thread.originPluginId === this.bb.pluginId))
        throw new Error("Descendants of Arena workers cannot launch nested runs");
      const environment = "environment" in parent ? parent.environment : null;
      if (!environment || !environment.path || environment.status !== "ready")
        throw new Error("Arena needs a ready Git project checkout");
      const models = await this.models();
      const execution = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: caller });
      const lead = this.model(
        parent.providerId === "claude-code" ? "claude-code" : "codex",
        models,
      );
      if (
        execution?.model &&
        (parent.providerId === "codex" || parent.providerId === "claude-code")
      )
        lead.model = execution.model;
      const run: ArenaRun = {
        version: 1,
        id: randomUUID(),
        requestId: input.requestId,
        task: input.task,
        parentThreadId: caller,
        projectId: parent.projectId,
        environmentId: environment.id,
        hostId: environment.hostId,
        root: environment.path,
        base: null,
        snapshotId: randomUUID(),
        preparation: null,
        feedback: null,
        permissionMode: execution?.permissionMode ?? "accept-edits",
        models: [this.model("claude-code", models), this.model("codex", models)],
        lead,
        round: 1,
        recoveryAttempts: 0,
        phase: "snapshot",
        jobs: [],
        integration: null,
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.db
        .prepare("INSERT INTO arena_runs VALUES (?, ?, ?, ?, ?)")
        .run(run.id, caller, input.requestId, run.phase, JSON.stringify(run));
      this.kick(run.id);
      return run;
    });
  }

  async authorize(id: string, caller: string) {
    const run = this.get(id);
    if (run.parentThreadId !== caller && !run.jobs.some((job) => job.threadId === caller)) {
      const thread = await this.bb.sdk.threads.get({ threadId: caller });
      if (thread.originPluginId !== this.bb.pluginId || thread.projectId !== run.projectId)
        throw new Error("This thread does not own the Arena run");
      const metadata = metadataSchema.parse(
        await this.bb.sdk.threads.getPluginMetadata({ threadId: caller }),
      );
      const job = run.jobs.find(
        (job) => job.key === metadata.arena.jobKey && job.dispatch === "dispatching",
      );
      if (
        metadata.arena.runId !== id ||
        !job ||
        job.threadId ||
        job.model.providerId !== thread.providerId
      )
        throw new Error("This thread has no reserved Arena assignment");
      job.threadId = thread.id;
      job.environmentId = thread.environmentId;
      job.dispatch = "started";
    }
    return run;
  }

  async context(id: string, caller: string) {
    const run = await this.authorize(id, caller);
    const job = run.jobs.find((job) => job.threadId === caller);
    if (!job) return run;
    const jobs = run.jobs.filter((item) => item.round === job.round);
    const common = {
      task: run.task,
      root: run.root,
      base: run.base,
      round: job.round,
      feedback: run.feedback,
    };
    if (job.role === "candidate" || job.role === "frame") return common;
    return {
      ...common,
      frame: jobs.find((item) => item.role === "frame")?.report,
      candidates: jobs
        .filter((item) => item.role === "candidate" && item.outcome === "completed")
        .map((item) => ({
          candidate: item.candidate,
          path: item.path,
          commit: item.commit,
          report: item.report,
        })),
      ...(job.role === "synthesis"
        ? {
            judge: jobs.find((item) => item.role === "judge")?.report,
            preparation: run.preparation,
          }
        : {}),
    };
  }

  async owner(id: string, caller: string) {
    const run = await this.authorize(id, caller);
    if (run.parentThreadId !== caller)
      throw new Error("Only the launching thread can read Arena status or control it");
    return run;
  }

  async prepare(id: string, caller: string) {
    return this.serial(id, async () => {
      const run = await this.authorize(id, caller);
      const job = run.jobs.find((job) => job.threadId === caller && job.round === run.round);
      if (
        run.phase !== "synthesizing" ||
        job?.role !== "synthesis" ||
        job.outcome !== "running" ||
        !run.base
      )
        throw new Error("Only the active synthesis worker can prepare verification");
      const frame = run.jobs.find((job) => job.round === run.round && job.role === "frame")?.report;
      if (frame?.kind !== "frame") throw new Error("No verification contract");
      if (!run.preparation) {
        const thread = await this.bb.sdk.threads.get({ threadId: caller });
        if (!thread.environmentId) throw new Error("No synthesis checkout");
        const env = await this.bb.sdk.environments.get({ environmentId: thread.environmentId });
        if (!env.path || env.hostId !== run.hostId || env.status !== "ready")
          throw new Error("No ready synthesis checkout on the run host");
        const result = await this.host().call(
          "prepare",
          {
            runId: run.id,
            round: run.round,
            snapshotId: job.key,
            root: run.root,
            base: run.base,
            synthesisPath: env.path,
          },
          { hostId: run.hostId, timeoutMs: 120000 },
        );
        if (result.status !== "prepared") {
          run.integration = result;
          this.save(run);
          return { preparation: result };
        }
        run.preparation = result;
        job.path = env.path;
        job.commit = result.proposalCommit;
        this.save(run);
      }
      return { preparation: run.preparation, verification: frame.verification };
    });
  }

  async report(id: string, caller: string, report: Report) {
    return this.serial(id, async () => {
      const run = await this.authorize(id, caller);
      const job = run.jobs.find((item) => item.threadId === caller && item.round === run.round);
      if (
        !job ||
        job.outcome !== "running" ||
        job.role !== report.kind ||
        terminal.has(run.phase) ||
        run.phase === "stopping" ||
        run.phase === "failing"
      )
        throw new Error("No active Arena assignment accepts this report");
      if (job.report) {
        if (JSON.stringify(job.report) === JSON.stringify(report)) return { accepted: true };
        throw new Error("This assignment already submitted its final report");
      }
      if (report.kind === "judge" || report.kind === "synthesis") {
        const chosen = report.kind === "judge" ? report.preferredCandidate : report.baseCandidate;
        if (
          !run.jobs.some(
            (item) =>
              item.round === run.round && item.candidate === chosen && item.outcome === "completed",
          )
        )
          throw new Error("The selected candidate did not complete");
      }
      if (report.kind === "judge") {
        const frame = run.jobs.find(
          (item) => item.round === run.round && item.role === "frame",
        )?.report;
        if (
          frame?.kind !== "frame" ||
          report.scores.some((score) => score.criteria.length !== frame.rubric.length)
        )
          throw new Error("Judge scores must cover every rubric criterion");
        const candidates = run.jobs.filter(
          (item) =>
            item.round === run.round && item.role === "candidate" && item.outcome === "completed",
        );
        const scored = new Set(report.scores.map((score) => score.candidate));
        if (
          scored.size !== candidates.length ||
          scored.size !== report.scores.length ||
          candidates.some((item) => item.candidate === null || !scored.has(item.candidate))
        )
          throw new Error("Judge scores must cover each completed candidate exactly once");
      }
      if (report.kind === "synthesis") {
        const frame = run.jobs.find(
          (item) => item.round === run.round && item.role === "frame",
        )?.report;
        if (!run.preparation || frame?.kind !== "frame")
          throw new Error("Prepare the combined checkout before verifying and reporting");
        if (
          report.checks.length !== frame.verification.length ||
          report.checks.some((check, index) => check.command !== frame.verification[index])
        )
          throw new Error("Report each framing verification command in order");
      }
      job.report = report;
      this.save(run);
      if (report.kind === "candidate" || report.kind === "synthesis")
        void this.onResult(run, job).catch((error) =>
          this.bb.log.warn(`Arena ${id}: result rewrite failed: ${String(error)}`),
        );
      return { accepted: true };
    });
  }

  private kick(id: string) {
    void this.serial(id, () => this.advance(id)).catch((error) => {
      if (!this.lifecycle.aborted)
        this.bb.log.error(`Arena ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async threadChanged(threadId: string) {
    const known = this.all().find((run) => run.jobs.some((job) => job.threadId === threadId));
    if (known) {
      await this.serial(known.id, () => this.advance(known.id));
      return;
    }
    const metadata = metadataSchema.safeParse(
      await this.bb.sdk.threads.getPluginMetadata({ threadId }),
    );
    if (!metadata.success) return;
    const id = metadata.data.arena.runId;
    await this.serial(id, async () => {
      const run = this.get(id);
      await this.reconcile(run);
      const job = run.jobs.find((job) => job.threadId === threadId);
      if (job?.dispatch === "retired") {
        await this.stopWorker(job, "Launch reservation was retired");
        this.save(run);
        return;
      }
      if (!terminal.has(run.phase)) await this.advance(id);
    });
  }

  private reserve(run: ArenaRun, role: Job["role"], candidate: number | null = null): Job {
    const found = run.jobs.find(
      (job) => job.round === run.round && job.role === role && job.candidate === candidate,
    );
    if (found) return found;
    const model =
      role === "candidate"
        ? run.models[candidate === 1 ? 1 : 0]
        : role === "judge"
          ? run.models[run.lead.providerId === "codex" ? 0 : 1]
          : run.lead;
    const job: Job = {
      key: randomUUID(),
      round: run.round,
      role,
      candidate,
      model,
      dispatch: "reserved",
      threadId: null,
      environmentId: null,
      path: null,
      commit: null,
      report: null,
      outcome: "running",
      error: null,
      retried: false,
    };
    run.jobs.push(job);
    this.save(run);
    return job;
  }

  private async dispatch(run: ArenaRun, job: Job) {
    if (job.dispatch !== "reserved") return;
    if (!run.base) throw new Error("Snapshot preparation has not completed");
    job.dispatch = "dispatching";
    this.save(run);
    const isolated = job.role === "candidate" || job.role === "synthesis";
    try {
      const child = await this.bb.sdk.threads.spawn({
        projectId: run.projectId,
        lifecycleOwnerThreadId: run.parentThreadId,
        visibility: "hidden",
        permissionMode: run.permissionMode,
        environment: isolated
          ? {
              type: "host",
              hostId: run.hostId,
              workspace: {
                type: "managed-worktree",
                baseBranch: { kind: "named", name: run.base },
              },
            }
          : { type: "reuse", environmentId: run.environmentId },
        title: workerTitle(run, job),
        ...job.model,
        pluginMetadata: { arena: { runId: run.id, jobKey: job.key } },
        prompt:
          files.read("assignment", { runId: run.id, role: job.role }) +
          "\n\n" +
          files.read(job.role),
      });
      job.threadId = child.id;
      job.environmentId = child.environmentId;
      job.dispatch = "started";
      this.save(run);
    } catch (error) {
      // Any failed response can follow a committed thread creation.
      run.error = `Checking whether ${roleLabel(job.role, job.candidate)} started: ${String(error)}`;
      this.save(run);
    }
  }

  private async settle(run: ArenaRun, job: Job, signal: AbortSignal) {
    if (!job.threadId || job.outcome !== "running") return;
    let child;
    try {
      child = await this.bb.sdk.threads.get({ threadId: job.threadId });
    } catch (error) {
      if (!(error instanceof Error && /not found|404/i.test(error.message))) throw error;
      job.outcome = "failed";
      job.error = "Its thread was deleted.";
      this.save(run);
      return;
    }
    if (busy.has(child.status)) return;
    if (child.status === "error" && !job.retried) {
      job.retried = true;
      this.save(run);
      await this.bb.sdk.threads.retry({ threadId: child.id });
      return;
    }
    if (child.status !== "idle" || !job.report) {
      job.outcome = "failed";
      job.error = "Finished without a usable result.";
      this.save(run);
      return;
    }
    if (child.environmentId) {
      const env = await this.bb.sdk.environments.get({ environmentId: child.environmentId });
      job.environmentId = env.id;
      job.path = env.path;
      if (
        (job.role === "candidate" || job.role === "synthesis") &&
        (!env.path || env.status !== "ready" || env.hostId !== run.hostId)
      ) {
        job.outcome = "failed";
        job.error = "Its checkout is not ready on this machine.";
        this.save(run);
        return;
      }
      if ((job.role === "candidate" || job.role === "synthesis") && env.path) {
        const pinned = await this.host().call(
          "snapshot",
          { runId: job.key, path: env.path },
          { hostId: run.hostId, signal },
        );
        job.commit = pinned.base;
      }
    }
    job.outcome = "completed";
    run.recoveryAttempts = 0;
    this.save(run);
  }

  private rerun(run: ArenaRun, reason: string) {
    run.error = reason;
    run.feedback = { summary: reason, integration: run.integration };
    if (run.round >= MAX_ROUNDS) run.phase = "failed";
    else {
      run.round += 1;
      run.snapshotId = randomUUID();
      run.base = null;
      run.preparation = null;
      run.integration = null;
      run.recoveryAttempts = 0;
      run.phase = "snapshot";
    }
    this.save(run);
    return run.phase === "failed";
  }

  private async processStage(run: ArenaRun, stage: Stage, signal: AbortSignal) {
    const jobs =
      stage.role === "candidate"
        ? [this.reserve(run, stage.role, 0), this.reserve(run, stage.role, 1)]
        : [this.reserve(run, stage.role)];
    await Promise.all(jobs.map((job) => this.dispatch(run, job)));
    if (jobs.some((job) => job.dispatch === "dispatching" && !job.threadId))
      await this.reconcile(run, true);
    for (const job of jobs) await this.settle(run, job, signal);
    if (jobs.some((job) => job.outcome === "running")) return false;
    const completed = jobs.filter((job) => job.outcome === "completed");
    if (!completed.length) {
      const nothing =
        stage.role === "candidate"
          ? "Neither candidate produced a usable result."
          : `${roleLabel(stage.role, null)} produced no usable result.`;
      return !this.rerun(run, `${nothing} ${jobs.map((job) => job.error ?? "").join(" ")}`);
    }
    const report = completed[0]?.report;
    if (report?.kind === "judge" && report.reframe) return !this.rerun(run, report.summary);
    run.phase = stage.next;
    run.recoveryAttempts = 0;
    run.error = null;
    this.save(run);
    return true;
  }

  private async integrate(run: ArenaRun, signal: AbortSignal) {
    const jobs = run.jobs.filter((job) => job.round === run.round);
    const synthesis = jobs.find((job) => job.role === "synthesis");
    const report = synthesis?.report;
    if (!run.preparation || report?.kind !== "synthesis")
      throw new Error("No prepared and verified synthesis");
    const input = { runId: run.id, round: run.round, checks: report.checks };
    run.integration = await this.serial(`integration:${run.hostId}:${run.root}`, () => {
      signal.throwIfAborted();
      return this.host().call("integrate", input, {
        hostId: run.hostId,
        signal,
        timeoutMs: 900000,
      });
    });
    signal.throwIfAborted();
    if (run.integration.status === "interrupted") {
      run.phase = "failed";
      run.error = run.integration.summary;
      this.save(run);
      return false;
    }
    if (run.integration.status !== "integrated") return !this.rerun(run, run.integration.summary);
    run.phase = "completed";
    run.error = null;
    this.save(run);
    return false;
  }

  private async advance(id: string) {
    const run = this.get(id);
    if (terminal.has(run.phase)) return;
    if (run.phase === "stopping" || run.phase === "failing") {
      await this.drain(run, run.phase === "failing" ? "failed" : "stopped");
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const dispose = () => controller.abort();
    this.lifecycle.addEventListener("abort", dispose, { once: true });
    if (this.lifecycle.aborted) controller.abort();
    const signal = controller.signal;
    try {
      while (!terminal.has(run.phase)) {
        signal.throwIfAborted();
        if (run.phase === "snapshot") {
          const pinned = await this.host().call(
            "snapshot",
            { runId: run.snapshotId ?? run.id, path: run.root },
            { hostId: run.hostId, signal },
          );
          run.root = pinned.root;
          run.base = pinned.base;
          run.phase = "framing";
          run.recoveryAttempts = 0;
          this.save(run);
          continue;
        }
        const stage = stages[run.phase];
        if (stage) {
          if (!(await this.processStage(run, stage, signal))) return;
          continue;
        }
        if (run.phase === "integrating") {
          if (!(await this.integrate(run, signal))) return;
          continue;
        }
        return;
      }
    } catch (error) {
      if (signal.aborted || this.get(id).phase === "stopping") return;
      await this.handleFailure(run, error);
    } finally {
      this.lifecycle.removeEventListener("abort", dispose);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }

  async stop(id: string, caller: string) {
    const authorized = await this.authorize(id, caller);
    if (authorized.parentThreadId !== caller)
      throw new Error("Only the launching thread can stop Arena");
    const run = this.get(id);
    if (terminal.has(run.phase)) return run;
    run.phase = "stopping";
    run.recoveryAttempts = 0;
    this.save(run);
    this.controllers.get(id)?.abort();
    this.kick(id);
    return this.get(id);
  }

  private async reconcile(run: ArenaRun, retireMissing = false) {
    for (let offset = 0; ; offset += 100) {
      const children = await this.bb.sdk.threads.list({
        originPluginId: this.bb.pluginId,
        includeHidden: true,
        limit: 100,
        offset,
      });
      for (const child of children) {
        const metadata = metadataSchema.safeParse(
          await this.bb.sdk.threads.getPluginMetadata({ threadId: child.id }),
        );
        if (!metadata.success || metadata.data.arena.runId !== run.id) continue;
        const job = run.jobs.find((job) => job.key === metadata.data.arena.jobKey);
        if (
          job &&
          !job.threadId &&
          child.projectId === run.projectId &&
          child.providerId === job.model.providerId
        ) {
          job.threadId = child.id;
          job.environmentId = child.environmentId;
          if (job.dispatch !== "retired") job.dispatch = "started";
        }
        if (job?.dispatch === "retired" && job.threadId)
          await this.stopWorker(job, "Launch reservation was retired");
      }
      if (children.length < 100) break;
    }
    if (retireMissing) {
      for (const job of run.jobs) {
        if (job.dispatch === "dispatching" && !job.threadId) {
          job.dispatch = "retired";
          job.outcome = "failed";
          job.error = "It had not started before a restart, so Arena skipped it.";
        }
      }
    }
    this.save(run);
  }

  private async handleFailure(run: ArenaRun, error: unknown) {
    run.error = error instanceof Error ? error.message : String(error);
    if (transientError.safeParse(error).success && run.recoveryAttempts < recoveryDelays.length) {
      this.save(run);
      this.retryLater(run.id);
    } else {
      run.phase = "failing";
      this.save(run);
      await this.drain(run, "failed");
    }
  }

  private retryLater(id: string) {
    if (this.disposed || this.retries.has(id) || this.lifecycle.aborted) return;
    const delay = recoveryDelays[this.get(id).recoveryAttempts];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      this.retries.delete(id);
      void this.serial(id, async () => {
        const run = this.get(id);
        if (terminal.has(run.phase)) return;
        run.recoveryAttempts += 1;
        this.save(run);
        try {
          await this.reconcile(run, true);
          await this.advance(id);
        } catch (error) {
          await this.handleFailure(this.get(id), error);
        }
      }).catch((error) => this.bb.log.error(`Arena recovery ${id}: ${String(error)}`));
    }, delay);
    timer.unref?.();
    this.retries.set(id, timer);
  }

  private async stopWorker(job: Job, reason: string) {
    if (!job.threadId) return;
    try {
      const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId: job.threadId });
      for (const entry of queued)
        await this.bb.sdk.threads.queuedMessages.delete({
          threadId: job.threadId,
          queuedMessageId: entry.id,
        });
      await this.bb.sdk.threads.stop({ threadId: job.threadId });
      const child = await this.bb.sdk.threads.get({ threadId: job.threadId });
      if (busy.has(child.status)) return;
    } catch (error) {
      if (!(error instanceof Error && /not found|404/i.test(error.message))) throw error;
    }
    job.outcome = "failed";
    job.error = reason;
  }

  private async drain(run: ArenaRun, finalPhase: "failed" | "stopped") {
    try {
      await this.stopOwned(run, finalPhase);
    } catch (error) {
      run.error = `${run.error ?? "Still stopping workers"}: ${String(error)}${run.recoveryAttempts >= 3 ? ". Automatic retries are used up. Select Retry stop." : ""}`;
      this.save(run);
      this.retryLater(run.id);
    }
  }

  private async stopOwned(run: ArenaRun, finalPhase: "stopped" | "failed" = "stopped") {
    await this.reconcile(run, true);
    for (const job of run.jobs) {
      if (job.outcome !== "running") continue;
      if (job.dispatch === "reserved") {
        job.outcome = "failed";
        job.error = "Stopped before it started.";
      } else
        await this.stopWorker(
          job,
          finalPhase === "failed" ? "Cancelled after Arena failure" : "Stopped by user",
        );
    }
    if (run.preparation) {
      const receipt = await this.host().call(
        "receipt",
        { runId: run.id, round: run.round },
        { hostId: run.hostId, timeoutMs: 120000 },
      );
      if (receipt) {
        run.integration = receipt;
        run.phase = receipt.status === "integrated" ? "completed" : "failed";
        run.error = receipt.status === "integrated" ? null : receipt.summary;
        this.save(run);
        return;
      }
    }
    if (run.jobs.some((job) => job.outcome === "running")) {
      if (finalPhase === "stopped")
        run.error = "Waiting to reconcile dispatch or confirm that workers stopped";
    } else {
      run.phase = finalPhase;
      if (finalPhase === "stopped") run.error = null;
    }
    this.save(run);
  }

  async recover(signal: AbortSignal) {
    this.lifecycle = signal;
    await Promise.all(
      this.all(true).map((saved) =>
        this.serial(saved.id, async () => {
          if (signal.aborted) return;
          const run = this.get(saved.id);
          try {
            await this.reconcile(run, true);
            if (!terminal.has(run.phase)) await this.advance(run.id);
          } catch (error) {
            await this.handleFailure(this.get(run.id), error);
          }
        }),
      ),
    );
  }

  async dispose() {
    this.disposed = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.gates.values());
  }
}
