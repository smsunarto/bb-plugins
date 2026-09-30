import { THREAD_DELTA_NOTIFICATION_METHOD } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * Holds a Cloud thread's turn-end line so Devin's late final message still
 * lands inside the turn.
 *
 * `devin acp --cloud` answers `session/prompt` when Devin's status turns
 * "blocked", and Devin's final message races that answer by a few hundred
 * milliseconds either way. When the message loses, the SDK bridge has already
 * closed the turn and bb files the text as an unhandled provider event. The
 * settler sits on the bridge's stdout. For a thread launched with `--cloud`,
 * a completed turn's end waits up to `maxHoldMs`; a message that arrives
 * during the wait goes straight out, and the end follows `graceMs` later.
 * Other lines for that thread queue behind the end in their original order.
 * Any request from bb that names the thread releases it first, so the bridge
 * never handles a command ahead of the end it already produced. Every other
 * line, and every local thread, flows untouched.
 */
export type TurnSettlerOptions = Readonly<{
  write: (line: string) => void;
  maxHoldMs?: number;
  graceMs?: number;
  /** Schedules `fn` after `ms`; returns a cancel. Injected by tests. */
  schedule?: (ms: number, fn: () => void) => () => void;
}>;

export type TurnSettler = Readonly<{
  /** The bridge's outbound stdout line. */
  write(line: string): void;
  /** A line from bb, before the bridge handles it. */
  beforeInbound(line: string): void;
  /** Releases every held line now. */
  flush(): void;
}>;

export const DEFAULT_MAX_HOLD_MS = 1500;
export const DEFAULT_GRACE_MS = 100;

/** The `devin acp` flag that relays the session to a Devin Cloud VM. */
const CLOUD_FLAG = "--cloud";

type Held = { queue: string[]; cancel: () => void };

type Message = Record<string, unknown>;

type DeltaLine = Readonly<{ threadId: string; agentText: boolean; completedTurn: boolean }>;

function asRecord(value: unknown): Message | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Message)
    : null;
}

function parseMessage(line: string): Message | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function threadIdOf(message: Message): string | null {
  const threadId = asRecord(message["params"])?.["threadId"];
  return typeof threadId === "string" ? threadId : null;
}

/** `options.providerOptions.acpLaunchSpec.args` of a request, when it has one. */
function launchArgsOf(message: Message): unknown[] | null {
  const options = asRecord(asRecord(message["params"])?.["options"]);
  const launch = asRecord(asRecord(options?.["providerOptions"])?.["acpLaunchSpec"]);
  const args = launch?.["args"];
  return Array.isArray(args) ? args : null;
}

function classifyDeltaLine(line: string): DeltaLine | null {
  if (!line.includes(THREAD_DELTA_NOTIFICATION_METHOD)) return null;
  const message = parseMessage(line);
  if (message === null || message["method"] !== THREAD_DELTA_NOTIFICATION_METHOD) return null;
  const threadId = threadIdOf(message);
  const deltas = asRecord(message["params"])?.["deltas"];
  if (threadId === null || !Array.isArray(deltas)) return null;
  let agentText = false;
  let completedTurn = false;
  for (const entry of deltas) {
    const delta = asRecord(entry);
    if (delta?.["kind"] === "item.textDelta" && delta["channel"] === "agentMessage")
      agentText = true;
    if (delta?.["kind"] === "turn.boundary" && delta["status"] === "completed")
      completedTurn = true;
  }
  return { threadId, agentText, completedTurn };
}

export function createTurnSettler(options: TurnSettlerOptions): TurnSettler {
  const {
    write,
    maxHoldMs = DEFAULT_MAX_HOLD_MS,
    graceMs = DEFAULT_GRACE_MS,
    schedule = (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  } = options;
  const cloudThreads = new Set<string>();
  const held = new Map<string, Held>();

  function release(threadId: string): void {
    const entry = held.get(threadId);
    if (entry === undefined) return;
    held.delete(threadId);
    entry.cancel();
    for (const line of entry.queue) write(line);
  }

  return {
    write(line) {
      const delta = classifyDeltaLine(line);
      if (delta === null) {
        write(line);
        return;
      }
      const entry = held.get(delta.threadId);
      if (entry !== undefined) {
        if (!delta.agentText) {
          entry.queue.push(line);
          return;
        }
        write(line);
        entry.cancel();
        entry.cancel = schedule(graceMs, () => release(delta.threadId));
        return;
      }
      if (delta.completedTurn && cloudThreads.has(delta.threadId)) {
        held.set(delta.threadId, {
          queue: [line],
          cancel: schedule(maxHoldMs, () => release(delta.threadId)),
        });
        return;
      }
      write(line);
    },
    beforeInbound(line) {
      const message = parseMessage(line);
      if (message === null || typeof message["method"] !== "string") return;
      const threadId = threadIdOf(message);
      if (threadId === null) return;
      const launchArgs = launchArgsOf(message);
      if (launchArgs !== null) {
        if (launchArgs.includes(CLOUD_FLAG)) cloudThreads.add(threadId);
        else cloudThreads.delete(threadId);
      }
      release(threadId);
    },
    flush() {
      for (const threadId of held.keys()) release(threadId);
    },
  };
}
