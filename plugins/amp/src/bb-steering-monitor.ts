import { basename } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const EVENT_PAGE_SIZE = 1_000;
const EVENT_WAIT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

interface BbThreadEvent {
  seq: number;
  scope?: unknown;
  type: string;
  data?: unknown;
}

interface PendingSteer {
  input: ContentBlock[];
  turnId: string;
}

export interface SteeringInputMonitor {
  run(
    onInput: (input: ContentBlock[]) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface BbSteeringMonitorOptions {
  serverUrl?: string;
  threadId?: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEvents(value: unknown): BbThreadEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event) => {
    if (
      !isRecord(event)
      || typeof event.seq !== "number"
      || !Number.isInteger(event.seq)
      || typeof event.type !== "string"
    ) {
      return [];
    }
    return [{
      seq: event.seq,
      scope: event.scope,
      type: event.type,
      data: event.data,
    }];
  });
}

function parseEvent(value: unknown): BbThreadEvent | null {
  return parseEvents([value])[0] ?? null;
}

function toContentBlock(value: unknown): ContentBlock | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "text":
      return typeof value.text === "string"
        ? { type: "text", text: value.text }
        : null;
    case "image":
      return typeof value.url === "string"
        ? { type: "text", text: `[image attachment: ${value.url}]` }
        : null;
    case "localImage":
      return typeof value.path === "string"
        ? { type: "text", text: `[image attachment on disk: ${value.path}]` }
        : null;
    case "localFile":
      return typeof value.path === "string"
        ? {
            type: "resource_link",
            uri: `file://${value.path}`,
            name: typeof value.name === "string" ? value.name : basename(value.path),
          }
        : null;
    default:
      return null;
  }
}

function parseInput(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const block = toContentBlock(item);
    return block === null ? [] : [block];
  });
}

function parseSteer(event: BbThreadEvent): [string, PendingSteer] | null {
  if (event.type !== "client/turn/requested" || !isRecord(event.data)) {
    return null;
  }
  const target = event.data.target;
  if (!isRecord(target)) return null;
  if (
    (target.kind !== "steer" && target.kind !== "auto")
    || typeof target.expectedTurnId !== "string"
    || typeof event.data.requestId !== "string"
  ) {
    return null;
  }

  const groups = event.data.inputGroups;
  const input = parseInput(event.data.input);
  if (Array.isArray(groups)) {
    input.length = 0;
    for (const [index, group] of groups.entries()) {
      if (index > 0) input.push({ type: "text", text: "\n\n" });
      input.push(...parseInput(group));
    }
  }
  return [event.data.requestId, { input, turnId: target.expectedTurnId }];
}

function parseAccepted(event: BbThreadEvent): { requestId: string; turnId: string } | null {
  if (event.type !== "turn/input/accepted" || !isRecord(event.data)) {
    return null;
  }
  if (
    typeof event.data.clientRequestId !== "string"
    || !isRecord(event.scope)
    || event.scope.kind !== "turn"
    || typeof event.scope.turnId !== "string"
  ) {
    return null;
  }
  return {
    requestId: event.data.clientRequestId,
    turnId: event.scope.turnId,
  };
}

function abortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await wait(ms, undefined, { signal });
  } catch (error) {
    if (!abortError(error, signal)) throw error;
  }
}

class BbSteeringMonitor implements SteeringInputMonitor {
  private readonly fetch: typeof fetch;
  private readonly eventsUrl: URL;
  private readonly waitUrl: URL;
  private cursor: number;

  constructor(args: {
    cursor: number;
    eventsUrl: URL;
    fetch: typeof fetch;
    waitUrl: URL;
  }) {
    this.cursor = args.cursor;
    this.eventsUrl = args.eventsUrl;
    this.fetch = args.fetch;
    this.waitUrl = args.waitUrl;
  }

  async run(
    onInput: (input: ContentBlock[]) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = new Map<string, PendingSteer>();
    let reportedFailure = false;
    while (!signal.aborted) {
      try {
        const accepted = await this.waitForAccepted(signal);
        if (accepted === null) continue;
        const events = await this.listThrough(accepted.seq, signal);
        for (const event of events) {
          const steer = parseSteer(event);
          if (steer !== null) pending.set(...steer);

          const acceptedInput = parseAccepted(event);
          if (acceptedInput === null) continue;
          const acceptedSteer = pending.get(acceptedInput.requestId);
          if (acceptedSteer === undefined) continue;
          pending.delete(acceptedInput.requestId);
          if (acceptedSteer.turnId !== acceptedInput.turnId) continue;
          onInput(acceptedSteer.input);
        }
        reportedFailure = false;
      } catch (error) {
        if (abortError(error, signal)) return;
        if (!reportedFailure) {
          reportedFailure = true;
          console.error("[amp] could not watch bb steering input; retrying", error);
        }
        await sleep(RETRY_DELAY_MS, signal);
      }
    }
  }

  private async listThrough(
    targetSeq: number,
    signal: AbortSignal,
  ): Promise<BbThreadEvent[]> {
    const collected: BbThreadEvent[] = [];
    while (this.cursor < targetSeq) {
      const url = new URL(this.eventsUrl);
      url.searchParams.set("afterSeq", String(this.cursor));
      url.searchParams.set("limit", String(EVENT_PAGE_SIZE));
      const events = parseEvents(await this.readJson(url, signal));
      if (events.length === 0) break;
      collected.push(...events);
      this.cursor = events.at(-1)?.seq ?? this.cursor;
    }
    return collected;
  }

  private async waitForAccepted(signal: AbortSignal): Promise<BbThreadEvent | null> {
    const url = new URL(this.waitUrl);
    url.searchParams.set("type", "turn/input/accepted");
    url.searchParams.set("waitMs", String(EVENT_WAIT_MS));
    url.searchParams.set("afterSeq", String(this.cursor));
    return parseEvent(await this.readJson(url, signal));
  }

  private async readJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetch(url, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`bb returned ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}

async function latestEventCursor(
  eventsUrl: URL,
  fetchFn: typeof fetch,
): Promise<number> {
  let cursor = 0;
  for (;;) {
    const url = new URL(eventsUrl);
    url.searchParams.set("afterSeq", String(cursor));
    url.searchParams.set("limit", String(EVENT_PAGE_SIZE));
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`bb returned ${response.status} ${response.statusText}`);
    }
    const events = parseEvents(await response.json());
    if (events.length === 0) return cursor;
    cursor = events.at(-1)?.seq ?? cursor;
    if (events.length < EVENT_PAGE_SIZE) return cursor;
  }
}

/**
 * bb queues ACP steering until the active session/prompt resolves. This monitor
 * observes only accepted steer requests from bb's thread log, which lets the
 * Amp bridge feed them into the active SDK multi-turn input stream first. Its
 * creation-time cursor makes every request from an earlier turn ineligible.
 */
export async function createBbSteeringMonitor(
  options: BbSteeringMonitorOptions = {},
): Promise<SteeringInputMonitor | null> {
  const serverUrl = options.serverUrl ?? process.env.BB_SERVER_URL;
  const threadId = options.threadId ?? process.env.BB_THREAD_ID;
  if (!serverUrl || !threadId) return null;

  const threadPath = `/api/v1/threads/${encodeURIComponent(threadId)}/events`;
  const eventsUrl = new URL(threadPath, serverUrl);
  const waitUrl = new URL(`${threadPath}/wait`, serverUrl);
  const fetchFn = options.fetch ?? fetch;
  const cursor = await latestEventCursor(eventsUrl, fetchFn);
  return new BbSteeringMonitor({
    cursor,
    eventsUrl,
    fetch: fetchFn,
    waitUrl,
  });
}
