import type {
  BbPluginApi,
  PluginThreadEventPayloads,
  PluginTurnFailedEvent,
} from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { reviewHostContract } from "../../shared/host-contract.ts";
import type {
  ContextRequest,
  Evidence,
  ResultRequest,
  Reviewer,
  ReviewRequest,
  ReviewRun,
  Seat,
} from "../../shared/schema.ts";
import { bindAssessment } from "./assessment.ts";
import {
  blocksPublication,
  fallbackReviewer,
  pickReviewers,
  reviewerPrompt,
  type ReviewerModels,
} from "./review.ts";

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
type Report = z.infer<typeof reportSchema>;
type Events = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
type ThreadResponse = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
const active = new Set(["pending", "starting", "active", "stopping"]);
/** BB reports a deleted thread as not found on every thread-scoped endpoint. */
const missing = (error: unknown) =>
  error instanceof Error && /thread.*not found|404/i.test(error.message);
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const CONTRACT_VERSION = 4;
const reviewerKey = (id: string) => `reviewer:${id}`;
const reportKey = (id: string, seat: number) => `report:${id}:${seat}`;
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
const family = (reviewer: Reviewer) => (reviewer.providerId === "claude-code" ? "Claude" : "Codex");
const identity = ({ providerId, model }: Reviewer) => ({ providerId, model });
/** A transport failure may still have delivered; the reservation stays for child adoption. */
const uncertain = (message: string) => /timeout|timed out|abort|fetch failed|ECONN/i.test(message);
/** Returns a seat whose usage-limit fallback never started to its failed assessment. */
const restore = (seat: Seat) => {
  Object.assign(seat, seat.fallback!.from);
  delete seat.fallback;
  delete seat.queuedMessageId;
};
/** Records the exhausted assessment and points the seat at its replacement; returns whether it moved. */
function reserveFallback(seat: Seat, reviewer: Reviewer, requestId: string, lastSeq?: number) {
  const { threadId, afterSeq } = seat;
  const moved = reviewer.providerId !== seat.reviewer.providerId;
  seat.fallback = {
    from: { reviewer: seat.reviewer, threadId: threadId!, afterSeq },
    requestId,
    at: Date.now(),
  };
  seat.reviewer = reviewer;
  // A moved seat starts a new child; the same thread continues after the failed turn.
  seat.threadId = moved ? null : threadId;
  seat.afterSeq = moved ? 0 : (lastSeq ?? afterSeq);
  delete seat.queuedMessageId;
  return moved;
}
/** The run's root request, when the failed request is that root or one of BB's retries of it. */
function failedRoot(runId: string, events: Events, requestId: string) {
  const latest = events.findLast((event) => event.type === "client/turn/requested");
  const root = events.find(
    (event) =>
      event.type === "client/turn/requested" &&
      !event.data.retryOfRequestId &&
      event.data.input.some(
        (item) => item.type === "text" && item.text.startsWith(`Review run ${runId}:`),
      ),
  );
  if (
    latest?.type !== "client/turn/requested" ||
    root?.type !== "client/turn/requested" ||
    latest.data.requestId !== requestId
  )
    return null;
  return latest === root || latest.data.retryOfRequestId === root.data.requestId ? root : null;
}
const fallbackNote = ({ reviewer, fallback }: Seat) =>
  fallback && {
    from: identity(fallback.from.reviewer),
    threadId: fallback.from.threadId,
    note:
      fallback.from.reviewer.providerId === reviewer.providerId
        ? `${fallback.from.reviewer.model} hit a usage limit; this review reran on ${reviewer.model}.`
        : `${family(fallback.from.reviewer)} hit a usage limit; this seat reran on ${family(reviewer)}, so the panel ran on one family.`,
  };
// Turn ids are only meaningful within their thread; contract 3 runs recorded bare turn ids.
const readKey = (run: ReviewRun, threadId: string, turnId: string) =>
  run.contractVersion < 4 ? turnId : `${threadId}:${turnId}`;
const metadata = (run: ReviewRun, seat: number) => ({
  reviewRun: {
    contractVersion: run.contractVersion,
    id: run.id,
    mode: run.request.mode,
    kind: run.request.kind,
    startedAt: run.startedAt,
    summary: run.request.summary,
    target: run.target,
    status: run.status,
    seat,
    reviewer: identity(run.seats[seat]!.reviewer),
  },
});

type StoredV3Run = Omit<ReviewRun, "seats"> & {
  reviewer: Reviewer;
  reviewerThreadId: string | null;
  afterSeq: number;
  queuedMessageId?: string;
};
/** Every stored payload enters here; contract 3 runs had one reviewer and become one seat. */
export function parseRun(payload: string): ReviewRun {
  const value = JSON.parse(payload) as ReviewRun | StoredV3Run;
  if ("seats" in value) return value;
  const { reviewer, reviewerThreadId, afterSeq, queuedMessageId, ...run } = value;
  const seat: Seat = { reviewer, threadId: reviewerThreadId, afterSeq };
  if (queuedMessageId) seat.queuedMessageId = queuedMessageId;
  return { ...run, seats: [seat] };
}

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
      `DROP INDEX IF EXISTS review_active_parent`,
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
    for (const [index, seat] of run.seats.entries())
      if (
        seat.threadId &&
        (await this.bb.storage.kv.get<string>(reviewerKey(seat.threadId))) === run.id
      )
        await this.bb.sdk.threads
          .updatePluginMetadata({ threadId: seat.threadId, set: metadata(run, index) })
          .catch((error) => {
            if (!missing(error)) throw error;
          });
  }
  private stored(id: string): ReviewRun | undefined {
    const row = this.db
      .prepare<[string], { payload: string }>("SELECT payload FROM review_runs WHERE id = ?")
      .get(id);
    return row ? parseRun(row.payload) : undefined;
  }
  /** Newest first. */
  private runs(parent: string) {
    return this.db
      .prepare<[string], { payload: string }>(
        "SELECT payload FROM review_runs WHERE parent = ? ORDER BY rowid DESC",
      )
      .all(parent)
      .map((row) => parseRun(row.payload));
  }
  private diffCoverage(id: string, turnId: string) {
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
    if (
      run &&
      (caller === run.parentThreadId || run.seats.some((seat) => seat.threadId === caller))
    )
      return run;
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
        const prior = parseRun(row.payload);
        if (publicationIdentity(prior) !== publicationIdentity(run)) continue;
        const result = await this.result(
          run.parentThreadId,
          { runId: prior.id, waitSeconds: 0 },
          signal,
        );
        if (
          "current" in result &&
          result.current &&
          result.reviews.every((review) => review.status === "complete")
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
      for (const run of this.runs(caller))
        if (run.status === "starting") await this.recoverDispatch(run);
      const target = request.target
        ? await this.readHost().call(
            "snapshot",
            { environmentPath: environment.path, target: request.target, scope: request.scope },
            { hostId: environment.hostId, signal },
          )
        : null;
      const reviewers = pickReviewers(
        { providerId: thread.providerId, model: await this.authorModel(thread) },
        await this.models(),
        request.mode,
      );
      const evidence = await this.captureEvidence(environment.hostId, request.evidence, signal);
      const fingerprint = hash({ request: { ...request, reuse: undefined }, target, evidence });
      const identical = this.runs(caller).find((run) => run.fingerprint === fingerprint);
      const held = identical && (await this.held(identical));
      if (held) return held;
      if (request.reuse === "auto" && identical?.status === "completed")
        return this.receipt(identical, true);
      const run: ReviewRun = {
        id: randomUUID(),
        contractVersion: CONTRACT_VERSION,
        parentThreadId: caller,
        projectId: thread.projectId,
        environmentId: environment.id,
        hostId: environment.hostId,
        environmentPath: environment.path,
        seats: reviewers.map((reviewer) => ({ reviewer, threadId: null, afterSeq: 0 })) as [
          Seat,
          ...Seat[],
        ],
        request,
        target,
        evidence,
        fingerprint,
        startedAt: Date.now(),
        status: "starting",
      };
      const inherited = await this.inheritedPublication(run, signal);
      if (inherited) return inherited;
      if (Buffer.byteLength(JSON.stringify(run), "utf8") > 220000)
        throw new Error("Review context is too large; shorten the brief and evidence");
      const reuse = await this.assignReuse(run);
      this.db
        .prepare("INSERT INTO review_runs(id,parent,status,payload) VALUES (?,?,?,?)")
        .run(run.id, caller, run.status, JSON.stringify(run));
      await this.save(run);
      return this.dispatch(run, reuse);
    });
  }
  private async reviewerThread(id: string) {
    try {
      return await this.bb.sdk.threads.get({ threadId: id });
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  /** Reload recovery: usage failures and fallback dispatches that no live event will finish. */
  async reconcileFailures(signal: AbortSignal) {
    const rows = this.db
      .prepare<[], { payload: string }>(
        "SELECT payload FROM review_runs WHERE status IN ('starting','running')",
      )
      .all();
    for (const row of rows) {
      if (signal.aborted) return;
      const { id, parentThreadId, status } = parseRun(row.payload);
      try {
        if (status === "starting")
          await this.serial(parentThreadId, async () => {
            const current = this.stored(id)!;
            if (current.status === "starting") await this.recoverDispatch(current);
          });
        const run = this.stored(id)!;
        for (const seat of run.seats) await this.reconcileSeat(run, seat, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.bb.log.warn(`Reviewer fallback recovery failed for ${id}: ${String(error)}`);
      }
    }
  }
  private async reconcileSeat(run: ReviewRun, seat: Seat, signal: AbortSignal) {
    if (!seat.threadId || seat.fallback) return;
    const thread = await this.reviewerThread(seat.threadId);
    if (thread?.status !== "error") return;
    const events = await this.readResultEvents(seat.threadId, seat.afterSeq, signal);
    const request = events.findLast((event) => event.type === "client/turn/requested");
    const failure = events.findLast((event) => event.type === "provider/error");
    if (
      request?.type === "client/turn/requested" &&
      failure?.type === "provider/error" &&
      failure.seq > request.seq
    )
      await this.reviewerFailed({
        threadId: thread.id,
        requestId: request.data.requestId,
        errorInfo: failure.data.errorInfo ?? null,
      });
  }

  /**
   * A seat whose reviewer hit a usage limit gets one new assessment of the same candidate.
   * A panel seat moves to the panel's other family; Quick switches model family on its provider.
   */
  async reviewerFailed(event: Pick<PluginTurnFailedEvent, "threadId" | "requestId" | "errorInfo">) {
    if (event.errorInfo?.category !== "rate-limit") return;
    const child = await this.reviewerThread(event.threadId);
    if (child?.originPluginId !== "review") return;
    const seed = await this.bb.sdk.threads.getPluginMetadata({ threadId: event.threadId });
    const id = (seed as { reviewRun?: { id?: string } }).reviewRun?.id;
    const initial = typeof id === "string" ? this.stored(id) : undefined;
    if (!initial) return;
    return this.serial(initial.parentThreadId, () => this.fallBack(initial.id, event));
  }
  private async fallBack(
    id: string,
    { threadId, requestId }: { threadId: string; requestId: string },
  ) {
    const run = this.stored(id)!;
    const index = run.seats.findIndex((seat) => seat.threadId === threadId);
    const seat = run.seats[index];
    if (run.status === "completed" || !seat || seat.fallback) return;
    const thread = await this.reviewerThread(threadId);
    if (!thread || thread.status !== "error" || thread.archivedAt) return;
    const events = await this.readResultEvents(
      threadId,
      seat.afterSeq,
      new AbortController().signal,
    );
    const root = failedRoot(run.id, events, requestId);
    const reviewer = root && (await this.fallbackFor(run, seat));
    if (!root || !reviewer) return;
    const retired = metadata(run, index).reviewRun;
    // Save the reservation before dispatch: duplicate events and reloads cannot bounce back.
    const moved = reserveFallback(seat, reviewer, root.data.requestId, events.at(-1)?.seq);
    delete run.error;
    run.status = "starting";
    await this.save(run);
    for (const entry of await this.bb.sdk.threads.queuedMessages.list({ threadId }))
      await this.cancelObsoleteRetry(entry);
    // The exhausted child leaves the panel; settle its metadata so the banner stops polling it.
    if (moved)
      await this.bb.sdk.threads
        .updatePluginMetadata({ threadId, set: { reviewRun: { ...retired, status: "failed" } } })
        .catch((error) => {
          if (!missing(error)) throw error;
        });
    const started: string[] = [];
    try {
      // A full new assessment gets its own request and diff reads.
      await this.dispatchSeat(run, index, moved ? undefined : thread, started);
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      if (uncertain(run.error)) return await this.save(run);
      await this.stopSeats(run, started);
      restore(seat);
    }
    // A seat whose initial dispatch is still unresolved keeps the run recovering.
    if (run.seats.every((seat) => seat.threadId)) run.status = "running";
    await this.save(run);
  }
  private async fallbackFor(run: ReviewRun, { reviewer }: Seat) {
    if (run.seats.length > 1) {
      const other = run.seats.find((seat) => seat.reviewer.providerId !== reviewer.providerId);
      return other ? { ...other.reviewer } : null;
    }
    const catalog = await this.bb.sdk.providers.models({
      providerId: reviewer.providerId,
      environmentId: run.environmentId,
    });
    return fallbackReviewer(reviewer, catalog.models);
  }
  /** BB keeps retrying a turn that hit a usage limit; a seat that fell back must not rerun it. */
  async cancelObsoleteRetry(entry: PluginThreadEventPayloads["message.queued"]["entry"]) {
    if (entry.payload?.kind !== "retry") return;
    const { retryOfTurnRequestId } = entry.payload;
    const run = await this.lastRunOf(entry.threadId);
    if (!run?.seats.some((seat) => seat.fallback?.requestId === retryOfTurnRequestId)) return;
    await this.bb.sdk.threads.queuedMessages.delete({
      threadId: entry.threadId,
      queuedMessageId: entry.id,
    });
  }
  private async queued(run: ReviewRun, seat: Seat) {
    if (!seat.threadId) return false;
    // A deleted reviewer has no queue; readSeat reports it as deleted.
    const messages = await this.bb.sdk.threads.queuedMessages
      .list({ threadId: seat.threadId })
      .catch((error) => {
        if (missing(error)) return [];
        throw error;
      });
    if (
      messages.some(
        (message) =>
          message.id === seat.queuedMessageId ||
          message.content.some(
            (item) => item.type === "text" && item.text.startsWith(`Review run ${run.id}:`),
          ),
      )
    )
      return true;
    if (!messages.some((message) => message.payload?.kind === "retry")) return false;
    const requests = await this.bb.sdk.threads.events.list({
      threadId: seat.threadId,
      types: ["client/turn/requested"],
      afterSeq: String(seat.afterSeq),
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

  /** The seat a reviewer thread occupies, including a child whose spawn has not returned. */
  private async callerSeat(run: ReviewRun, caller: string) {
    const bound = run.seats.find((seat) => seat.threadId === caller);
    if (bound) return bound;
    if (run.seats.every((seat) => seat.threadId)) return null;
    const child = await this.reviewerThread(caller);
    const index = child ? await this.childSeat(run, child) : null;
    return index !== null && !run.seats[index]!.threadId ? run.seats[index]! : null;
  }
  private async childSeat(
    run: ReviewRun,
    child: Pick<
      ThreadResponse,
      "id" | "parentThreadId" | "originPluginId" | "projectId" | "environmentId" | "providerId"
    >,
  ) {
    if (
      child.parentThreadId !== run.parentThreadId ||
      child.originPluginId !== "review" ||
      child.projectId !== run.projectId ||
      child.environmentId !== run.environmentId
    )
      return null;
    const seed = (await this.bb.sdk.threads.getPluginMetadata({ threadId: child.id })) as {
      reviewRun?: { id?: string; seat?: number };
    };
    if (seed.reviewRun?.id !== run.id) return null;
    const seat = seed.reviewRun.seat ?? 0;
    // A seat that moved family never readopts its exhausted thread.
    return Number.isInteger(seat) &&
      seat >= 0 &&
      seat < run.seats.length &&
      run.seats[seat]!.reviewer.providerId === child.providerId
      ? seat
      : null;
  }
  /**
   * Stop reviewers this run already started and cancel its queued prompts, so a
   * failed dispatch leaves nothing running or waiting to run. BB's stop keeps queued messages.
   */
  private async stopSeats(run: ReviewRun, threadIds: string[]) {
    const unstopped = new Set<string>();
    for (const threadId of threadIds) {
      const queuedMessageId = run.seats.find((seat) => seat.threadId === threadId)?.queuedMessageId;
      if (queuedMessageId)
        await this.bb.sdk.threads.queuedMessages
          .delete({ threadId, queuedMessageId })
          .catch(() => unstopped.add(threadId));
      await this.bb.sdk.threads.stop({ threadId }).catch(() => unstopped.add(threadId));
    }
    if (unstopped.size) run.error = `${run.error} Could not stop ${[...unstopped].join(", ")}.`;
  }
  private async recoverDispatch(run: ReviewRun) {
    const children = await this.bb.sdk.threads.list({
      parentThreadId: run.parentThreadId,
      originPluginId: "review",
      includeHidden: true,
    });
    let adopted = false;
    for (const child of children) {
      const index = await this.childSeat(run, child);
      if (index === null || run.seats[index]!.threadId) continue;
      run.seats[index]!.threadId = child.id;
      adopted = true;
      await this.bb.storage.kv.set(reviewerKey(child.id), run.id);
    }
    // A moved seat whose child never appeared returns to its failed assessment.
    for (const seat of run.seats)
      if (!seat.threadId && seat.fallback && Date.now() - seat.fallback.at > 120000) restore(seat);
    if (run.seats.every((seat) => seat.threadId)) run.status = "running";
    else if (
      Date.now() - run.startedAt > 120000 &&
      run.seats.some((seat) => !seat.threadId && !seat.fallback)
    ) {
      run.status = "failed";
      run.error = "Dispatch expired without a child for every reviewer";
      // Stop only reviewers this run still holds; another run may have taken one since.
      const owned: string[] = [];
      for (const { threadId } of run.seats)
        if (threadId && (await this.bb.storage.kv.get<string>(reviewerKey(threadId))) === run.id)
          owned.push(threadId);
      await this.stopSeats(run, owned);
    } else if (!adopted) return;
    await this.save(run);
  }
  /** An unsettled run of the identical request answers a repeat instead of a duplicate panel. */
  private async held(run: ReviewRun) {
    if (run.status === "starting")
      return {
        ...this.receipt(run, true),
        busy: true,
        message:
          "Dispatch is pending or was interrupted. No duplicate will be spawned and this run cannot clear a candidate.",
      };
    if (run.status !== "running") return null;
    // A panel that lost a reviewer cannot complete, so a repeat starts over.
    for (const seat of run.seats)
      if (!seat.threadId || !(await this.reviewerThread(seat.threadId))) {
        run.status = "incomplete";
        await this.save(run);
        return null;
      }
    return {
      ...this.receipt(run, true),
      busy: true,
      message:
        "This identical review already has a run. Wait for BB's notification, then call review_result with this run ID.",
    };
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
    reviewer: Reviewer,
  ) {
    const used = previousRun?.seats.find((seat) => seat.threadId === candidate.id)?.reviewer;
    return (
      previousRun?.contractVersion === CONTRACT_VERSION &&
      candidate.originPluginId === "review" &&
      candidate.parentThreadId === run.parentThreadId &&
      candidate.environmentId === run.environmentId &&
      candidate.providerId === reviewer.providerId &&
      candidate.status === "idle" &&
      !candidate.archivedAt &&
      used?.providerId === reviewer.providerId &&
      used.model === reviewer.model &&
      scope(previousRun) === scope(run)
    );
  }
  private async lastRunOf(threadId: string) {
    const previousId = await this.bb.storage.kv.get<string>(reviewerKey(threadId));
    return previousId ? this.stored(previousId) : undefined;
  }
  private async eligible(threadId: string, run: ReviewRun, reviewer: Reviewer) {
    const candidate = await this.reviewerThread(threadId);
    const previousRun = await this.lastRunOf(threadId);
    if (!candidate || !previousRun || !this.compatible(candidate, previousRun, run, reviewer))
      return undefined;
    // An idle reviewer can still belong to an unsettled dispatch or hold another run's queued turn.
    const seat = previousRun.seats.find((seat) => seat.threadId === threadId)!;
    if (previousRun.status === "starting" || (await this.queued(previousRun, seat)))
      return undefined;
    const { usage } = await this.bb.sdk.threads.context({ threadId });
    return usage &&
      typeof usage.usedTokens === "number" &&
      typeof usage.modelContextWindow === "number" &&
      usage.modelContextWindow > 0 &&
      usage.usedTokens / usage.modelContextWindow < 0.6
      ? candidate
      : undefined;
  }
  /** Binds each seat to the thread it continues; undefined entries spawn fresh. */
  private async assignReuse(run: ReviewRun) {
    const reuse = await this.reusable(run);
    for (const [index, thread] of reuse.entries()) {
      if (!thread) continue;
      const [latest] = await this.bb.sdk.threads.events.list({
        threadId: thread.id,
        order: "desc",
        limit: "1",
      });
      run.seats[index]!.afterSeq = latest?.seq ?? 0;
      run.seats[index]!.threadId = thread.id;
    }
    return reuse;
  }
  private async reusable(run: ReviewRun) {
    const reuse: (ThreadResponse | undefined)[] = run.seats.map(() => undefined);
    const { reuse: wanted } = run.request;
    if (wanted === "new") return reuse;
    if (typeof wanted === "object") {
      const used = (await this.lastRunOf(wanted.threadId))?.seats.find(
        (seat) => seat.threadId === wanted.threadId,
      )?.reviewer;
      if (!used)
        throw new Error("Requested thread is not a reviewer from an earlier run; use reuse:new");
      const index = run.seats.findIndex(
        ({ reviewer }) => used.providerId === reviewer.providerId && used.model === reviewer.model,
      );
      if (index < 0)
        throw new Error(
          "Requested reviewer matches no reviewer model on this run's panel; use reuse:new",
        );
      reuse[index] = await this.eligible(wanted.threadId, run, run.seats[index]!.reviewer);
      if (!reuse[index])
        throw new Error(
          "Requested reviewer is busy, incompatible, archived, or has too much context; use reuse:new",
        );
      return reuse;
    }
    // Concurrent runs each hold reviewers; each seat takes the newest idle one in this workstream.
    const prior = this.runs(run.parentThreadId)
      .filter((previous) => scope(previous) === scope(run))
      .flatMap((previous) => previous.seats);
    const tried = new Set<string>();
    for (const [index, { reviewer }] of run.seats.entries())
      reuse[index] = await this.idleReviewer(run, reviewer, prior, tried);
    return reuse;
  }
  private async idleReviewer(
    run: ReviewRun,
    reviewer: Reviewer,
    prior: Seat[],
    tried: Set<string>,
  ) {
    for (const { threadId, reviewer: used } of prior) {
      if (
        !threadId ||
        tried.has(threadId) ||
        used.providerId !== reviewer.providerId ||
        used.model !== reviewer.model
      )
        continue;
      tried.add(threadId);
      const thread = await this.eligible(threadId, run, reviewer);
      if (thread) return thread;
    }
    return undefined;
  }
  private async dispatch(run: ReviewRun, reuse: (ThreadResponse | undefined)[]) {
    const started: string[] = [];
    try {
      for (const index of run.seats.keys()) {
        await this.dispatchSeat(run, index, reuse[index], started);
        // Persist each child before the next spawn so a crash cannot orphan it.
        await this.save(run);
      }
      run.status = "running";
      await this.save(run);
      return this.receipt(run, reuse.some(Boolean));
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      // Definite dispatch rejection can be retried. Ambiguous transport errors
      // retain the reservation for child adoption, preventing a duplicate spawn.
      if (run.status === "starting" && !uncertain(run.error)) {
        run.status = "failed";
        await this.stopSeats(run, started);
      }
      await this.save(run);
      throw error;
    }
  }
  /** Sends the run's prompt to a reused reviewer or spawns the seat's child. */
  private async dispatchSeat(
    run: ReviewRun,
    index: number,
    thread: ThreadResponse | undefined,
    started: string[],
  ) {
    const seat = run.seats[index]!;
    const { reviewer } = seat;
    // Every seat, including one that falls back later, gets the identical prompt.
    const prompt = reviewerPrompt(run);
    if (thread) {
      await this.bb.storage.kv.set(reviewerKey(thread.id), run.id);
      await this.bb.sdk.threads.updatePluginMetadata({
        threadId: thread.id,
        set: metadata(run, index),
      });
      const delivery = await this.bb.sdk.threads.send({
        threadId: thread.id,
        input: [{ type: "text", text: prompt, mentions: [] }],
        mode: "start",
        model: reviewer.model,
        reasoningLevel: reviewer.reasoningLevel,
        serviceTier: reviewer.serviceTier,
      });
      started.push(thread.id);
      if (delivery.delivery === "queued") seat.queuedMessageId = delivery.queuedMessage.id;
      return;
    }
    const mode = `${run.request.mode[0]!.toUpperCase()}${run.request.mode.slice(1)}`;
    const child = await this.bb.sdk.threads.spawn({
      projectId: run.projectId,
      environment: { type: "reuse", environmentId: run.environmentId },
      parentThreadId: run.parentThreadId,
      visibility: "hidden",
      title: `${mode} ${run.request.kind} review (${family(reviewer)})`,
      providerId: reviewer.providerId,
      model: reviewer.model,
      reasoningLevel: reviewer.reasoningLevel,
      serviceTier: reviewer.serviceTier,
      pluginMetadata: metadata(run, index),
      prompt,
    });
    started.push(child.id);
    seat.threadId = child.id;
    await this.bb.storage.kv.set(reviewerKey(child.id), run.id);
  }
  private receipt(run: ReviewRun, reused: boolean) {
    return {
      runId: run.id,
      threadIds: run.seats.map((seat) => seat.threadId),
      reviewers: run.seats.map((seat) => identity(seat.reviewer)),
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
      const seat = await this.callerSeat(run, caller);
      if (seat) {
        const [accepted] = await this.bb.sdk.threads.events.list({
          threadId: caller,
          types: ["turn/input/accepted"],
          afterSeq: String(seat.afterSeq),
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
            readKey(run, caller, turnId),
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
          ? JSON.stringify(await this.storedReports(run))
          : JSON.stringify(run.evidence);
    const end = Math.min(input.offset + 16000, text.length);
    return { text: text.slice(input.offset, end), nextOffset: end < text.length ? end : null };
  }
  /** One key per seat: each report may approach BB's KV value limit on its own. */
  private async storeReports(
    run: ReviewRun,
    reviews: {
      reviewer: ReturnType<typeof identity>;
      report: Report | null;
      fallback: ReturnType<typeof fallbackNote>;
    }[],
  ) {
    for (const [index, { reviewer, report, fallback }] of reviews.entries())
      if (report)
        await this.bb.storage.kv.set(reportKey(run.id, index), {
          reviewer,
          report,
          ...(fallback ? { fallback } : {}),
        });
  }
  /** Seat reports in panel order; runs finished before per-seat keys kept one value under `report:<id>`. */
  private async storedReports(run: ReviewRun) {
    const reports = [];
    for (const index of run.seats.keys()) {
      const entry = await this.bb.storage.kv.get(reportKey(run.id, index));
      if (entry) reports.push(entry);
    }
    return reports.length ? reports : ((await this.bb.storage.kv.get(`report:${run.id}`)) ?? null);
  }
  private parseReport(text: string, id: string) {
    try {
      const report = reportSchema.parse(JSON.parse(text));
      return report.runId === id ? report : null;
    } catch {
      return null;
    }
  }
  private assessment(run: ReviewRun, seat: Seat, events: Events) {
    const bound = bindAssessment(run.id, seat.reviewer, events);
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
  private async waitIdle(threadId: string, waitSeconds: number, signal: AbortSignal) {
    const reviewer = await this.reviewerThread(threadId);
    if (!reviewer || reviewer.status === "error") return;
    await this.bb.sdk.threads
      .wait({ threadId, status: "idle", timeoutMs: waitSeconds * 1000, signal })
      .catch(async (error) => {
        if (signal.aborted) throw error;
        if (/timeout|timed out/i.test(error instanceof Error ? error.message : String(error)))
          return;
        const current = await this.reviewerThread(threadId);
        if (current?.status === "error" || !current) return;
        throw error;
      });
  }
  private async readResultEvents(threadId: string, afterSeq: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const events = [];
    for (;;) {
      const page = await this.bb.sdk.threads.events.list({
        threadId,
        types: [
          "client/turn/requested",
          "client/turn/rejected",
          "turn/input/accepted",
          "item/completed",
          "turn/completed",
          "provider/modelFallback",
          "provider/error",
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
  /** Reads one seat's bound turn; a deleted thread finishes without a report. */
  private async readSeat(run: ReviewRun, seat: Seat, signal: AbortSignal) {
    const threadId = seat.threadId!;
    if (!(await this.reviewerThread(threadId)))
      return { running: false, deleted: true, report: null, text: "", turnId: "" };
    const events = await this.readResultEvents(threadId, seat.afterSeq, signal);
    const { report, finished, text, turnId } = this.assessment(run, seat, events);
    const thread = await this.reviewerThread(threadId);
    return {
      running: !finished && Boolean(thread && active.has(thread.status)),
      deleted: false,
      report: report && Buffer.byteLength(JSON.stringify(report), "utf8") <= 220000 ? report : null,
      text,
      turnId,
    };
  }
  async result(caller: string, input: ResultRequest, signal: AbortSignal) {
    const authorized = await this.authorize(input.runId, caller);
    // Wait outside the parent's lock; settling is serialized with dispatch and usage fallback.
    if (input.waitSeconds)
      await Promise.all(
        authorized.seats.map(
          (seat) => seat.threadId && this.waitIdle(seat.threadId, input.waitSeconds, signal),
        ),
      );
    return this.serial(authorized.parentThreadId, () => this.settle(authorized.id, signal));
  }
  private async settle(id: string, signal: AbortSignal) {
    const run = this.stored(id)!;
    if (run.status === "starting") await this.recoverDispatch(run);
    if (run.seats.some((seat) => !seat.threadId))
      return {
        ...this.receipt(run, false),
        error: run.error ?? "Review dispatch has not completed",
      };
    for (const seat of run.seats)
      if (await this.queued(run, seat))
        return { ...this.receipt(run, false), status: "queued", deepImplementationCovered: false };
    const reads = await Promise.all(run.seats.map((seat) => this.readSeat(run, seat, signal)));
    if (reads.some((read) => read.running))
      return {
        ...this.receipt(run, false),
        status: "running",
        reviews: reads.map((read, index) => ({
          reviewer: identity(run.seats[index]!.reviewer),
          threadId: run.seats[index]!.threadId!,
          status: read.running ? ("running" as const) : ("finished" as const),
          fallback: fallbackNote(run.seats[index]!),
        })),
      };
    const reviews = reads.map((read, index) => this.review(run, run.seats[index]!, read));
    await this.storeReports(run, reviews);
    run.status = reviews.every((review) => review.status === "complete")
      ? "completed"
      : reviews.some((review) => review.report)
        ? "incomplete"
        : "failed";
    await this.save(run);
    const current = await this.currentCandidate(run, signal);
    const unfinished = reviews.filter((review) => review.status !== "complete").length;
    return {
      ...this.receipt(run, false),
      status: run.status === "completed" ? ("complete" as const) : ("incomplete" as const),
      current,
      deepImplementationCovered: this.clearsPublication(run, reviews, current),
      reviews,
      error: unfinished
        ? `${unfinished} of ${reviews.length} reviewers did not complete; see reviews[].error`
        : null,
    };
  }
  private review(
    run: ReviewRun,
    seat: Seat,
    { report, deleted, text, turnId }: Awaited<ReturnType<ReviewService["readSeat"]>>,
  ) {
    const diffCoverage = this.diffCoverage(run.id, readKey(run, seat.threadId!, turnId));
    const unread =
      run.request.kind === "implementation" &&
      run.request.mode === "deep" &&
      !diffCoverage.complete;
    let status: "complete" | "incomplete" | "failed" = "complete";
    let error: string | null = null;
    if (!report) {
      status = "failed";
      error = deleted
        ? "Reviewer thread was deleted; start a new assessment"
        : "No completed, uncontaminated response matched this run. It does not clear the candidate";
    } else if (report.status === "incomplete" || unread) {
      status = "incomplete";
      if (unread)
        error = "Deep assessment is incomplete: the reviewer did not read every pinned diff page";
    }
    return {
      reviewer: identity(seat.reviewer),
      threadId: seat.threadId!,
      status,
      diffCoverage,
      report,
      error,
      rawOutput: report ? undefined : text.slice(0, 4000),
      fallback: fallbackNote(seat),
    };
  }
  /** Publication clears only when every reviewer covered the current candidate without a blocker. */
  private clearsPublication(
    run: ReviewRun,
    reviews: { status: string; diffCoverage: { complete: boolean }; report: Report | null }[],
    current: boolean,
  ) {
    return (
      current &&
      run.request.kind === "implementation" &&
      run.request.mode === "deep" &&
      run.request.scope === "publication" &&
      reviews.every(
        (review) =>
          review.status === "complete" &&
          review.diffCoverage.complete &&
          review.report?.status === "complete" &&
          !review.report.findings.some(blocksPublication),
      )
    );
  }
}
