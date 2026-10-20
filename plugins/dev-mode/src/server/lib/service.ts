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
import { database } from "./database.ts";

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
/** About 50 minutes of owner wake retries before only a restart resends it. */
const wakeDelays = [5000, 10000, 20000, 60000, 300000, 900000, 1800000];
/** Thread statuses in which a worker can still act. */
export const busy = new Set(["pending", "starting", "active", "stopping"]);
const missing = (error: unknown) => error instanceof Error && /not found|404/i.test(error.message);
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
type Thread = Awaited<ReturnType<ArenaApi["sdk"]["threads"]["list"]>>[number];

/**
 * The workers a run launches beside its jobs to rewrite results for the card. ArenaService calls
 * every method under the run's gate, and the run's phase alone decides when they must stop.
 */
export interface Rewrites {
  /** Launches one rewrite for an accepted candidate or synthesis result, unless the run is cancelled. */
  start(run: ArenaRun, job: Job): Promise<void>;
  /**
   * Brings the run's rewrites in line with it: stops them once the run is cancelled, otherwise
   * settles finished replies. An event names its worker. A drain or restart also looks for lost
   * launches, and a restart abandons the ones it cannot find. Resolves false while a stopped
   * worker is still active.
   */
  sync(
    run: ArenaRun,
    change: "drain" | "restart" | { jobKey: string; threadId: string },
  ): Promise<boolean>;
  /** The rewrite a worker thread runs, read from its plugin metadata. */
  owner(metadata: unknown): { runId: string; jobKey: string } | null;
  /** Runs whose rewrites a restart must sync. */
  pending(): Promise<string[]>;
}

/** Drops a hidden worker's queued turns and stops it. True once it is idle or gone. */
export async function stopThread(sdk: ArenaApi["sdk"], threadId: string) {
  try {
    for (const entry of await sdk.threads.queuedMessages.list({ threadId }))
      await sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: entry.id });
    await sdk.threads.stop({ threadId });
    return !busy.has((await sdk.threads.get({ threadId })).status);
  } catch (error) {
    if (!missing(error)) throw error;
    return true;
  }
}

/**
 * Reads this plugin's thread history until `visit` reports that it found every lost launch.
 * Only a launch whose response was lost needs this; events name every other worker directly.
 */
export async function scanWorkers(
  bb: Pick<ArenaApi, "pluginId" | "sdk">,
  visit: (thread: Thread, metadata: unknown) => boolean,
) {
  for (let offset = 0; ; offset += 100) {
    const page = await bb.sdk.threads.list({
      originPluginId: bb.pluginId,
      includeHidden: true,
      limit: 100,
      offset,
    });
    for (const thread of page)
      if (visit(thread, await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }))) return;
    if (page.length < 100) return;
  }
}

export class ArenaService {
  private readonly db: ReturnType<BbPluginApi["storage"]["database"]>;
  private readonly gates = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private lifecycle: AbortSignal = new AbortController().signal;
  private readonly bb: ArenaApi;
  private readonly models: () => Promise<Models>;
  private readonly rewrites: Rewrites;

  constructor(bb: ArenaApi, models: () => Promise<Models>, rewrites: Rewrites) {
    this.bb = bb;
    this.models = models;
    this.rewrites = rewrites;
    this.db = database(bb);
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
        (run) =>
          !terminal.has(run.phase) ||
          run.ownerNotice === "pending" ||
          run.jobs.some(
            (job) =>
              (job.dispatch === "retired" && !job.stopConfirmed) || (job.threadId && !job.archived),
          ),
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
    const ended = !terminal.has(current.phase) && terminal.has(run.phase);
    const finished = ended && run.phase !== "stopped";
    if (finished) run.ownerNotice = "pending";
    if (run.phase === "failing" && current.phase !== "failing")
      run.failure = run.error ?? undefined;
    run.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    // Saves after the end, such as archiving workers, must not stretch the card's duration.
    if (ended) run.endedAt = run.updatedAt;
    this.db
      .prepare("UPDATE arena_runs SET phase = ?, payload = ? WHERE id = ?")
      .run(run.phase, JSON.stringify(run), run.id);
    this.bb.realtime.publish("arena.changed", { runId: run.id, threadId: run.parentThreadId });
    // Queued behind the gate holding this save, so the wake reads the run's final state.
    if (finished)
      void this.serial(run.id, () => this.notifyOwner(run.id)).catch((error) =>
        this.bb.log.warn(`Arena ${run.id}: owner wake failed: ${String(error)}`),
      );
    if (ended)
      void this.serial(run.id, () => this.archiveWorkers(run.id)).catch((error) =>
        this.bb.log.warn(`Arena ${run.id}: archiving workers failed: ${String(error)}`),
      );
  }

  /**
   * The launching chat yields after launch, so a completion or failure must wake it. Delivery is
   * at least once: failed sends retry with backoff, and a restart resends a pending wake,
   * including one sent just before a crash.
   */
  private async notifyOwner(id: string, attempt = 0) {
    const run = this.get(id);
    // One retry chain per run: a scheduled retry already owns this wake.
    if (this.disposed || run.ownerNotice !== "pending" || this.retries.has(`wake:${id}`)) return;
    try {
      const text = files.read("owner-notice", {
        runId: run.id,
        outcome: run.phase,
        summary:
          (run.phase === "completed" ? run.integration?.summary : (run.failure ?? run.error)) ??
          run.integration?.summary ??
          "No reason was recorded.",
      });
      const senderThreadId = await this.wakeSender(run);
      await this.bb.sdk.threads.send({
        threadId: run.parentThreadId,
        mode: "queue-if-active",
        ...(senderThreadId && { senderThreadId }),
        input: [{ type: "text", text, mentions: [] }],
      });
    } catch (error) {
      if (!missing(error)) {
        const delay = wakeDelays[attempt];
        this.bb.log.warn(
          `Arena ${id}: owner wake failed, retrying ${delay === undefined ? "on restart" : `in ${delay} ms`}: ${String(error)}`,
        );
        if (delay !== undefined && !this.disposed) {
          const timer = setTimeout(() => {
            this.retries.delete(`wake:${id}`);
            void this.serial(id, () => this.notifyOwner(id, attempt + 1)).catch((error) =>
              this.bb.log.warn(`Arena ${id}: owner wake failed: ${String(error)}`),
            );
          }, delay);
          timer.unref?.();
          this.retries.set(`wake:${id}`, timer);
        }
        return;
      }
    }
    run.ownerNotice = "sent";
    this.save(run);
  }

  /**
   * BB shows a send without a sender as the user typing it. The newest live worker makes the wake
   * an agent message instead. BB rejects a deleted sender, so deleted workers are skipped.
   */
  private async wakeSender(run: ArenaRun) {
    for (const job of run.jobs.toReversed()) {
      if (!job.threadId) continue;
      try {
        const thread = await this.bb.sdk.threads.get({ threadId: job.threadId });
        if (thread.deletedAt === null) return thread.id;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return undefined;
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
      if ([this.bb.pluginId, "review"].includes(parent.originPluginId ?? ""))
        throw new Error("Arena workers cannot launch nested runs");
      const ancestry = await this.bb.sdk.threads.experimental_listAncestors({
        threadIds: [caller],
      });
      const ancestors = await Promise.all(
        (ancestry.threads.find((item) => item.threadId === caller)?.ancestorIds ?? []).map(
          (threadId) => this.bb.sdk.threads.get({ threadId }),
        ),
      );
      if (
        ancestors.some((thread) =>
          [this.bb.pluginId, "review"].includes(thread.originPluginId ?? ""),
        )
      )
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
      // Queued on the run gate: Stop either finds this launch or prevents it, never misses it.
      const key = job.key;
      void this.serial(id, async () => {
        const fresh = this.get(id);
        const accepted = fresh.jobs.find((item) => item.key === key);
        if (accepted) await this.rewrites.start(fresh, accepted);
      }).catch((error) => this.bb.log.warn(`Arena ${id}: result rewrite failed: ${String(error)}`));
      return { accepted: true };
    });
  }

  private kick(id: string) {
    void this.serial(id, () => this.advance(id)).catch((error) => {
      if (!this.lifecycle.aborted)
        this.bb.log.error(`Arena ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** The one entry for lifecycle events of any worker this plugin launched. */
  async threadChanged(threadId: string) {
    const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId });
    const worker = metadataSchema.safeParse(metadata);
    const rewrite = worker.success ? null : this.rewrites.owner(metadata);
    const id = worker.success ? worker.data.arena.runId : rewrite?.runId;
    if (!id) return;
    await this.serial(id, async () => {
      const run = this.get(id);
      if (rewrite) {
        await this.rewrites.sync(run, { jobKey: rewrite.jobKey, threadId });
        if (run.phase === "stopping" || run.phase === "failing") await this.advance(id);
        return;
      }
      if (!worker.success) return;
      const job = run.jobs.find((job) => job.key === worker.data.arena.jobKey);
      if (!job || (job.threadId && job.threadId !== threadId)) return;
      if (!job.threadId) {
        const child = await this.bb.sdk.threads.get({ threadId });
        if (child.projectId !== run.projectId || child.providerId !== job.model.providerId) return;
        job.threadId = child.id;
        job.environmentId = child.environmentId;
        if (job.dispatch === "retired") job.stopConfirmed = false;
        else job.dispatch = "started";
        this.save(run);
      }
      if (job.dispatch === "retired") {
        if (!job.stopConfirmed) await this.stopWorker(job, "Launch reservation was retired");
        this.save(run);
        if (run.phase === "stopping" || run.phase === "failing") await this.advance(id);
        await this.archiveWorkers(id);
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
    if (run.round >= MAX_ROUNDS) run.phase = "failing";
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
    return run.phase === "failing";
  }

  private async processStage(run: ArenaRun, stage: Stage, signal: AbortSignal) {
    const jobs =
      stage.role === "candidate"
        ? [this.reserve(run, stage.role, 0), this.reserve(run, stage.role, 1)]
        : [this.reserve(run, stage.role)];
    await Promise.all(jobs.map((job) => this.dispatch(run, job)));
    if (jobs.some((job) => job.dispatch === "dispatching" && !job.threadId))
      await this.reconcile(run);
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
      run.phase = "failing";
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
      if (this.get(id).phase === "failing") await this.drain(this.get(id), "failed");
    }
  }

  async stop(id: string, caller: string) {
    const authorized = await this.authorize(id, caller);
    if (authorized.parentThreadId !== caller)
      throw new Error("Only the launching thread can stop Arena");
    const run = this.get(id);
    if (terminal.has(run.phase)) return run;
    if (run.phase === "failing") {
      // Retries the drain, so the run still ends failed and wakes its owner. The reset runs under
      // the gate so an in-flight drain cannot write back its spent retry budget.
      void this.serial(id, async () => {
        const fresh = this.get(id);
        if (fresh.phase !== "failing") return;
        fresh.recoveryAttempts = 0;
        this.save(fresh);
        await this.advance(id);
      }).catch((error) => this.bb.log.error(`Arena ${id}: ${String(error)}`));
      return run;
    }
    run.phase = "stopping";
    run.recoveryAttempts = 0;
    this.save(run);
    this.controllers.get(id)?.abort();
    this.kick(id);
    return this.get(id);
  }

  /**
   * Binds lost launches to the workers BB created for them, retires the ones with no worker, and
   * stops workers of retired launches. Only lost launches read thread history. A restart's read
   * covers the downtime, and every later worker raises its own event, so a retired launch that a
   * restart cannot find is settled and never searched again.
   */
  private async reconcile(run: ArenaRun, restart = false) {
    const lost = run.jobs.filter(
      (job) =>
        !job.threadId &&
        (job.dispatch === "dispatching" || (job.dispatch === "retired" && !job.stopConfirmed)),
    );
    const retired = run.jobs.filter(
      (job) => job.dispatch === "retired" && job.threadId && !job.stopConfirmed,
    );
    if (!lost.length && !retired.length) return;
    if (lost.length)
      await scanWorkers(this.bb, (child, metadata) => {
        const parsed = metadataSchema.safeParse(metadata);
        const job =
          parsed.success && parsed.data.arena.runId === run.id
            ? lost.find((job) => job.key === parsed.data.arena.jobKey && !job.threadId)
            : undefined;
        if (job && child.projectId === run.projectId && child.providerId === job.model.providerId) {
          job.threadId = child.id;
          job.environmentId = child.environmentId;
          if (job.dispatch !== "retired") job.dispatch = "started";
        }
        return lost.every((job) => job.threadId);
      });
    for (const job of run.jobs) {
      if (job.dispatch === "retired" && job.threadId && !job.stopConfirmed)
        await this.stopWorker(job, "Launch reservation was retired");
      if (job.dispatch === "dispatching" && !job.threadId) {
        job.dispatch = "retired";
        job.outcome = "failed";
        job.error = "It had not started before a restart, so Arena skipped it.";
      }
      if (restart && job.dispatch === "retired" && !job.threadId) job.stopConfirmed = true;
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
          await this.reconcile(run);
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
    if (!job.threadId || !(await stopThread(this.bb.sdk, job.threadId))) return;
    job.outcome = "failed";
    job.error = reason;
    if (job.dispatch === "retired") job.stopConfirmed = true;
  }

  /**
   * Archives an ended run's workers so BB removes their worktrees after its grace period. Their
   * branches and Arena's pins keep the results. A failed archive retries on the next restart.
   */
  private async archiveWorkers(id: string) {
    const run = this.get(id);
    if (this.disposed || !terminal.has(run.phase)) return;
    let archived = false;
    for (const job of run.jobs) {
      if (!job.threadId || job.archived) continue;
      try {
        await this.bb.sdk.threads.archive({ threadId: job.threadId });
      } catch (error) {
        if (!missing(error)) {
          this.bb.log.warn(
            `Arena ${id}: ${job.threadId} stays unarchived until restart: ${String(error)}`,
          );
          continue;
        }
      }
      job.archived = archived = true;
    }
    // A run that ended before `endedAt` existed last saved when it ended.
    run.endedAt ??= run.updatedAt;
    if (archived) this.save(run);
  }

  private async drain(run: ArenaRun, finalPhase: "failed" | "stopped") {
    try {
      await this.stopOwned(run, finalPhase);
    } catch (error) {
      run.error = `${run.error ?? "Still stopping workers"}: ${String(error)}${run.recoveryAttempts >= 3 ? `. Automatic retries are used up. Select ${finalPhase === "failed" ? "Retry cleanup" : "Retry stop"}.` : ""}`;
      this.save(run);
      this.retryLater(run.id);
    }
  }

  private async stopOwned(run: ArenaRun, finalPhase: "stopped" | "failed" = "stopped") {
    await this.reconcile(run);
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
    if (!(await this.rewrites.sync(run, "drain"))) {
      run.error = "Waiting to confirm that result rewrite workers stopped";
      this.save(run);
      return;
    }
    if (
      run.jobs.some(
        (job) =>
          job.outcome === "running" ||
          (job.dispatch === "retired" && job.threadId && !job.stopConfirmed),
      )
    ) {
      if (finalPhase === "stopped")
        run.error = "Waiting to reconcile dispatch or confirm that workers stopped";
      this.save(run);
      return;
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
    run.phase = finalPhase;
    if (finalPhase === "stopped") run.error = null;
    this.save(run);
  }

  /** The one startup entry: settles every run and rewrite that changed while the plugin was down. */
  async recover(signal: AbortSignal) {
    this.lifecycle = signal;
    const ids = new Set([
      ...this.all(true).map((run) => run.id),
      ...(await this.rewrites.pending()),
    ]);
    await Promise.all(
      [...ids].map((id) =>
        this.serial(id, async () => {
          if (signal.aborted) return;
          // Rewrites never fail a run; a stopping run's drain retries their stop.
          await this.rewrites
            .sync(this.get(id), "restart")
            .catch((error) =>
              this.bb.log.warn(`Arena ${id}: rewrites did not recover: ${String(error)}`),
            );
          const run = this.get(id);
          try {
            await this.reconcile(run, true);
            if (!terminal.has(run.phase)) await this.advance(run.id);
          } catch (error) {
            if (terminal.has(this.get(id).phase))
              this.bb.log.warn(`Arena ${id}: late workers did not recover: ${String(error)}`);
            else await this.handleFailure(this.get(id), error);
          }
          await this.notifyOwner(id);
          await this.archiveWorkers(id);
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
