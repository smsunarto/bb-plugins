import type { Context } from "@bb-kit/core/rpc";
import { instructionFiles } from "@bb-kit/core/instructions";
import { z } from "zod";
import {
  digestSchema,
  readableSchema,
  roleLabel,
  type ArenaRun,
  type Digest,
  type Job,
  type Readable,
} from "../../shared/arena.ts";

const files = instructionFiles(import.meta.url);
const busy = new Set(["pending", "starting", "active", "stopping"]);
const metadataSchema = z.object({ arenaDigest: z.object({ runId: z.uuid(), jobKey: z.uuid() }) });
/** What the server keeps beside the card's view: the shape the rewrite must match. */
const storedSchema = digestSchema.extend({
  runId: z.string(),
  kind: z.enum(["candidate", "synthesis"]),
  grafts: z.number().int(),
  rejected: z.number().int(),
});
type Stored = z.infer<typeof storedSchema>;
type DigestApi = Pick<Context["bb"], "storage" | "log" | "sdk" | "realtime">;
const key = (runId: string, jobKey: string) => `digest:${runId}:${jobKey}`;

/**
 * Rewrites candidate and synthesis results into plain language for the card.
 * Each rewrite runs in a hidden worker on a small fast model and never blocks
 * the run: the card shows the worker's own text until a valid rewrite lands.
 * Records live in plugin KV, apart from the run state machine.
 */
export class ArenaDigests {
  private readonly gates = new Map<string, Promise<unknown>>();
  private readonly bb: DigestApi;
  private readonly model: () => Promise<string>;

  constructor(bb: DigestApi, model: () => Promise<string>) {
    this.bb = bb;
    this.model = model;
  }

  /** Starts one rewrite per finished candidate or synthesis; repeat calls are no-ops. */
  async start(run: ArenaRun, job: Job) {
    const report = job.report;
    if (report?.kind !== "candidate" && report?.kind !== "synthesis") return;
    const id = key(run.id, job.key);
    await this.serial(id, async () => {
      if (await this.bb.storage.kv.get(id)) return;
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
      await this.write(id, stored);
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
        stored.threadId = thread.id;
      } catch (error) {
        stored.status = "failed";
        this.bb.log.warn(`Arena rewrite for ${job.key} did not start: ${String(error)}`);
      }
      await this.write(id, stored);
    });
  }

  async threadChanged(threadId: string) {
    const metadata = metadataSchema.safeParse(
      await this.bb.sdk.threads.getPluginMetadata({ threadId }),
    );
    if (!metadata.success) return;
    const { runId, jobKey } = metadata.data.arenaDigest;
    await this.finish(key(runId, jobKey), threadId);
  }

  async forRun(runId: string): Promise<Digest[]> {
    const records = await Promise.all(
      (await this.bb.storage.kv.list(`digest:${runId}:`)).map((id) => this.read(id)),
    );
    return records.filter((record) => record !== null).map((record) => digestSchema.parse(record));
  }

  /** Settles rewrites that finished, failed, or never launched while the plugin was down. */
  async recover() {
    for (const id of await this.bb.storage.kv.list("digest:")) {
      const stored = await this.read(id);
      if (stored?.status !== "running") continue;
      if (stored.threadId) await this.finish(id, stored.threadId);
      else await this.serial(id, () => this.write(id, { ...stored, status: "failed" }));
    }
  }

  private finish(id: string, threadId: string) {
    return this.serial(id, async () => {
      const stored = await this.read(id);
      if (stored?.status !== "running") return;
      const thread = await this.bb.sdk.threads.get({ threadId }).catch(() => null);
      if (thread && busy.has(thread.status)) return;
      const output =
        thread?.status === "idle" ? (await this.bb.sdk.threads.output({ threadId })).output : null;
      const result = output ? parseReply(output, stored) : null;
      await this.write(id, {
        ...stored,
        threadId,
        result,
        status: result ? "done" : "failed",
      });
    });
  }

  private async read(id: string) {
    const parsed = storedSchema.safeParse(await this.bb.storage.kv.get(id));
    return parsed.success ? parsed.data : null;
  }

  private async write(id: string, stored: Stored) {
    await this.bb.storage.kv.set(id, stored);
    this.bb.realtime.publish("arena.changed", { runId: stored.runId });
  }

  private serial(id: string, work: () => Promise<void>) {
    const next = (this.gates.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.gates.set(id, next);
    void next
      .finally(() => {
        if (this.gates.get(id) === next) this.gates.delete(id);
      })
      .catch(() => {});
    return next;
  }
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
