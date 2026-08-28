/**
 * `src/bridge/conversation.ts` — the Amp process supervisor.
 *
 * Owns everything that talks to the Amp SDK's `execute()`: the multi-turn
 * stdin stream, the spawn option bag, the unsupported-flag drop-and-retry,
 * and the Orb variant. Emits parsed `AmpEventBatch`es and nothing else; turn
 * settlement, timelines, and ACP/native vocabulary stay in the callers.
 *
 * Extracted from `bridge-core.ts` (U3). The behavior contract is
 * `test/bridge-core.test.ts` passing unedited against this extraction.
 */
import {
  createUserMessage,
  type AmpOptions,
  type MCPConfig,
  type UserInputMessage,
} from "@ampcode/sdk";
import { AMP_CLI_SHIM_FAST_ENV } from "../amp-cli-shim.ts";
import { parseAmpBatch, parseUnsupportedFlag, type AmpEventBatch } from "./events.ts";
import { toAmpPermissions } from "./options.ts";

/** Keep the injected seam testable while deriving its option contract from
 * the exact @ampcode/sdk version this plugin pins. */
export type AmpExecuteOptions = AmpOptions;

/** Amp's stream-JSON input accepts `steer`, but the pinned SDK's public type
 * does not expose it yet. A steered message runs at Amp's next interruption
 * point instead of waiting for the current agent turn to finish. */
export type AmpUserInputMessage = UserInputMessage & { steer?: true };

export type AmpExecutePrompt = string | AsyncIterable<AmpUserInputMessage>;

export type AmpExecuteFn = (args: {
  prompt: AmpExecutePrompt;
  signal?: AbortSignal;
  options?: AmpExecuteOptions;
}) => AsyncIterable<unknown>;

/**
 * Amp CLI flags the SDK may emit, mapped back to the execute() option that
 * produces them. An Amp CLI older than the SDK rejects unknown flags at argv
 * parse time ("error: unknown option '--effort'"), which would otherwise fail
 * every turn; the supervisor drops the offending option and retries instead.
 */
const FLAG_TO_OPTION: Record<string, keyof AmpExecuteOptions> = {
  effort: "effort",
  label: "labels",
  "mcp-config": "mcpConfig",
  mode: "mode",
  "settings-file": "dangerouslyAllowAll",
  "stream-json-thinking": "thinking",
  "no-archive-after-execute": "noArchiveAfterExecute",
  "dangerously-allow-all": "dangerouslyAllowAll",
};

/** Option name behind an "unknown option --x" CLI error, if we know one. */
export function unsupportedOptionFrom(message: string): keyof AmpExecuteOptions | null {
  const flag = parseUnsupportedFlag(message);
  if (flag === null) return null;
  return FLAG_TO_OPTION[flag] ?? null;
}

/** Options this Amp CLI rejected; dropped from every later spawn. Shared
 * process-lifetime across conversations, so one probe covers all sessions
 * (the drop set was agent-lifetime in bridge-core and the retry tests pin
 * that). */
export interface RetryState {
  readonly droppedOptions: ReadonlySet<keyof AmpExecuteOptions>;
  /** CLI flags already probed, for observability. */
  readonly attemptedFlags: ReadonlySet<string>;
}

export interface MutableRetryState extends RetryState {
  drop(option: keyof AmpExecuteOptions, flag: string): void;
}

export function createRetryState(): MutableRetryState {
  const droppedOptions = new Set<keyof AmpExecuteOptions>();
  const attemptedFlags = new Set<string>();
  return {
    droppedOptions,
    attemptedFlags,
    drop(option, flag) {
      droppedOptions.add(option);
      attemptedFlags.add(flag);
    },
  };
}

/**
 * Spawn-relevant session controls, snapshotted when a conversation starts.
 * Two prompts with equal shapes can share one Amp process; any difference
 * forces a fresh spawn, because execute options are process-wide.
 */
export interface SessionShape {
  readonly cwd: string;
  readonly mode: "low" | "medium" | "high" | "ultra";
  readonly dangerouslyAllowAll: boolean;
  readonly fast: boolean;
  readonly denied: readonly string[];
  readonly mcpConfigDigest: string;
}

/**
 * Structural equality; `denied` compares as a set.
 *
 * `fast` is excluded. Amp's CLI can only apply `--fast` while it creates the
 * thread, so the field records a spawn-time decision rather than a control
 * the user can change later: it is true on the first execution of a Fast
 * thread and false from the turn the Amp thread id lands. Comparing it would
 * read that flip as a configuration change and respawn a warm CLI that is
 * already running the right thread.
 */
export function shapesEqual(a: SessionShape, b: SessionShape): boolean {
  if (
    a.cwd !== b.cwd ||
    a.mode !== b.mode ||
    a.dangerouslyAllowAll !== b.dangerouslyAllowAll ||
    a.mcpConfigDigest !== b.mcpConfigDigest
  ) {
    return false;
  }
  const aDenied = new Set(a.denied);
  const bDenied = new Set(b.denied);
  if (aDenied.size !== bDenied.size) return false;
  for (const tool of aDenied) {
    if (!bDenied.has(tool)) return false;
  }
  return true;
}

interface QueuedInput {
  message: AmpUserInputMessage;
  settled: boolean;
  resolve: () => void;
  reject: (reason: Error) => void;
}

function deliver(entry: QueuedInput): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.resolve();
}

function discard(entry: QueuedInput, reason: Error): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.reject(reason);
}

function closedError(): Error {
  return new Error("Amp conversation input closed before the message was delivered");
}

/**
 * Multi-turn stdin for one Amp process. Two retained queues:
 * - `pending`: pushed, not yet handed to the SDK's input generator;
 * - `provisional`: handed to a startup attempt that has produced no output
 *   yet, so an unsupported-flag retry can `replay()` it.
 * Once the process produces output (`commit()`), handed-off input resolves
 * its `delivered` promise at handoff and is not retained.
 */
export class MultiTurnPrompt {
  private readonly pending: QueuedInput[] = [];
  private readonly provisional: QueuedInput[] = [];
  private readonly waiters = new Set<() => void>();
  private committed = false;
  private closedFlag = false;
  private closeReason: Error | null = null;

  get closed(): boolean {
    return this.closedFlag;
  }

  get hasUndelivered(): boolean {
    return this.pending.length + this.provisional.length > 0;
  }

  /** Queue one user message. `delivered` resolves when the Amp process
   * consumed it and rejects when the stream closes first — callers that do
   * not care must attach a catch. */
  push(text: string, opts?: { steer?: boolean }): { delivered: Promise<void> } {
    if (this.closedFlag) {
      return { delivered: Promise.reject(this.closeReason ?? closedError()) };
    }
    const message = createUserMessage(text) as AmpUserInputMessage;
    const entry: QueuedInput = {
      message: opts?.steer === true ? { ...message, steer: true } : message,
      settled: false,
      resolve: () => {},
      reject: () => {},
    };
    const delivered = new Promise<void>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pending.push(entry);
    this.wake();
    return { delivered };
  }

  /** Once Amp emits output, startup succeeded and no option retry can replay
   * accepted input. Everything handed to the stream so far is delivered. */
  commit(): void {
    if (this.committed) return;
    this.committed = true;
    for (const entry of this.provisional.splice(0)) deliver(entry);
  }

  /** A failed startup attempt hands its provisional input back for the next
   * attempt, oldest first. No-op after `commit()`. */
  replay(): void {
    if (this.committed) return;
    this.pending.unshift(...this.provisional.splice(0));
  }

  close(reason?: Error): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.closeReason = reason ?? closedError();
    for (const entry of [...this.provisional.splice(0), ...this.pending.splice(0)]) {
      discard(entry, this.closeReason);
    }
    this.wake();
  }

  /** One generator per spawn attempt; `signal` is that attempt's own scope. */
  async *stream(signal: AbortSignal): AsyncGenerator<AmpUserInputMessage> {
    while (!signal.aborted) {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;
        // Move (or settle) before yielding: if the attempt dies while the
        // generator is suspended here, the entry must already be replayable.
        if (this.committed) deliver(entry);
        else this.provisional.push(entry);
        yield entry.message;
      }
      if (this.closedFlag) return;
      await this.wait(signal);
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || this.closedFlag || this.pending.length > 0) return resolve();
      const finish = () => {
        this.waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }
}

export interface AmpConversationDeps {
  execute: AmpExecuteFn;
  /** Absolute amp-cli-shim path merged into the child env as AMP_CLI_PATH,
   * or null when the ambient process env already carries it (the ACP host
   * wires it through process.env in bridge.ts). */
  ampCliPath: string | null;
  /** Base child env; the fast-mode marker is layered on top. */
  env: Readonly<Record<string, string>>;
  retry: MutableRetryState;
}

export interface AmpConversationArgs {
  shape: SessionShape;
  /** Amp thread id to continue, or null for a fresh thread. */
  continueFrom: string | null;
  /** Full MCP config for the spawn. The shape's digest gates reuse but
   * cannot spawn a process, so the record itself rides here. Omitted from
   * the option bag when null or empty. */
  mcpConfig: MCPConfig | null;
  /** Extra Amp thread labels, e.g. the ACP bridge's via-amp-acp marker. */
  labels: readonly string[] | null;
  deps: AmpConversationDeps;
}

export interface AmpConversation {
  /** Queue one user message. Resolves when the Amp process consumed it,
   * rejects when the conversation closes first — callers that do not care
   * must attach a catch. */
  send(text: string, opts?: { steer?: boolean }): Promise<void>;
  /** The parsed output stream. Single-consumer: one long-lived iteration
   * per conversation; startup retries are invisible inside it. */
  batches(): AsyncIterable<AmpEventBatch>;
  readonly ampThreadId: string | null;
  /** True once the process produced output (startup retries exhausted). */
  readonly committed: boolean;
  /** True once no further input can be sent (closeInput or abort). */
  readonly closed: boolean;
  /** True after abort(); lets callers tell teardown from Amp ending on its
   * own. */
  readonly aborted: boolean;
  /** End the input stream without aborting the SDK execution. */
  closeInput(): void;
  /** Close input and abort the SDK execution. */
  abort(reason: "interrupt" | "release" | "restart"): void;
}

/**
 * One persistent Local execution. Lazy: `execute()` is not called until the
 * first `send()`, and never if the conversation closes unsent.
 */
export function createAmpConversation(args: AmpConversationArgs): AmpConversation {
  const { shape, continueFrom, mcpConfig, labels, deps } = args;
  const input = new MultiTurnPrompt();
  const controller = new AbortController();
  let started = false;
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let ampThreadId: string | null = null;
  let committed = false;
  let aborted = false;

  const buildOptions = (): AmpExecuteOptions => {
    const options: AmpExecuteOptions = {
      cwd: shape.cwd,
      mode: shape.mode,
      thinking: true,
      noArchiveAfterExecute: true,
      env: {
        ...deps.env,
        ...(deps.ampCliPath === null ? {} : { AMP_CLI_PATH: deps.ampCliPath }),
        ...(shape.fast && continueFrom === null ? { [AMP_CLI_SHIM_FAST_ENV]: "1" } : {}),
      },
      // Always override the persisted Amp setting: an explicit false turns
      // off a user-level amp.dangerouslyAllowAll=true.
      dangerouslyAllowAll: shape.dangerouslyAllowAll,
    };
    if (labels !== null) options.labels = [...labels];
    if (mcpConfig !== null && Object.keys(mcpConfig).length > 0) options.mcpConfig = mcpConfig;
    if (shape.denied.length > 0) options.permissions = toAmpPermissions(shape.denied);
    if (continueFrom !== null) options.continue = continueFrom;
    for (const key of deps.retry.droppedOptions) delete options[key];
    return options;
  };

  const output = (async function* (): AsyncGenerator<AmpEventBatch> {
    await startGate;
    // Released by closeInput/abort before any send: never spawn for nothing.
    if (!started) return;
    for (let attempt = 0; ; attempt += 1) {
      let streamed = false;
      const attemptInput = new AbortController();
      try {
        const stream = deps.execute({
          prompt: input.stream(attemptInput.signal),
          signal: controller.signal,
          options: buildOptions(),
        });
        for await (const message of stream) {
          streamed = true;
          committed = true;
          input.commit();
          const batch = parseAmpBatch(message);
          if (ampThreadId === null && batch.ampThreadId !== null) ampThreadId = batch.ampThreadId;
          yield batch;
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const flag = parseUnsupportedFlag(message);
        const unsupported = flag === null ? null : (FLAG_TO_OPTION[flag] ?? null);
        if (
          flag !== null &&
          unsupported !== null &&
          !streamed &&
          attempt === 0 &&
          !controller.signal.aborted &&
          !deps.retry.droppedOptions.has(unsupported)
        ) {
          deps.retry.drop(unsupported, flag);
          console.error(
            `[amp] this Amp CLI rejects the flag generated by ${String(unsupported)}; dropping it and retrying. ` +
              "Update the Amp CLI to use that control.",
          );
          input.replay();
          continue;
        }
        throw error;
      } finally {
        attemptInput.abort();
      }
    }
  })();

  return {
    send(text, opts) {
      const accepting = !input.closed;
      const { delivered } = input.push(text, opts);
      if (accepting && !started) {
        started = true;
        releaseStart();
      }
      return delivered;
    },
    batches: () => output,
    get ampThreadId() {
      return ampThreadId;
    },
    get committed() {
      return committed;
    },
    get closed() {
      return input.closed;
    },
    get aborted() {
      return aborted;
    },
    closeInput() {
      input.close();
      releaseStart();
    },
    abort(reason) {
      aborted = true;
      input.close(new Error(`Amp conversation aborted (${reason})`));
      controller.abort();
      releaseStart();
    },
  };
}

export interface OrbRunArgs {
  prompt: string;
  /** Amp project for a NEW Orb thread; a continued thread already owns its
   * repository selection, so the two controls never travel together. */
  project: string | null;
  continueFrom: string | null;
  shape: SessionShape;
  labels: readonly string[] | null;
  deps: AmpConversationDeps;
}

export interface OrbRun {
  batches(): AsyncIterable<AmpEventBatch>;
  abort(): void;
}

/**
 * One Orb execution. Orb ignores the Local-only shape controls
 * (dangerouslyAllowAll, fast, denied, mcpConfigDigest): permissions and MCP
 * selection live in the Amp project configuration.
 */
export function runOrb(args: OrbRunArgs): OrbRun {
  const { prompt, project, continueFrom, shape, labels, deps } = args;
  const controller = new AbortController();

  const buildOptions = (): AmpExecuteOptions => {
    const options: AmpExecuteOptions = {
      cwd: shape.cwd,
      mode: shape.mode,
      thinking: true,
      noArchiveAfterExecute: true,
      env: {
        ...deps.env,
        ...(deps.ampCliPath === null ? {} : { AMP_CLI_PATH: deps.ampCliPath }),
      },
      executor: "orb",
    };
    if (labels !== null) options.labels = [...labels];
    if (continueFrom === null && project !== null) options.project = project;
    if (continueFrom !== null) options.continue = continueFrom;
    for (const key of deps.retry.droppedOptions) delete options[key];
    return options;
  };

  const output = (async function* (): AsyncGenerator<AmpEventBatch> {
    // Two attempts at most: the retry only fires when an older Amp CLI
    // rejects an option before streaming anything, so no output duplicates.
    for (let attempt = 0; ; attempt += 1) {
      let streamed = false;
      try {
        const stream = deps.execute({
          prompt,
          signal: controller.signal,
          options: buildOptions(),
        });
        for await (const message of stream) {
          streamed = true;
          yield parseAmpBatch(message);
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const flag = parseUnsupportedFlag(message);
        const unsupported = flag === null ? null : (FLAG_TO_OPTION[flag] ?? null);
        if (
          flag !== null &&
          unsupported !== null &&
          !streamed &&
          attempt === 0 &&
          !controller.signal.aborted &&
          !deps.retry.droppedOptions.has(unsupported)
        ) {
          deps.retry.drop(unsupported, flag);
          console.error(
            `[amp] this Amp CLI rejects the flag generated by ${String(unsupported)}; dropping it and retrying. ` +
              "Update the Amp CLI to use that control.",
          );
          continue;
        }
        throw error;
      }
    }
  })();

  return {
    batches: () => output,
    abort: () => controller.abort(),
  };
}
