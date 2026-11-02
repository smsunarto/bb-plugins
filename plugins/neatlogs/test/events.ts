import type { ThreadEventRow, TraceThread } from "../src/server/turn-trace.ts";

type ItemType = Extract<ThreadEventRow, { type: "item/completed" }>["data"]["item"]["type"];

/** Event fixtures in the shapes BB records, filled with only the fields a trace reads. */
export class TurnEvents {
  readonly rows: ThreadEventRow[] = [];
  private seq: number;

  constructor(
    readonly threadId: string,
    startSeq = 0,
  ) {
    this.seq = startSeq;
  }

  private push(type: ThreadEventRow["type"], at: number, data: unknown, turnId: string | null) {
    this.seq += 1;
    this.rows.push({
      id: `${this.threadId}-event-${this.seq}`,
      seq: this.seq,
      threadId: this.threadId,
      createdAt: at,
      scope: turnId === null ? { kind: "thread" } : { kind: "turn", turnId },
      type,
      data,
    } as ThreadEventRow);
    return this;
  }

  request(at: number, text: string, model = "claude-opus-5-5[1m]") {
    return this.push(
      "client/turn/requested",
      at,
      {
        requestId: `request-${at}`,
        initiator: "user",
        source: "spawn",
        target: { kind: "thread-start" },
        execution: {
          model,
          serviceTier: "default",
          reasoningLevel: "high",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        input: [
          { type: "text", text, mentions: [] },
          {
            type: "text",
            text: "hidden agent instructions",
            visibility: "agent-only",
            mentions: [],
          },
        ],
      },
      null,
    );
  }

  started(turnId: string, at: number) {
    return this.push("turn/started", at, { providerThreadId: "provider-1" }, turnId);
  }

  item(
    turnId: string,
    from: number,
    to: number,
    item: { id: string; type: ItemType } & Record<string, unknown>,
  ) {
    this.push("item/started", from, { providerThreadId: "provider-1", item }, turnId);
    return this.push("item/completed", to, { providerThreadId: "provider-1", item }, turnId);
  }

  /** A usage report; `total` is cumulative for the thread, as BB records it. */
  usage(
    turnId: string,
    at: number,
    total: { input: number; cached: number; cacheRead: number; output: number; total: number },
  ) {
    const report = {
      inputTokens: total.input,
      cachedInputTokens: total.cached,
      cacheReadInputTokens: total.cacheRead,
      cacheWriteInputTokens: total.cached - total.cacheRead,
      outputTokens: total.output,
      reasoningOutputTokens: 0,
      totalTokens: total.total,
    };
    return this.push(
      "thread/tokenUsage/updated",
      at,
      { providerThreadId: "provider-1", tokenUsage: { last: report, total: report } },
      turnId,
    );
  }

  /** Delete every event after `seq`, as a message edit does; later seqs keep counting up. */
  truncateAfter(seq: number) {
    const index = this.rows.findIndex((row) => row.seq > seq);
    if (index >= 0) this.rows.splice(index);
    return this;
  }

  completed(turnId: string, at: number, status: "completed" | "failed" = "completed") {
    return this.push("turn/completed", at, { providerThreadId: "provider-1", status }, turnId);
  }
}

export function traceThread(overrides: Partial<TraceThread> = {}): TraceThread {
  return {
    id: "thread-1",
    environmentId: "environment-1",
    originPluginId: null,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "claude-code",
    sourceThreadId: null,
    title: "Fix the flaky test",
    visibility: "visible",
    ...overrides,
  };
}
