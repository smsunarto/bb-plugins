import type { Context } from "@bb-kit/core/rpc";
import { instructionFiles } from "@bb-kit/core/instructions";
import { z } from "zod";
import {
  cancelled,
  digestSchema,
  readableSchema,
  roleLabel,
  type ArenaRun,
  type Digest,
  type Job,
  type Readable,
} from "../../shared/arena.ts";
import { busy, scanWorkers, stopThread, type Rewrites } from "./service.ts";

const files = instructionFiles(import.meta.url);
const metadataSchema = z.object({ arenaDigest: z.object({ runId: z.uuid(), jobKey: z.uuid() }) });
/** What the server keeps beside the card's view: the shape the rewrite must match. */
const storedSchema = digestSchema.extend({
  runId: z.string(),
  kind: z.enum(["candidate", "synthesis"]),
  grafts: z.number().int(),
  rejected: z.number().int(),
  /** A restart found no worker for this lost launch; only the worker's own event can bind it now. */
  abandoned: z.boolean().optional(),
  /** A worker's stop receipt, independent of whether its readable result already landed. */
  stopConfirmed: z.boolean().optional(),
});
type Stored = z.infer<typeof storedSchema>;
type DigestApi = Pick<Context["bb"], "pluginId" | "storage" | "log" | "sdk" | "realtime">;
const key = (runId: string, jobKey: string) => `digest:${runId}:${jobKey}`;
/** A launch whose spawn response was lost and whose worker is still worth looking for. */
const lost = (stored: Stored) => !stored.threadId && stored.status !== "done" && !stored.abandoned;

/**
 * Rewrites candidate and synthesis results into plain language for the card.
 * Each rewrite runs in a hidden worker on a small fast model and never blocks
 * the run: the card shows the worker's own text until a valid rewrite lands.
 * Records live in plugin KV, apart from the run state machine. ArenaService
 * drives every transition under the run's gate and its phase decides cancellation.
 */
export class ArenaDigests implements Rewrites {
  private readonly bb: DigestApi;
  private readonly model: () => Promise<string>;

  constructor(bb: DigestApi, model: () => Promise<string>) {
    this.bb = bb;
    this.model = model;
  }

  async start(run: ArenaRun, job: Job) {
    const report = job.report;
    if (cancelled.has(run.phase)) return;
    if (report?.kind !== "candidate" && report?.kind !== "synthesis") return;
    if (await this.bb.storage.kv.get(key(run.id, job.key))) return;
    const stored: Stored = {
      runId: run.id,
      jobKey: job.key,
      threadId: null,
      status: "running",
      result: null,
      startedAt: Date.now(),
      kind: report.kind,
      grafts: report.kind === "synthesis" ? report.grafts.length : 0,
      rejected: report.kind === "synthesis" ? report.rejected.length : 0,
    };
    // Saved before the spawn: if its response is lost, sync looks for the worker by metadata.
    await this.write(stored);
    try {
      const thread = await this.bb.sdk.threads.spawn({
        projectId: run.projectId,
        lifecycleOwnerThreadId: run.parentThreadId,
        visibility: "hidden",
        permissionMode: "accept-edits",
        environment: { type: "reuse", environmentId: run.environmentId },
        title: `Arena rewrite: ${roleLabel(job.role, job.candidate).toLowerCase()}`,
        providerId: "codex",
        model: await this.model(),
        reasoningLevel: "low",
        serviceTier: "fast",
        pluginMetadata: { arenaDigest: { runId: run.id, jobKey: job.key } },
        prompt: digestPrompt(run, job),
      });
      await this.write({ ...stored, threadId: thread.id });
    } catch (error) {
      this.bb.log.warn(`Arena rewrite for ${job.key} did not start: ${String(error)}`);
    }
  }

  owner(metadata: unknown) {
    const parsed = metadataSchema.safeParse(metadata);
    return parsed.success ? parsed.data.arenaDigest : null;
  }

  async sync(run: ArenaRun, change: "drain" | "restart" | { jobKey: string; threadId: string }) {
    const stop = cancelled.has(run.phase);
    if (typeof change === "object") {
      const stored = await this.read(key(run.id, change.jobKey));
      if (!stored || (stored.threadId && stored.threadId !== change.threadId)) return true;
      if (!stored.threadId) await this.write(bind(stored, change.threadId));
      return this.settle(stored, stop);
    }
    const records = await this.records(run.id);
    const missing = records.filter(lost);
    if (missing.length)
      await scanWorkers(this.bb, (thread, metadata) => {
        const owner = this.owner(metadata);
        const stored =
          owner?.runId === run.id &&
          missing.find((item) => item.jobKey === owner.jobKey && !item.threadId);
        if (stored) bind(stored, thread.id);
        return missing.every((item) => item.threadId);
      });
    let quiet = true;
    for (const stored of records) {
      if (stored.threadId) {
        if (missing.includes(stored)) await this.write(stored);
        if (!(stop && stored.stopConfirmed) && !(await this.settle(stored, stop))) quiet = false;
      } else if (missing.includes(stored))
        // Nothing to wait for. A drain leaves it for the next restart to look for once more.
        await this.write({ ...stored, status: "failed", abandoned: change === "restart" });
    }
    return quiet;
  }

  async pending() {
    const runs = new Set<string>();
    for (const id of await this.bb.storage.kv.list("digest:")) {
      const stored = await this.read(id);
      if (stored && (stored.status === "running" || stored.stopConfirmed === false || lost(stored)))
        runs.add(stored.runId);
    }
    return [...runs];
  }

  async forRun(runId: string): Promise<Digest[]> {
    return (await this.records(runId)).map((record) => digestSchema.parse(record));
  }

  /** A cancelled run stops the worker; any other run takes its reply once it is idle. */
  private async settle(stored: Stored, stop: boolean) {
    const threadId = stored.threadId;
    if (!threadId) return true;
    if (stop) {
      // Persist the obligation before I/O, including when a settled worker has resumed.
      await this.write({ ...stored, stopConfirmed: false });
      const stopped = await stopThread(this.bb.sdk, threadId);
      await this.write({
        ...stored,
        stopConfirmed: stopped,
        status: stored.status === "done" ? "done" : stopped ? "failed" : "running",
      });
      return stopped;
    }
    if (stored.status !== "running") return true;
    const thread = await this.bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
      if (!(error instanceof Error && /not found|404/i.test(error.message))) throw error;
      return null;
    });
    if (thread && busy.has(thread.status)) return true;
    const output =
      thread?.status === "idle" ? (await this.bb.sdk.threads.output({ threadId })).output : null;
    const result = output ? parseReply(output, stored) : null;
    await this.write({ ...stored, result, status: result ? "done" : "failed" });
    return true;
  }

  private async records(runId: string) {
    const records = await Promise.all(
      (await this.bb.storage.kv.list(`digest:${runId}:`)).map((id) => this.read(id)),
    );
    return records.filter((record) => record !== null);
  }

  private async read(id: string) {
    const parsed = storedSchema.safeParse(await this.bb.storage.kv.get(id));
    return parsed.success ? parsed.data : null;
  }

  private async write(stored: Stored) {
    await this.bb.storage.kv.set(key(stored.runId, stored.jobKey), stored);
    this.bb.realtime.publish("arena.changed", { runId: stored.runId });
  }
}

/** A worker turned up for a launch: it is live again, whatever was given up on before. */
function bind(stored: Stored, threadId: string) {
  stored.threadId = threadId;
  stored.status = "running";
  stored.abandoned = false;
  return stored;
}

/** The rewrite worker's whole prompt: the instructions plus the result as JSON. */
export function digestPrompt(run: ArenaRun, job: Job) {
  const report = job.report;
  const name = (index: number) => `Candidate ${index + 1}`;
  const input =
    report?.kind === "synthesis"
      ? {
          reply: {
            summary: "string",
            rationale: "string",
            grafts: report.grafts.map(() => "string"),
            rejected: report.rejected.map(() => "string"),
          },
          result: {
            summary: report.summary,
            startingPoint: name(report.baseCandidate),
            rationale: report.rationale,
            grafts: report.grafts.map((graft) => `From ${name(graft.candidate)}: ${graft.change}`),
            rejected: report.rejected,
          },
        }
      : {
          reply: { summary: "string", tradeoff: "string" },
          result:
            report?.kind === "candidate"
              ? { summary: report.summary, tradeoff: report.tradeoff }
              : {},
        };
  const payload = {
    task: run.task.slice(0, 1500),
    about: job.role === "synthesis" ? "The combined result" : roleLabel(job.role, job.candidate),
    ...input,
  };
  return `${files.read("digest")}\n\n${JSON.stringify(payload, null, 2)}`;
}

/** Accepts only a reply with every requested field, so a bad rewrite falls back to the original. */
export function parseReply(output: string, stored: Pick<Stored, "kind" | "grafts" | "rejected">) {
  let value: unknown;
  try {
    value = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const reply = z.record(z.string(), z.unknown()).safeParse(value);
  if (!reply.success) return null;
  const { summary, tradeoff, rationale, grafts, rejected } = reply.data;
  const parsed = readableSchema.safeParse(
    stored.kind === "candidate"
      ? { kind: stored.kind, summary, tradeoff }
      : { kind: stored.kind, summary, rationale, grafts, rejected },
  );
  if (!parsed.success) return null;
  const result: Readable = parsed.data;
  if (
    result.kind === "synthesis" &&
    (result.grafts.length !== stored.grafts || result.rejected.length !== stored.rejected)
  )
    return null;
  return result;
}
