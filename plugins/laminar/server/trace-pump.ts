import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  assembleTurnTrace,
  exportOtlpTrace,
  LaminarExportError,
  type ExportTraceServiceRequest,
  type ThreadEventRow,
  type TraceThread,
} from "./laminar.ts";
import type { LaminarConfig } from "../shared/settings.ts";

const ACTIVATION_KEY = "state:v1:activation";
const CHECKPOINT_PREFIX = "state:v1:thread:";
const EVENT_PAGE_SIZE = 200;
const THREAD_PAGE_SIZE = 100;

interface ActivationState {
  version: 1;
  activatedAtMs: number;
}

export interface ThreadCheckpoint {
  version: 1;
  cursor: number;
  historyRevision: number;
  skipOpenTurn: boolean;
}

interface WorkerState {
  dirty: boolean;
  rewriteCount: number;
  scheduled: boolean;
  running: boolean;
}

export type TraceExporter = (
  config: LaminarConfig,
  request: ExportTraceServiceRequest,
  signal: AbortSignal,
) => Promise<void>;

export interface TracePumpOptions {
  bb: BbPluginApi;
  getConfig: () => LaminarConfig | null;
  now?: () => number;
  exporter?: TraceExporter;
}

export function checkpointKey(threadId: string): string {
  return `${CHECKPOINT_PREFIX}${threadId}`;
}

function parseActivation(value: unknown): ActivationState | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("activatedAtMs" in value) ||
    typeof value.activatedAtMs !== "number" ||
    !Number.isFinite(value.activatedAtMs)
  ) {
    return null;
  }
  return { version: 1, activatedAtMs: value.activatedAtMs };
}

function parseCheckpoint(value: unknown): ThreadCheckpoint | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("cursor" in value) ||
    typeof value.cursor !== "number" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    !("historyRevision" in value) ||
    typeof value.historyRevision !== "number" ||
    !Number.isSafeInteger(value.historyRevision) ||
    value.historyRevision < 0 ||
    !("skipOpenTurn" in value) ||
    typeof value.skipOpenTurn !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    cursor: value.cursor,
    historyRevision: value.historyRevision,
    skipOpenTurn: value.skipOpenTurn,
  };
}

function threadIsRunning(status: string): boolean {
  return status !== "idle" && status !== "error";
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export class TracePump {
  private readonly bb: BbPluginApi;
  private readonly getConfig: () => LaminarConfig | null;
  private readonly now: () => number;
  private readonly exporter: TraceExporter;
  private readonly workers = new Map<string, WorkerState>();
  private readonly tasks = new Set<Promise<void>>();
  private activationPromise: Promise<ActivationState> | null = null;
  private reconcileDirty = false;
  private reconcileRewriteCount = 0;
  private reconcileScheduled = false;
  private reconcileRunning = false;
  private active = false;
  private signal: AbortSignal | null = null;

  constructor({ bb, getConfig, now = Date.now, exporter = exportOtlpTrace }: TracePumpOptions) {
    this.bb = bb;
    this.getConfig = getConfig;
    this.now = now;
    this.exporter = exporter;
  }

  configurationChanged(): void {
    this.requestReconcile();
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.active) throw new Error("the Laminar trace pump is already running");
    this.active = true;
    this.signal = signal;

    const unsubscribeThreads = this.bb.sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.id === undefined) {
          this.requestReconcile(event.changes.includes("history-rewritten") ? 1 : 0);
          return;
        }
        this.wakeThread(event.id, event.changes.includes("history-rewritten") ? 1 : 0);
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
      this.active = false;
      unsubscribeConnection();
      unsubscribeThreads();
      await Promise.allSettled(this.tasks);
      this.signal = null;
    }
  }

  private requestReconcile(rewriteCount = 0): void {
    this.reconcileDirty = true;
    this.reconcileRewriteCount += rewriteCount;
    if (!this.active || this.reconcileScheduled || this.reconcileRunning) return;
    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      if (!this.active || this.reconcileRunning) return;
      this.reconcileRunning = true;
      this.track(
        this.drainReconcile().finally(() => {
          this.reconcileRunning = false;
          if (this.reconcileDirty) this.requestReconcile();
        }),
      );
    });
  }

  private async drainReconcile(): Promise<void> {
    const signal = this.signal;
    if (signal === null) return;
    while (this.active && !signal.aborted && this.reconcileDirty) {
      this.reconcileDirty = false;
      const rewriteCount = this.reconcileRewriteCount;
      this.reconcileRewriteCount = 0;
      if (this.getConfig() === null) {
        this.reconcileRewriteCount += rewriteCount;
        return;
      }
      try {
        await this.ensureActivation();
        const threadIds = new Set(await this.discoverThreadIds(false, signal));
        for (const threadId of await this.discoverThreadIds(true, signal)) {
          threadIds.add(threadId);
        }
        await this.wakeDiscoveredThreads(threadIds, rewriteCount);
      } catch (error) {
        this.reconcileRewriteCount += rewriteCount;
        if (!isAbort(error, signal)) {
          this.bb.log.warn("Laminar thread discovery failed; it will retry after another wake.");
        }
        return;
      }
    }
  }

  private async discoverThreadIds(archived: boolean, signal: AbortSignal): Promise<string[]> {
    const threadIds: string[] = [];
    let offset = 0;
    while (!signal.aborted) {
      const page = await this.bb.sdk.threads.list({
        archived,
        includeHidden: true,
        limit: THREAD_PAGE_SIZE,
        offset,
        signal,
      });
      for (const thread of page) threadIds.push(thread.id);
      if (page.length < THREAD_PAGE_SIZE) return threadIds;
      offset += page.length;
    }
    return threadIds;
  }

  private async wakeDiscoveredThreads(
    threadIds: ReadonlySet<string>,
    rewriteCount: number,
  ): Promise<void> {
    if (rewriteCount === 0) {
      for (const threadId of threadIds) this.wakeThread(threadId, 0);
      return;
    }

    const wakes = await Promise.all(
      [...threadIds].map(async (threadId) => ({
        threadId,
        hasCheckpoint:
          parseCheckpoint(await this.bb.storage.kv.get<unknown>(checkpointKey(threadId))) !== null,
      })),
    );
    for (const wake of wakes) {
      this.wakeThread(wake.threadId, wake.hasCheckpoint ? rewriteCount : 0);
    }
  }

  private wakeThread(threadId: string, rewriteCount: number): void {
    const state = this.workers.get(threadId) ?? {
      dirty: false,
      rewriteCount: 0,
      scheduled: false,
      running: false,
    };
    state.dirty = true;
    state.rewriteCount += rewriteCount;
    this.workers.set(threadId, state);
    if (!this.active || state.scheduled || state.running) return;

    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      if (!this.active || state.running) return;
      state.running = true;
      this.track(
        this.drainThread(threadId, state).finally(() => {
          state.running = false;
          if (state.dirty || state.rewriteCount > 0) this.wakeThread(threadId, 0);
          else this.workers.delete(threadId);
        }),
      );
    });
  }

  private async drainThread(threadId: string, state: WorkerState): Promise<void> {
    const signal = this.signal;
    if (signal === null) return;
    while (this.active && !signal.aborted && (state.dirty || state.rewriteCount > 0)) {
      const rewriteCount = state.rewriteCount;
      state.dirty = false;
      state.rewriteCount = 0;
      const config = this.getConfig();
      if (config === null) return;
      try {
        if (rewriteCount > 0) await this.rebaseThread(threadId, rewriteCount, signal);
        else await this.exportCompletedTurns(threadId, signal);
      } catch (error) {
        if (!isAbort(error, signal)) {
          const reason =
            error instanceof LaminarExportError ? `HTTP ${error.status}` : "an internal error";
          this.bb.log.warn(
            `Laminar export for thread ${threadId} failed with ${reason}; checkpoint unchanged.`,
          );
        }
        return;
      }
    }
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async ensureActivation(): Promise<ActivationState> {
    if (this.activationPromise !== null) return this.activationPromise;
    const operation = (async () => {
      const stored = parseActivation(await this.bb.storage.kv.get<unknown>(ACTIVATION_KEY));
      if (stored !== null) return stored;
      const activated: ActivationState = { version: 1, activatedAtMs: this.now() };
      await this.bb.storage.kv.set(ACTIVATION_KEY, activated);
      return activated;
    })();
    this.activationPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.activationPromise === operation) this.activationPromise = null;
    }
  }

  private async ensureCheckpoint(
    threadId: string,
    signal: AbortSignal,
  ): Promise<{
    checkpoint: ThreadCheckpoint;
    thread: TraceThread & { createdAt: number; status: string };
  }> {
    const thread = await this.bb.sdk.threads.get({ threadId, signal });
    const stored = parseCheckpoint(await this.bb.storage.kv.get<unknown>(checkpointKey(threadId)));
    if (stored !== null) return { checkpoint: stored, thread };

    const activation = await this.ensureActivation();
    let checkpoint: ThreadCheckpoint;
    if (thread.createdAt < activation.activatedAtMs) {
      const head = await this.bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
        signal,
      });
      checkpoint = {
        version: 1,
        cursor: head[0]?.seq ?? 0,
        historyRevision: 0,
        skipOpenTurn: threadIsRunning(thread.status),
      };
    } else {
      checkpoint = { version: 1, cursor: 0, historyRevision: 0, skipOpenTurn: false };
    }
    await this.bb.storage.kv.set(checkpointKey(threadId), checkpoint);
    return { checkpoint, thread };
  }

  private async rebaseThread(
    threadId: string,
    rewriteCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { checkpoint, thread } = await this.ensureCheckpoint(threadId, signal);
    const head = await this.bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "1",
      signal,
    });
    await this.bb.storage.kv.set(checkpointKey(threadId), {
      version: 1,
      cursor: head[0]?.seq ?? 0,
      historyRevision: checkpoint.historyRevision + rewriteCount,
      skipOpenTurn: threadIsRunning(thread.status),
    } satisfies ThreadCheckpoint);
  }

  private async exportCompletedTurns(threadId: string, signal: AbortSignal): Promise<void> {
    const loaded = await this.ensureCheckpoint(threadId, signal);
    let checkpoint = loaded.checkpoint;
    const thread = loaded.thread;
    const pending: ThreadEventRow[] = [];
    let scanCursor = checkpoint.cursor;

    while (!signal.aborted) {
      const pageArgs: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0] = {
        threadId,
        order: "asc",
        limit: String(EVENT_PAGE_SIZE),
        signal,
      };
      if (scanCursor !== 0) pageArgs.afterSeq = String(scanCursor);
      const page = await this.bb.sdk.threads.events.list(pageArgs);
      if (page.length === 0) return;

      for (const event of page) {
        pending.push(event);
        if (event.type !== "turn/completed") continue;

        if (checkpoint.skipOpenTurn) {
          checkpoint = {
            version: 1,
            cursor: event.seq,
            historyRevision: checkpoint.historyRevision,
            skipOpenTurn: false,
          };
          await this.bb.storage.kv.set(checkpointKey(threadId), checkpoint);
          pending.length = 0;
          continue;
        }

        const config = this.getConfig();
        if (config === null) return;
        const request = assembleTurnTrace({
          contentMode: thread.visibility === "hidden" ? "metadata" : config.contentMode,
          deploymentEnvironment: config.deploymentEnvironment,
          events: pending,
          historyRevision: checkpoint.historyRevision,
          thread,
        });
        await this.exporter(config, request, signal);
        checkpoint = {
          version: 1,
          cursor: event.seq,
          historyRevision: checkpoint.historyRevision,
          skipOpenTurn: checkpoint.skipOpenTurn,
        };
        await this.bb.storage.kv.set(checkpointKey(threadId), checkpoint);
        pending.length = 0;
      }

      const nextCursor = page.at(-1)?.seq;
      if (nextCursor === undefined || nextCursor === scanCursor || page.length < EVENT_PAGE_SIZE) {
        return;
      }
      scanCursor = nextCursor;
    }
  }
}
