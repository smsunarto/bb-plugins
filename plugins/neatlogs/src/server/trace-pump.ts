import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { postTrace, type ExportOutcome, type TraceExporter } from "./neatlogs.ts";
import type { NeatlogsConfig } from "./settings.ts";
import {
  assembleTurnTrace,
  ZERO_USAGE,
  type ThreadEventRow,
  type TokenUsage,
  type TraceThread,
} from "./turn-trace.ts";

const ACTIVATION_KEY = "state:v1:activation";
const CHECKPOINT_PREFIX = "state:v1:thread:";
/** BB rejects larger event pages. */
const EVENT_PAGE_SIZE = 100;
const THREAD_PAGE_SIZE = 100;
const MAX_CONCURRENT_THREADS = 4;
const RETRY_DELAY_MS = 60_000;

/** The events a turn trace reads. Streaming deltas make up most of a thread and are skipped. */
const TRACE_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/backgroundTask/completed",
  "thread/tokenUsage/updated",
  "provider/modelFallback",
] as const satisfies readonly ThreadEventRow["type"][];

type SubscribeArgs = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type ThreadChange = Parameters<Extract<SubscribeArgs, { event: "thread:changed" }>["callback"]>[0];

/**
 * `cursor` is the seq of the last event settled for the thread. BB never
 * reuses a seq, even after a message edit deletes later events, so an
 * ascending scan from the cursor sees exactly the unsettled events.
 * `usage` is the cumulative usage report at the cursor, or null if unknown.
 */
export interface ThreadCheckpoint {
  version: 1;
  cursor: number;
  usage: TokenUsage | null;
}

export function checkpointKey(threadId: string): string {
  return `${CHECKPOINT_PREFIX}${threadId}`;
}

function parseCheckpoint(value: unknown): ThreadCheckpoint | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, cursor, usage } = value as Record<string, unknown>;
  if (version !== 1 || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
    return null;
  }
  const validUsage =
    typeof usage === "object" &&
    usage !== null &&
    typeof (usage as Record<string, unknown>).totalTokens === "number";
  return { version: 1, cursor, usage: validUsage ? (usage as TokenUsage) : null };
}

function parseActivation(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, activatedAtMs } = value as Record<string, unknown>;
  return version === 1 && typeof activatedAtMs === "number" && Number.isFinite(activatedAtMs)
    ? activatedAtMs
    : null;
}

/** A change that may have completed a turn. Without `eventTypes`, any append might. */
function mayCompleteTurn(change: ThreadChange): boolean {
  if (change.changes.includes("history-rewritten")) return true;
  if (!change.changes.includes("events-appended")) return false;
  const types = change.metadata?.eventTypes;
  return types === undefined || types.includes("turn/completed");
}

/** Run `load` on first use and share its promise afterwards. */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return () => (value ??= load());
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TracePumpOptions {
  bb: BbPluginApi;
  getConfig: () => NeatlogsConfig | null;
  exporter?: TraceExporter;
  now?: () => number;
  retryDelayMs?: number;
}

/**
 * Exports each completed BB turn to Neatlogs once, in order, per thread.
 *
 * A per-thread checkpoint in plugin KV advances only after Neatlogs accepts
 * (or permanently rejects) a turn, so restarts resume where they stopped.
 * History from before the plugin's first activation is never exported.
 *
 * Thread scheduling: a woken thread waits in `dirty` until a worker slot is
 * free, it has no pending retry, and Neatlogs has not refused the settings.
 */
export class TracePump {
  private readonly bb: BbPluginApi;
  private readonly getConfig: () => NeatlogsConfig | null;
  private readonly exporter: TraceExporter;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly dirty = new Set<string>();
  private readonly running = new Set<string>();
  /** Threads backing off after a transient failure; their timer wakes them. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tasks = new Set<Promise<void>>();
  /** Set when Neatlogs refused the key or URL; cleared by a settings change. */
  private refused = false;
  private activation: Promise<number> | null = null;
  private reconcileDirty = false;
  private reconcileRunning = false;
  private reconcileRetry: ReturnType<typeof setTimeout> | null = null;
  private signal: AbortSignal | null = null;

  constructor({
    bb,
    getConfig,
    exporter = postTrace,
    now = Date.now,
    retryDelayMs = RETRY_DELAY_MS,
  }: TracePumpOptions) {
    this.bb = bb;
    this.getConfig = getConfig;
    this.exporter = exporter;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
  }

  configurationChanged(): void {
    this.refused = false;
    this.requestReconcile();
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.signal !== null) throw new Error("the Neatlogs trace pump is already running");
    this.signal = signal;

    const unsubscribeThreads = this.bb.sdk.subscribe({
      event: "thread:changed",
      callback: (change) => {
        if (change.id === undefined) this.requestReconcile();
        else if (change.changes.includes("thread-deleted")) this.forgetThread(change.id);
        else if (mayCompleteTurn(change)) this.wakeThread(change.id);
      },
    });
    const unsubscribeConnection = this.bb.sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected" && event.reconnected) this.requestReconcile();
      },
    });

    this.requestReconcile();
    try {
      if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    } finally {
      unsubscribeConnection();
      unsubscribeThreads();
      for (const timer of this.retries.values()) clearTimeout(timer);
      this.retries.clear();
      if (this.reconcileRetry !== null) clearTimeout(this.reconcileRetry);
      this.reconcileRetry = null;
      await Promise.allSettled(this.tasks);
      this.dirty.clear();
      this.signal = null;
    }
  }

  private get live(): AbortSignal | null {
    return this.signal !== null && !this.signal.aborted ? this.signal : null;
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private requestReconcile(): void {
    this.reconcileDirty = true;
    if (this.reconcileRunning || this.live === null) return;
    this.reconcileRunning = true;
    this.track(
      (async () => {
        try {
          for (let signal = this.live; signal !== null && this.reconcileDirty; signal = this.live) {
            this.reconcileDirty = false;
            await this.reconcile(signal);
          }
        } finally {
          this.reconcileRunning = false;
        }
      })(),
    );
  }

  /** Wake every thread that changed since activation, to catch turns missed while unloaded. */
  private async reconcile(signal: AbortSignal): Promise<void> {
    if (this.getConfig() === null) return;
    try {
      const activatedAtMs = await this.activatedAt();
      for (const archived of [false, true]) {
        for (let offset = 0; ; offset += THREAD_PAGE_SIZE) {
          const page = await this.bb.sdk.threads.list({
            archived,
            includeHidden: true,
            limit: THREAD_PAGE_SIZE,
            offset,
            signal,
          });
          for (const thread of page) {
            if (thread.updatedAt >= activatedAtMs) this.wakeThread(thread.id);
          }
          if (page.length < THREAD_PAGE_SIZE) break;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      this.bb.log.warn(
        `Thread discovery failed (${describe(error)}); retrying in ${this.retryDelayMs / 1000}s.`,
      );
      this.reconcileRetry ??= setTimeout(() => {
        this.reconcileRetry = null;
        this.requestReconcile();
      }, this.retryDelayMs);
    }
  }

  private wakeThread(threadId: string): void {
    this.dirty.add(threadId);
    this.startWorkers();
  }

  private startWorkers(): void {
    const signal = this.live;
    if (signal === null || this.refused) return;
    for (const threadId of this.dirty) {
      if (this.running.size >= MAX_CONCURRENT_THREADS) return;
      if (this.running.has(threadId) || this.retries.has(threadId)) continue;
      this.dirty.delete(threadId);
      this.running.add(threadId);
      this.track(
        this.drainThread(threadId, signal).finally(() => {
          this.running.delete(threadId);
          this.startWorkers();
        }),
      );
    }
  }

  private retryLater(threadId: string): void {
    if (this.retries.has(threadId) || this.live === null) return;
    const timer = setTimeout(() => {
      this.retries.delete(threadId);
      this.wakeThread(threadId);
    }, this.retryDelayMs);
    this.retries.set(threadId, timer);
  }

  private forgetThread(threadId: string): void {
    this.dirty.delete(threadId);
    const timer = this.retries.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    this.retries.delete(threadId);
    void this.bb.storage.kv.delete(checkpointKey(threadId));
  }

  private async drainThread(threadId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.exportCompletedTurns(threadId, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.bb.log.warn(
        `Neatlogs export for thread ${threadId} failed (${describe(error)}); retrying in ${this.retryDelayMs / 1000}s.`,
      );
      this.retryLater(threadId);
    }
  }

  private async activatedAt(): Promise<number> {
    this.activation ??= (async () => {
      const stored = parseActivation(await this.bb.storage.kv.get<unknown>(ACTIVATION_KEY));
      if (stored !== null) return stored;
      const activatedAtMs = this.now();
      await this.bb.storage.kv.set(ACTIVATION_KEY, { version: 1, activatedAtMs });
      return activatedAtMs;
    })().catch((error: unknown) => {
      this.activation = null;
      throw error;
    });
    return this.activation;
  }

  private async saveCheckpoint(threadId: string, checkpoint: ThreadCheckpoint): Promise<void> {
    await this.bb.storage.kv.set(checkpointKey(threadId), checkpoint);
  }

  /** The newest trace event created before `beforeMs`, or null when there is none. */
  private async lastEventBefore(
    threadId: string,
    beforeMs: number,
    signal: AbortSignal,
  ): Promise<ThreadEventRow | null> {
    let beforeSeq: string | undefined;
    while (true) {
      const page = await this.bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: String(EVENT_PAGE_SIZE),
        types: TRACE_EVENT_TYPES,
        signal,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      const event = page.find((candidate) => candidate.createdAt < beforeMs);
      if (event !== undefined) return event;
      const oldest = page.at(-1);
      if (oldest === undefined || page.length < EVENT_PAGE_SIZE) return null;
      beforeSeq = String(oldest.seq);
    }
  }

  /**
   * The thread's checkpoint, created on first sight. A fresh thread starts at
   * its beginning. An older thread starts at its last pre-activation event,
   * and a fork at its last inherited event (BB copies the source's history
   * with the original timestamps), so neither re-exports old turns.
   */
  private async checkpointFor(threadId: string, signal: AbortSignal): Promise<ThreadCheckpoint> {
    const stored = parseCheckpoint(await this.bb.storage.kv.get<unknown>(checkpointKey(threadId)));
    if (stored !== null) return stored;
    const activatedAtMs = await this.activatedAt();
    const thread = await this.bb.sdk.threads.get({ threadId, signal });
    let checkpoint: ThreadCheckpoint = { version: 1, cursor: 0, usage: ZERO_USAGE };
    if (thread.createdAt < activatedAtMs || thread.sourceThreadId !== null) {
      const boundary = Math.max(activatedAtMs, thread.createdAt);
      const last = await this.lastEventBefore(threadId, boundary, signal);
      checkpoint = {
        version: 1,
        cursor: last?.seq ?? 0,
        usage: last === null ? ZERO_USAGE : await this.usageAt(threadId, last.seq, signal),
      };
    }
    await this.saveCheckpoint(threadId, checkpoint);
    return checkpoint;
  }

  /** The cumulative usage report at or before `seq`; none means no usage yet. */
  private async usageAt(threadId: string, seq: number, signal: AbortSignal): Promise<TokenUsage> {
    const [report] = await this.bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "1",
      types: ["thread/tokenUsage/updated"],
      beforeSeq: String(seq + 1),
      signal,
    });
    return report?.type === "thread/tokenUsage/updated" ? report.data.tokenUsage.total : ZERO_USAGE;
  }

  private async exportCompletedTurns(threadId: string, signal: AbortSignal): Promise<void> {
    let checkpoint: ThreadCheckpoint | null = await this.checkpointFor(threadId, signal);
    let scanCursor = checkpoint.cursor;
    const thread = lazy(() => this.bb.sdk.threads.get({ threadId, signal }));
    const pending: ThreadEventRow[] = [];

    while (!signal.aborted) {
      const page = await this.bb.sdk.threads.events.list({
        threadId,
        order: "asc",
        limit: String(EVENT_PAGE_SIZE),
        types: TRACE_EVENT_TYPES,
        signal,
        ...(scanCursor === 0 ? {} : { afterSeq: String(scanCursor) }),
      });

      for (const event of page) {
        pending.push(event);
        if (event.type !== "turn/completed") continue;
        checkpoint = await this.exportTurn(threadId, pending, checkpoint, thread, signal);
        if (checkpoint === null) return;
        pending.length = 0;
      }

      const last = page.at(-1);
      if (last === undefined || page.length < EVENT_PAGE_SIZE) return;
      scanCursor = last.seq;
    }
  }

  /**
   * Export the turn that ends `window` and save the checkpoint past it.
   * Null when the thread must stop draining with its checkpoint unchanged.
   */
  private async exportTurn(
    threadId: string,
    window: readonly ThreadEventRow[],
    checkpoint: ThreadCheckpoint,
    thread: () => Promise<TraceThread>,
    signal: AbortSignal,
  ): Promise<ThreadCheckpoint | null> {
    // Settings can change while a backlog drains; each turn uses the current ones.
    const config = this.getConfig();
    if (config === null || this.refused) return null;
    const { trace, usageTotal } = assembleTurnTrace({
      contentMode: config.contentMode,
      events: window,
      thread: await thread(),
      usageBaseline: checkpoint.usage,
    });
    if (trace !== null) {
      const outcome = await this.exporter(config, trace, signal);
      if (!this.settle(threadId, String(trace.metadata?.turnId), outcome)) return null;
    }
    const next: ThreadCheckpoint = {
      version: 1,
      cursor: window.at(-1)?.seq ?? checkpoint.cursor,
      usage: usageTotal,
    };
    await this.saveCheckpoint(threadId, next);
    return next;
  }

  /** Log one export outcome; true when the checkpoint may move past the turn. */
  private settle(threadId: string, turnId: string, outcome: ExportOutcome): boolean {
    const turn = `thread ${threadId} turn ${turnId}`;
    switch (outcome.kind) {
      case "exported":
        this.bb.log.info(
          `Exported ${turn} as Neatlogs trace ${outcome.traceId} (${outcome.spans} spans).`,
        );
        return true;
      case "rejected":
        this.bb.log.error(`Neatlogs rejected ${turn} with HTTP ${outcome.status}; skipping it.`);
        return true;
      case "refused": {
        const message = `Neatlogs refused the API key or ingest URL (HTTP ${outcome.status}). Fix the plugin settings; exports resume after they change.`;
        if (!this.refused) {
          this.bb.log.warn(message);
          this.bb.status.needsConfiguration(message);
        }
        this.refused = true;
        this.dirty.add(threadId);
        return false;
      }
      case "retry":
        this.bb.log.warn(
          `Neatlogs export of ${turn} failed (${outcome.reason}); retrying in ${this.retryDelayMs / 1000}s.`,
        );
        this.retryLater(threadId);
        return false;
    }
  }
}
