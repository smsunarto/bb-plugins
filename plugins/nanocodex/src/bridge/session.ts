/**
 * `src/bridge/session.ts` — one bb thread's turn pump.
 *
 * THREE inbound paths carry work: the `input` embedded in `thread/start`,
 * `turn/start`, and `turn/steer`. All three do the same two things — enqueue,
 * then pump — and that is the whole design:
 *
 *   enqueue(input, clientRequestId?)   append to the pending queue
 *   pump()                             while the queue is non-empty and no
 *                                      child runs: drain the WHOLE queue into
 *                                      one turn and run it
 *
 * Consequences that fall out rather than being arranged:
 *
 *  - Turns are serial per thread. Two `nanocodex run` children in the same cwd
 *    would race on the filesystem and interleave in the ledger; the pump makes
 *    that unrepresentable rather than guarded.
 *  - Steering is real. `steerMode: "queue"` is exactly this: the steer text is
 *    held to the next prompt boundary. The runtime sends `turn/steer` whatever
 *    the declared mode, and the alternative (echo's blanket NO_ACTIVE_TURN)
 *    silently discards what the user typed.
 *  - Three steers during one long turn cost ONE follow-on run, not three.
 *    Coalescing matters here in a way it would not for a resumable CLI: every
 *    `nanocodex run` pays ~9.7k warmup tokens before it reads a word of the
 *    prompt, so three runs would burn ~30k tokens to say what one says.
 *    Coalescing is only possible because this bridge composes the prompt.
 *  - Every queued `clientRequestId` settles on the boundary of the turn that
 *    drained it. The runtime assembler drains all pending acceptances into the
 *    turn it opens (verified in delta-assembler.ts), so several acceptances on
 *    one turn are the supported shape, not a workaround.
 *
 * The queue is IN MEMORY and dies with the bridge. It is unsettled input, not
 * history; persisting it would resurrect requests whose `clientRequestId` the
 * runtime has long since given up on.
 */

import {
  isStandaloneBuiltinCompactCommand,
  type BridgeExecutionOptions,
  type ClientTurnRequestId,
  type PromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { LedgerTurn, ThreadContinuity } from "./continuity.ts";
import { flattenPromptInput } from "./prompt.ts";
import { createTurnProjector } from "./project.ts";
import { RETRYABLE_EXIT_CODE, startRun, toRunSpec, type RunHandle, type RunOutcome } from "./run.ts";
import type { ThreadWriter, TurnScribe } from "./timeline.ts";

/** One pending submission. `clientRequestId` is null only for the input embedded in `thread/start`, which carries none. */
export interface QueuedInput {
  readonly input: readonly PromptInput[];
  readonly clientRequestId: ClientTurnRequestId | null;
  readonly options: BridgeExecutionOptions;
}

export interface NanocodexSession {
  readonly threadId: string;
  readonly providerThreadId: string;

  /**
   * Accept work. Returns once the input is queued, NOT once the turn is done —
   * `entry.ts` has already answered the JSON-RPC request by the time this runs,
   * because the result acknowledges acceptance and the turn settles through
   * `turn.boundary`.
   */
  submit(queued: QueuedInput): void;

  /**
   * A steer. Same queue, same pump. Throws `NoActiveTurnError` only when this
   * session is gone; a steer that lands just after its turn settled is still
   * honored, as the next turn, because dropping the user's words to satisfy a
   * race is the worse answer.
   */
  steer(queued: QueuedInput & { expectedTurnId: string }): void;

  /**
   * `intent: "interrupt"` — SIGINT the child, wait for its own
   * `run.completed {status:"cancelled"}`, escalate to SIGKILL after the grace
   * window, and settle the turn either way. Resolves only AFTER the interrupted
   * boundary is flushed to the wire, which is what puts it before the
   * `thread/stop` result (rule `stop/interrupt-settles-before-result`). Pending
   * queued inputs are drained into that same turn so their ids settle with it.
   *
   * `intent: "release"` — SIGKILL, drop the session, emit NOTHING. A release
   * that fabricates an interrupted boundary is the bug rule
   * `stop/release-not-interrupted` exists to catch.
   */
  stop(intent: "interrupt" | "release"): Promise<void>;

  /** `thread/discard`: stop, then delete the ledger. Idempotent. */
  discard(): Promise<void>;

  /** Silent teardown for SIGTERM: kill the child, write nothing, emit nothing. */
  close(): void;
}

export class NoActiveTurnError extends Error {}

export interface SessionArgs {
  readonly threadId: string;
  readonly cwd: string;
  readonly writer: ThreadWriter;
  readonly continuity: ThreadContinuity;
  /** Resolved once at session open from `providerOptions` plus the test override. */
  readonly launch: { command: string; argsPrefix: readonly string[] };
  readonly instructionMode: "append" | "replace";
  readonly budgetBytes: number;
  readonly features: { subagents: boolean; webSearch: boolean; imageGeneration: boolean; mcpDefaults: boolean };
  /**
   * True when the caller resumed a thread that should have history. An empty
   * ledger then earns one `provider.warning` on the first turn instead of an
   * error, because `thread/resume` is total. (Deviation from the sketch's
   * eight-field args: `entry.ts` knows which verb opened the session and the
   * warning belongs to that knowledge.)
   */
  readonly expectHistory: boolean;
}

/**
 * Create a session. Cheap and synchronous: no child, no probe, no handshake.
 * A nanocodex "session" between turns is a file, so opening one is a fold.
 */
export function createNanocodexSession(args: SessionArgs): NanocodexSession {
  const { threadId, cwd, writer, continuity, launch, instructionMode, budgetBytes, features } = args;

  const queue: QueuedInput[] = [];
  let running = false;
  let released = false;
  let interruptRequested = false;
  let warnedAboutElision = false;
  let warnAboutMissingHistory = args.expectHistory && continuity.peek().turns.length === 0 && continuity.peek().baseSummary === null;

  let activeScribe: TurnScribe | null = null;
  let activeHandle: RunHandle | null = null;
  let activeTurn: Promise<void> | null = null;

  const pump = (): void => {
    if (running || released || queue.length === 0) return;
    const drained = queue.splice(0, queue.length);
    running = true;
    activeTurn = runTurn(drained)
      .catch(() => {})
      .finally(() => {
        running = false;
        interruptRequested = false;
        activeScribe = null;
        activeHandle = null;
        activeTurn = null;
        pump();
      });
  };

  const runTurn = async (drained: QueuedInput[]): Promise<void> => {
    const ordinal = continuity.nextOrdinal;
    const clientRequestIds = drained
      .map((queued) => queued.clientRequestId)
      .filter((id): id is ClientTurnRequestId => id !== null);
    const scribe = writer.scribe({ ordinal, clientRequestIds });
    activeScribe = scribe;

    const options = drained[drained.length - 1]!.options;
    const input = drained.flatMap((queued) => queued.input);
    const compaction = isCompactionRequest(input);
    const promptInput: readonly PromptInput[] = compaction
      ? [{ type: "text", text: COMPACTION_REQUEST_TEXT, mentions: [] }]
      : input;
    const userText = flattenPromptInput(promptInput);

    const composed = continuity.composePrompt({
      input: promptInput,
      instructions: options.instructions ?? null,
      instructionMode,
      budgetBytes,
    });
    if (warnAboutMissingHistory) {
      warnAboutMissingHistory = false;
      scribe.warn({
        summary: "Resumed without history: the nanocodex continuity ledger for this thread is missing or empty.",
        details: "The thread continues from here; earlier turns are not in the prompt.",
      });
    }
    if (composed.elidedTurns > 0 && !warnedAboutElision) {
      warnedAboutElision = true;
      scribe.warn({
        summary: `History no longer fits the prompt budget: ${composed.elidedTurns} old turn(s) are summarized or elided.`,
        details: "Use /compact to fold the history into a summary nanocodex writes itself.",
      });
    }

    continuity.beginTurn({ ordinal, userText });
    const projector = createTurnProjector({
      scribe,
      ordinal,
      userText,
      promptBytes: composed.bytes,
      clientRequestIds,
      addUsage: (last, promptTokens) => writer.addUsage(last, promptTokens),
      raw: (payload) => writer.raw(payload, "unknown"),
    });

    let record: LedgerTurn | null = null;
    try {
      const handle = startRun({
        spec: toRunSpec({
          options,
          cwd,
          prompt: composed.text,
          instructions: composed.instructionsFlag,
          launch,
          features,
        }),
        threadId,
        onEvent: (envelope) => {
          try {
            projector.consume(envelope);
          } catch (error) {
            scribe.warn({
              summary: "One nanocodex event could not be projected and was skipped.",
              details: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      activeHandle = handle;

      const outcome = await handle.done;
      switch (outcome.kind) {
        case "terminal":
          break;
        case "no-terminal":
          if (!interruptRequested) {
            scribe.fail({ message: describeExit(outcome), settlesTurn: true });
          }
          break;
        case "spawn-failed":
          scribe.fail({ message: outcome.message, settlesTurn: true });
          writer.recovery({
            kind: "restartRecommended",
            retryable: false,
            message: `${outcome.message}. Check the nanocodex installation, then restart the provider.`,
          });
          break;
        case "killed":
          break;
      }
    } finally {
      // The single guarantee that every clientRequestId settles: the scribe's
      // settle() is idempotent and auto-accepts, so this one statement covers
      // the spawn failure, the crash, the projection failure and the ordinary
      // path alike. No claim/rollback timer, because there is no window in
      // which a turn can quietly produce nothing — the child either reaches a
      // terminal event or exits.
      if (!released) {
        scribe.settle(interruptRequested ? "interrupted" : "failed");
        const status = scribe.status === "completed" ? "completed" : scribe.status === "interrupted" ? "interrupted" : "failed";
        record = projector.finish(status);
        continuity.commitTurn(record);
        if (compaction && status === "completed" && record.final.trim().length > 0) {
          continuity.commitCompaction({ throughOrdinal: ordinal, summary: record.final });
        }
      }
    }
  };

  return {
    threadId,
    providerThreadId: continuity.providerThreadId,

    submit(queued) {
      if (released) return;
      queue.push(queued);
      pump();
    },

    steer(queued) {
      if (released) throw new NoActiveTurnError("session is gone");
      queue.push(queued);
      pump();
    },

    async stop(intent) {
      if (intent === "release") {
        released = true;
        queue.length = 0;
        activeHandle?.abandon();
        return;
      }
      if (!running || activeScribe === null) {
        writer.flush();
        return;
      }
      const drained = queue.splice(0, queue.length);
      activeScribe.adopt(
        drained
          .map((queued) => queued.clientRequestId)
          .filter((id): id is ClientTurnRequestId => id !== null),
      );
      interruptRequested = true;
      activeHandle?.interrupt();
      await activeTurn;
    },

    async discard() {
      released = true;
      queue.length = 0;
      activeHandle?.abandon();
      continuity.discard();
    },

    close() {
      released = true;
      queue.length = 0;
      activeHandle?.abandon();
    },
  };
}

function describeExit(outcome: Extract<RunOutcome, { kind: "no-terminal" }>): string {
  const retryable = outcome.exitCode === RETRYABLE_EXIT_CODE ? " nanocodex marks this exit code retryable; try the turn again." : "";
  const tail = outcome.stderrTail.trim();
  const stderr = tail.length > 0 ? ` Stderr: ${tail.slice(-2_000)}` : "";
  return `nanocodex exited (code ${outcome.exitCode ?? "unknown"}) without reporting a result.${retryable}${stderr}`;
}

/**
 * What the compaction turn asks nanocodex. The composed prompt already carries
 * the stitched history above this text, so the model summarizes what it can
 * actually see.
 */
const COMPACTION_REQUEST_TEXT = [
  "Summarize this conversation so far for your own future reference.",
  "Cover: what was asked, what was done (files, commands, decisions), what failed, and what remains open.",
  "Reply with the summary only.",
].join(" ");

/**
 * Detect bb's built-in `/compact` submission.
 *
 * `isStandaloneBuiltinCompactCommand` from the SDK identifies input that is
 * exactly the built-in compact mention. This bridge answers it for real rather
 * than treating it as prose: run one turn whose prompt asks nanocodex to
 * summarize the conversation so far, then `commitCompaction` with the answer.
 * The stitched-prompt design makes context growth the user's problem, so it
 * owes the user a lever — and the ledger makes that lever a five-line append.
 */
export function isCompactionRequest(input: readonly PromptInput[]): boolean {
  return isStandaloneBuiltinCompactCommand(input);
}
