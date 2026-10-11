import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { reviewHostContract } from "../../shared/host-contract.ts";
import type {
  ContextRequest,
  Evidence,
  ResultRequest,
  ReviewRequest,
  ReviewRun,
} from "../../shared/schema.ts";
import { bindAssessment } from "./assessment.ts";
import { pickReviewer, reviewerPrompt, type ReviewerModels } from "./review.ts";

const reportSchema = z
  .object({
    runId: z.string(),
    status: z.enum(["complete", "incomplete"]),
    findings: z
      .array(
        z
          .object({
            priority: z.number().int().min(0).max(3),
            title: z.string().max(200),
            body: z.string().max(8000),
            location: z.string().max(1000),
          })
          .strict(),
      )
      .max(100),
    coverage: z.string().max(16000),
    limitations: z.array(z.string().max(4000)).max(40),
  })
  .strict();
type ThreadResponse = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
const active = new Set(["pending", "starting", "active", "stopping"]);
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const CONTRACT_VERSION = 3;
const reviewerKey = (id: string) => `reviewer:${id}`;
const parentKey = (id: string) => `latest:${id}`;
const scope = (run: ReviewRun) =>
  run.request.workstream ??
  (run.target
    ? `${run.target.repositoryPath}:${run.target.branch ?? run.target.base}`
    : run.request.summary);
const publicationIdentity = (run: ReviewRun) =>
  hash([
    run.projectId,
    run.environmentId,
    run.hostId,
    run.target?.repositoryPath,
    run.target?.base,
    run.target?.head,
    run.request.mode,
    run.request.kind,
    run.request.scope,
  ]);
const metadata = (run: ReviewRun) => ({
  reviewRun: {
    contractVersion: run.contractVersion,
    id: run.id,
    mode: run.request.mode,
    kind: run.request.kind,
    startedAt: run.startedAt,
    summary: run.request.summary,
    target: run.target,
    status: run.status,
  },
});

export class ReviewService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly bb: BbPluginApi;
  private readonly db: ReturnType<BbPluginApi["storage"]["database"]>;
  private readonly models: () => Promise<ReviewerModels>;
  constructor(bb: BbPluginApi, models: () => Promise<ReviewerModels>) {
    this.bb = bb;
    this.models = models;
    this.db = bb.storage.database();
    bb.storage.migrate(this.db, [
      `CREATE TABLE review_runs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)`,
      `CREATE UNIQUE INDEX review_active_parent ON review_runs(parent) WHERE status IN ('starting','running')`,
      `CREATE TABLE review_reads (run_id TEXT NOT NULL, section TEXT NOT NULL, path TEXT NOT NULL, side TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(run_id,section,path,side,start))`,
      `CREATE TABLE review_turn_reads (run_id TEXT NOT NULL, turn_id TEXT NOT NULL, section TEXT NOT NULL, path TEXT NOT NULL, side TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(run_id,turn_id,section,path,side,start))`,
      `ALTER TABLE review_turn_reads ADD COLUMN digest TEXT NOT NULL DEFAULT ''`,
    ]);
  }

  private async serial<T>(parent: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(parent) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => gate);
    this.locks.set(parent, next);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(parent) === next) this.locks.delete(parent);
    }
  }
  private async save(run: ReviewRun) {
    this.db
      .prepare("UPDATE review_runs SET status = ?, payload = ? WHERE id = ?")
      .run(run.status, JSON.stringify(run), run.id);
    if (
      run.reviewerThreadId &&
      (await this.bb.storage.kv.get<string>(reviewerKey(run.reviewerThreadId))) === run.id
    )
      await this.bb.sdk.threads
        .updatePluginMetadata({ threadId: run.reviewerThreadId, set: metadata(run) })
        .catch((error) => {
          if (!(error instanceof Error && /thread.*not found|404/i.test(error.message)))
            throw error;
        });
  }
  private stored(id: string): ReviewRun | undefined {
    const row = this.db
      .prepare<[string], { payload: string }>("SELECT payload FROM review_runs WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(row.payload) as ReviewRun) : undefined;
  }
  private diffCoverage(id: string, turnId: string = "") {
    const reads = this.db
      .prepare<[string, string], { start: number; end: number; total: number; digest: string }>(
        "SELECT start,end,total,digest FROM review_turn_reads WHERE run_id = ? AND turn_id = ? AND section = 'diff' ORDER BY start",
      )
      .all(id, turnId);
    let end = 0;
    const total = reads[0]?.total ?? null;
    const unread: { start: number; end: number }[] = [];
    for (const read of reads) {
      const start = Math.min(read.start, read.total);
      if (start > end) unread.push({ start: end, end: start });
      end = Math.max(end, read.end);
    }
    if (total !== null && end < total) unread.push({ start: end, end: total });
    const consistent =
      reads.length > 0 &&
      reads.every(
        (read) =>
          read.total === total && read.digest === reads[0]!.digest && read.digest.length === 64,
      );
    return {
      complete: total !== null && unread.length === 0 && consistent,
      consistent,
      totalLength: total,
      unread,
    };
  }
  private async lineage(caller: string) {
    const ids: string[] = [];
    let current: string | null = caller;
    let origin: ThreadResponse | undefined;
    while (current && !ids.includes(current)) {
      const thread = await this.reviewerThread(current);
      if (!thread) break;
      origin ??= thread;
      ids.push(current);
      current = thread.parentThreadId;
    }
    return { ids, origin };
  }
  private async authorize(id: string, caller: string) {
    const run = this.stored(id);
    if (run && (caller === run.parentThreadId || caller === run.reviewerThreadId)) return run;
    const { ids, origin } = await this.lineage(caller);
    if (
      run &&
      ids.includes(run.parentThreadId) &&
      origin?.projectId === run.projectId &&
      origin.environmentId === run.environmentId
    )
      return run;
    throw new Error("Review run is not available to this thread");
  }
  private async inheritedPublication(run: ReviewRun, signal: AbortSignal) {
    if (
      run.request.reuse !== "auto" ||
      run.request.kind !== "implementation" ||
      run.request.mode !== "deep" ||
      run.request.scope !== "publication" ||
      !run.target
    )
      return null;
    const { ids } = await this.lineage(run.parentThreadId);
    for (const parent of ids.slice(1)) {
      const rows = this.db
        .prepare<[string], { payload: string }>(
          "SELECT payload FROM review_runs WHERE parent = ? AND status = 'completed' ORDER BY rowid DESC",
        )
        .all(parent);
      for (const row of rows) {
        const prior = JSON.parse(row.payload) as ReviewRun;
        if (publicationIdentity(prior) !== publicationIdentity(run)) continue;
        const result = await this.result(
          run.parentThreadId,
          { runId: prior.id, waitSeconds: 0 },
          signal,
        );
        if (
          "report" in result &&
          result.report?.status === "complete" &&
          result.current &&
          result.diffCoverage.complete
        )
          return { ...this.receipt(prior, true), cached: true };
      }
    }
    return null;
  }
  private readHost() {
    return this.bb.hosts.experimental_client({ contract: reviewHostContract });
  }
  private async authorModel(thread: ThreadResponse) {
    if (thread.providerId === "codex" || thread.providerId === "claude-code") return null;
    const [started] = await this.bb.sdk.threads.events.list({
      threadId: thread.id,
      types: ["turn/started"],
      order: "desc",
      limit: "1",
    });
    if (!started || started.scope.kind !== "turn")
      throw new Error("This thread has no recorded author turn");
    const [accepted] = await this.bb.sdk.threads.events.list({
      threadId: thread.id,
      types: ["turn/input/accepted"],
      afterSeq: String(started.seq),
      order: "asc",
      limit: "1",
    });
    if (
      accepted?.type !== "turn/input/accepted" ||
      accepted.scope.kind !== "turn" ||
      accepted.scope.turnId !== started.scope.turnId
    )
      throw new Error("The author turn has no recorded accepted input");
    let beforeSeq = String(accepted.seq);
    for (;;) {
      const requests = await this.bb.sdk.threads.events.list({
        threadId: thread.id,
        types: ["client/turn/requested"],
        beforeSeq,
        order: "desc",
        limit: "100",
      });
      for (const event of requests)
        if (
          event.type === "client/turn/requested" &&
          event.data.requestId === accepted.data.clientRequestId
        )
          return event.data.execution.model;
      if (!requests.length) throw new Error("The author turn has no recorded execution model");
      beforeSeq = String(requests.at(-1)!.seq);
    }
  }
  async start(caller: string, request: ReviewRequest, signal: AbortSignal) {
    return this.serial(caller, async () => {
      const thread = await this.bb.sdk.threads.get({ threadId: caller, include: "environment" });
      if (thread.originPluginId === "review")
        throw new Error("Reviewer threads cannot start another review");
      const environment = "environment" in thread ? thread.environment : undefined;
      if (!environment?.path || environment.status !== "ready")
        throw new Error("This thread needs a ready project environment");
      if (request.kind === "implementation" && !request.target)
        throw new Error(
          "Implementation review needs a GitButler branch checkpoint or explicit base/head. Uncommitted workspace changes are not a fixed target",
        );
      const { prior: last, busy } = await this.previous(caller);
      if (busy) return busy;
      const target = request.target
        ? await this.readHost().call(
            "snapshot",
            { environmentPath: environment.path, target: request.target, scope: request.scope },
            { hostId: environment.hostId, signal },
          )
        : null;
      const reviewer = pickReviewer(
        { providerId: thread.providerId, model: await this.authorModel(thread) },
        await this.models(),
        request.mode,
      );
      const evidence = await this.captureEvidence(environment.hostId, request.evidence, signal);
      const fingerprint = hash({ request: { ...request, reuse: undefined }, target, evidence });
      if (
        request.reuse === "auto" &&
        last?.fingerprint === fingerprint &&
        last.status === "completed"
      )
        return this.receipt(last, true);
      const run: ReviewRun = {
        id: randomUUID(),
        contractVersion: CONTRACT_VERSION,
        parentThreadId: caller,
        projectId: thread.projectId,
        environmentId: environment.id,
        hostId: environment.hostId,
        environmentPath: environment.path,
        reviewer,
        reviewerThreadId: null,
        request,
        target,
        evidence,
        fingerprint,
        startedAt: Date.now(),
        afterSeq: 0,
        status: "starting",
      };
      const inherited = await this.inheritedPublication(run, signal);
      if (inherited) return inherited;
      if (Buffer.byteLength(JSON.stringify(run), "utf8") > 220000)
        throw new Error("Review context is too large; shorten the brief and evidence");
      const reuse = await this.reusable(run, last);
      if (reuse) {
        const [latest] = await this.bb.sdk.threads.events.list({
          threadId: reuse.id,
          order: "desc",
          limit: "1",
        });
        run.afterSeq = latest?.seq ?? 0;
        run.reviewerThreadId = reuse.id;
      }
      try {
        this.db
          .prepare("INSERT INTO review_runs(id,parent,status,payload) VALUES (?,?,?,?)")
          .run(run.id, caller, run.status, JSON.stringify(run));
      } catch (error) {
        const reserved = this.db
          .prepare<[string], { payload: string }>(
            "SELECT payload FROM review_runs WHERE parent = ? AND status IN ('starting','running')",
          )
          .get(caller);
        if (reserved)
          return { ...this.receipt(JSON.parse(reserved.payload) as ReviewRun, true), busy: true };
        throw error;
      }
      await this.save(run);
      await this.bb.storage.kv.set(parentKey(caller), run.id);
      return this.dispatch(run, reuse);
    });
  }
  private async reviewerThread(id: string) {
    try {
      return await this.bb.sdk.threads.get({ threadId: id });
    } catch (error) {
      if (error instanceof Error && /thread.*not found|404/i.test(error.message)) return null;
      throw error;
    }
  }
  private async queued(run: ReviewRun) {
    if (!run.reviewerThreadId) return false;
    const messages = await this.bb.sdk.threads.queuedMessages.list({
      threadId: run.reviewerThreadId,
    });
    if (
      messages.some(
        (message) =>
          message.id === run.queuedMessageId ||
          message.content.some(
            (item) => item.type === "text" && item.text.startsWith(`Review run ${run.id}:`),
          ),
      )
    )
      return true;
    if (!messages.some((message) => message.payload?.kind === "retry")) return false;
    const requests = await this.bb.sdk.threads.events.list({
      threadId: run.reviewerThreadId,
      types: ["client/turn/requested"],
      afterSeq: String(run.afterSeq),
      order: "asc",
      limit: "100",
    });
    const root = requests.find(
      (event) =>
        event.type === "client/turn/requested" &&
        event.data.input.some(
          (item) => item.type === "text" && item.text.startsWith(`Review run ${run.id}:`),
        ),
    );
    return (
      root?.type === "client/turn/requested" &&
      messages.some(
        (message) =>
          message.payload?.kind === "retry" &&
          message.payload.retryOfTurnRequestId === root.data.requestId,
      )
    );
  }

  private async isRunReviewer(run: ReviewRun, caller: string) {
    if (caller === run.reviewerThreadId) return true;
    if (run.reviewerThreadId) return false;
    const child = await this.reviewerThread(caller);
    return child ? this.isRunChild(run, child) : false;
  }
  private async isRunChild(
    run: ReviewRun,
    child: Pick<
      ThreadResponse,
      "id" | "parentThreadId" | "originPluginId" | "projectId" | "environmentId"
    >,
  ) {
    if (
      child.parentThreadId !== run.parentThreadId ||
      child.originPluginId !== "review" ||
      child.projectId !== run.projectId ||
      child.environmentId !== run.environmentId
    )
      return false;
    const seed = await this.bb.sdk.threads.getPluginMetadata({ threadId: child.id });
    return (seed as { reviewRun?: { id?: string } }).reviewRun?.id === run.id;
  }
  private async recoverDispatch(run: ReviewRun) {
    const children = await this.bb.sdk.threads.list({
      parentThreadId: run.parentThreadId,
      originPluginId: "review",
      includeHidden: true,
    });
    for (const child of children) {
      if (await this.isRunChild(run, child)) {
        run.reviewerThreadId = child.id;
        run.status = "running";
        await this.bb.storage.kv.set(reviewerKey(child.id), run.id);
        await this.save(run);
        break;
      }
    }
    if (run.status === "starting" && Date.now() - run.startedAt > 120000) {
      run.status = "failed";
      run.error = "Dispatch expired without a reviewer child";
      await this.save(run);
    }
  }
  private async previous(caller: string) {
    const lastId = await this.bb.storage.kv.get<string>(parentKey(caller));
    let last = lastId ? this.stored(lastId) : undefined;
    const reservation = this.db
      .prepare<[string], { payload: string }>(
        "SELECT payload FROM review_runs WHERE parent = ? AND status IN ('starting','running')",
      )
      .get(caller);
    if (reservation) last = JSON.parse(reservation.payload) as ReviewRun;
    if (last?.status === "starting") {
      await this.recoverDispatch(last);
      if (last.status === "starting")
        return {
          prior: last,
          busy: {
            ...this.receipt(last, true),
            busy: true,
            message:
              "Dispatch is pending or was interrupted. No duplicate will be spawned and this run cannot clear a candidate.",
          },
        };
    }
    if (last?.reviewerThreadId) {
      const existing = await this.reviewerThread(last.reviewerThreadId);
      if (existing && (active.has(existing.status) || (await this.queued(last))))
        return {
          prior: last,
          busy: {
            ...this.receipt(last, true),
            busy: true,
            message:
              "A review is still running. Its candidate remains fixed; wait before submitting the next candidate.",
          },
        };
      if (!existing) {
        last.reviewerThreadId = null;
        last.status = "incomplete";
        await this.save(last);
      }
      if (last.status === "running") {
        last.status = "incomplete";
        await this.save(last);
      }
    }
    return { prior: last, busy: null };
  }
  private async captureEvidence(
    hostId: string,
    refs: ReviewRequest["evidence"],
    signal: AbortSignal,
  ) {
    const evidence: Evidence[] = [];
    for (const ref of refs) {
      const file = await this.bb.sdk.files.read({
        hostId: hostId,
        path: ref.path,
        signal,
      });
      if (file.contentEncoding !== "utf8" || Buffer.byteLength(file.content, "utf8") > 12288)
        throw new Error(
          "Evidence must be UTF-8 text up to 12 KiB per reference; supply a focused report with source provenance",
        );
      evidence.push({ ...ref, text: file.content, sha256: hash(file.content) });
    }
    return evidence;
  }
  private compatible(
    candidate: ThreadResponse,
    previousRun: ReviewRun | undefined,
    run: ReviewRun,
  ) {
    return (
      previousRun?.contractVersion === CONTRACT_VERSION &&
      candidate.originPluginId === "review" &&
      candidate.parentThreadId === run.parentThreadId &&
      candidate.environmentId === run.environmentId &&
      candidate.providerId === run.reviewer.providerId &&
      candidate.status === "idle" &&
      !candidate.archivedAt &&
      previousRun?.reviewer.model === run.reviewer.model &&
      scope(previousRun) === scope(run)
    );
  }
  private async reusable(run: ReviewRun, last: ReviewRun | undefined) {
    let reuse: ThreadResponse | undefined;
    if (run.request.reuse === "new") return undefined;
    const wanted =
      typeof run.request.reuse === "object" ? run.request.reuse.threadId : last?.reviewerThreadId;
    if (wanted) {
      const candidate = await this.reviewerThread(wanted);
      const previousId = await this.bb.storage.kv.get<string>(reviewerKey(wanted));
      const previousRun = previousId ? this.stored(previousId) : undefined;
      const eligible = candidate !== null && this.compatible(candidate, previousRun, run);
      if (eligible) {
        const context = await this.bb.sdk.threads.context({ threadId: wanted });
        const usage = context.usage;
        if (
          usage &&
          typeof usage.usedTokens === "number" &&
          typeof usage.modelContextWindow === "number" &&
          usage.modelContextWindow > 0 &&
          usage.usedTokens / usage.modelContextWindow < 0.6
        )
          reuse = candidate;
      }
      if (typeof run.request.reuse === "object" && !reuse)
        throw new Error(
          "Requested reviewer is busy, incompatible, archived, or has too much context; use reuse:new",
        );
    }
    return reuse;
  }
  private async dispatch(run: ReviewRun, reuse: ThreadResponse | undefined) {
    try {
      const prompt = reviewerPrompt(run);
      if (reuse) {
        await this.bb.storage.kv.set(reviewerKey(reuse.id), run.id);
        await this.bb.sdk.threads.updatePluginMetadata({
          threadId: reuse.id,
          set: metadata(run),
        });
        const delivery = await this.bb.sdk.threads.send({
          threadId: reuse.id,
          input: [{ type: "text", text: prompt, mentions: [] }],
          mode: "start",
          model: run.reviewer.model,
          reasoningLevel: run.reviewer.reasoningLevel,
          serviceTier: run.reviewer.serviceTier,
        });
        if (delivery.delivery === "queued") run.queuedMessageId = delivery.queuedMessage.id;
      } else {
        const child = await this.bb.sdk.threads.spawn({
          projectId: run.projectId,
          environment: { type: "reuse", environmentId: run.environmentId },
          parentThreadId: run.parentThreadId,
          visibility: "hidden",
          title: `${run.request.mode[0]!.toUpperCase()}${run.request.mode.slice(1)} ${run.request.kind} review`,
          providerId: run.reviewer.providerId,
          model: run.reviewer.model,
          reasoningLevel: run.reviewer.reasoningLevel,
          serviceTier: run.reviewer.serviceTier,
          pluginMetadata: metadata(run),
          prompt,
        });
        run.reviewerThreadId = child.id;
      }
      run.status = "running";
      await this.bb.storage.kv.set(reviewerKey(run.reviewerThreadId!), run.id);
      await this.save(run);
      return this.receipt(run, Boolean(reuse));
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      // Definite dispatch rejection can be retried. Ambiguous transport errors
      // retain the reservation for child adoption, preventing a duplicate spawn.
      const uncertain = /timeout|timed out|abort|fetch failed|ECONN/i.test(run.error);
      if (run.status === "starting" && !uncertain) run.status = "failed";
      await this.save(run);
      throw error;
    }
  }
  private receipt(run: ReviewRun, reused: boolean) {
    return {
      runId: run.id,
      threadId: run.reviewerThreadId,
      reused,
      kind: run.request.kind,
      mode: run.request.mode,
      scope: run.request.scope,
      status: run.status,
      target: run.target,
    };
  }

  async context(caller: string, input: ContextRequest, signal: AbortSignal) {
    const run = await this.authorize(input.runId, caller);
    if (["diff", "tree", "file"].includes(input.section)) {
      if (!run.target) throw new Error("This design review has no pinned repository target");
      const result = await this.readHost().call(
        "read",
        {
          target: run.target,
          section: input.section as "diff" | "tree" | "file",
          ...(input.path ? { path: input.path } : {}),
          side: input.side,
          offset: input.offset,
        },
        { hostId: run.hostId, signal },
      );
      if (await this.isRunReviewer(run, caller)) {
        const [accepted] = await this.bb.sdk.threads.events.list({
          threadId: caller,
          types: ["turn/input/accepted"],
          afterSeq: String(run.afterSeq),
          order: "desc",
          limit: "1",
        });
        const turnId = accepted?.scope.kind === "turn" ? accepted.scope.turnId : "";
        this.db
          .prepare(
            "INSERT OR REPLACE INTO review_turn_reads(run_id,turn_id,section,path,side,start,end,total,digest) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            run.id,
            turnId,
            input.section,
            input.path ?? "",
            input.side,
            Math.min(input.offset, result.totalLength),
            Math.min(input.offset + result.text.length, result.totalLength),
            result.totalLength,
            result.sha256,
          );
      }
      return result;
    }
    const text =
      input.section === "brief"
        ? (run.request.brief ?? run.request.summary)
        : input.section === "report"
          ? JSON.stringify((await this.bb.storage.kv.get(`report:${run.id}`)) ?? null)
          : JSON.stringify(run.evidence);
    const end = Math.min(input.offset + 16000, text.length);
    return { text: text.slice(input.offset, end), nextOffset: end < text.length ? end : null };
  }
  private parseReport(text: string, id: string) {
    try {
      const report = reportSchema.parse(JSON.parse(text));
      return report.runId === id ? report : null;
    } catch {
      return null;
    }
  }
  private assessment(
    run: ReviewRun,
    events: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>,
  ) {
    const bound = bindAssessment(run, events);
    return { ...bound, report: bound.valid ? this.parseReport(bound.text, run.id) : null };
  }
  private async currentCandidate(run: ReviewRun, signal: AbortSignal) {
    if (!run.target) return true;
    if (run.target && run.request.target) {
      try {
        const now = await this.readHost().call(
          "snapshot",
          {
            environmentPath: run.environmentPath,
            target: run.request.target,
            scope: run.request.scope,
          },
          { hostId: run.hostId, signal },
        );
        return now.base === run.target.base && now.head === run.target.head;
      } catch {
        return false;
      }
    }
    return false;
  }
  private clearsPublication(
    run: ReviewRun,
    report: z.infer<typeof reportSchema> | null,
    current: boolean,
    covered: boolean,
  ) {
    return Boolean(
      report?.status === "complete" &&
      current &&
      covered &&
      run.request.kind === "implementation" &&
      run.request.mode === "deep" &&
      run.request.scope === "publication" &&
      !report.findings.some((finding) => finding.priority <= 1),
    );
  }
  private reportStatus(
    report: z.infer<typeof reportSchema> | null,
    unread: boolean,
  ): ReviewRun["status"] {
    if (!report) return "failed";
    if (report.status === "incomplete" || unread) return "incomplete";
    return "completed";
  }
  private async readResultEvents(run: ReviewRun, waitSeconds: number, signal: AbortSignal) {
    const reviewer = await this.reviewerThread(run.reviewerThreadId!);
    if (waitSeconds && reviewer?.status !== "error")
      await this.bb.sdk.threads
        .wait({
          threadId: run.reviewerThreadId!,
          status: "idle",
          timeoutMs: waitSeconds * 1000,
          signal,
        })
        .catch(async (error) => {
          if (signal.aborted) throw error;
          if (/timeout|timed out/i.test(error instanceof Error ? error.message : String(error)))
            return;
          const current = await this.reviewerThread(run.reviewerThreadId!);
          if (current?.status === "error" || !current) return;
          throw error;
        });
    const events = [];
    let afterSeq = run.afterSeq;
    for (;;) {
      const page = await this.bb.sdk.threads.events.list({
        threadId: run.reviewerThreadId!,
        types: [
          "client/turn/requested",
          "client/turn/rejected",
          "turn/input/accepted",
          "item/completed",
          "turn/completed",
          "provider/modelFallback",
        ],
        afterSeq: String(afterSeq),
        order: "asc",
        limit: "100",
      });
      events.push(...page);
      if (page.length < 100) break;
      afterSeq = page.at(-1)!.seq;
    }
    return events;
  }
  async result(caller: string, input: ResultRequest, signal: AbortSignal) {
    const run = await this.authorize(input.runId, caller);
    if (!run.reviewerThreadId)
      return {
        ...this.receipt(run, false),
        error: run.error ?? "Review dispatch has not completed",
      };
    const reviewer = await this.reviewerThread(run.reviewerThreadId);
    if (!reviewer) {
      run.status = "incomplete";
      await this.save(run);
      return {
        ...this.receipt(run, false),
        status: "incomplete",
        deepImplementationCovered: false,
        error: "Reviewer thread was deleted; start a new assessment",
      };
    }
    if (await this.queued(run))
      return { ...this.receipt(run, false), status: "queued", deepImplementationCovered: false };
    const events = await this.readResultEvents(run, input.waitSeconds, signal);
    const { report: parsedReport, finished, text, turnId } = this.assessment(run, events);
    const thread = await this.reviewerThread(run.reviewerThreadId);
    if (!finished && thread && active.has(thread.status))
      return { ...this.receipt(run, false), status: "running" };
    let report = parsedReport;
    if (report && Buffer.byteLength(JSON.stringify(report), "utf8") > 220000) report = null;
    if (report) await this.bb.storage.kv.set(`report:${run.id}`, report);
    const diffCoverage = this.diffCoverage(run.id, turnId);
    const unreadDeepDiff =
      run.request.kind === "implementation" &&
      run.request.mode === "deep" &&
      !diffCoverage.complete;
    run.status = this.reportStatus(report, unreadDeepDiff);
    await this.save(run);
    const current = await this.currentCandidate(run, signal);
    return {
      ...this.receipt(run, false),
      diffCoverage,
      status: run.status === "completed" ? "complete" : "incomplete",
      current,
      deepImplementationCovered: this.clearsPublication(
        run,
        report,
        current,
        diffCoverage.complete,
      ),
      report,
      error: report
        ? unreadDeepDiff
          ? "Deep assessment is incomplete: the reviewer did not read every pinned diff page"
          : null
        : "No completed, uncontaminated response matched this run. It does not clear the candidate",
      rawOutput: report ? undefined : text.slice(0, 4000),
    };
  }
}
