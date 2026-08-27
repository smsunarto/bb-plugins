/**
 * `src/bridge/session.ts` — one bb thread bound to one Amp conversation.
 *
 * The entry point answers the wire; this module runs the work. `startTurn`
 * is the pump: `turn/start` was already answered when it runs, and its
 * promise resolving means the turn settled on the timeline, not that the
 * request completed. One long-lived local CLI process serves consecutive
 * turns of a thread; a shape change (mode, permissions, tool set, cwd)
 * restarts it with `--continue`, announced through `writer.replaced`.
 *
 * Steering: Amp has no native mid-turn injection over stream-json, so the
 * pump holds a short idle window after the CLI's terminal line. A steer that
 * lands mid-turn or inside that window is written to the same stdin and the
 * pump keeps reading; anything later is `NoActiveTurnError`, which the entry
 * answers as JSON-RPC -32001. This window is what lets the capabilities
 * truthfully declare `steerMode: "inject"`.
 */
import { createHash } from "node:crypto";
import type { BridgeExecutionOptions } from "@get-bb/plugin-sdk/provider-bridge";
import {
  shapesEqual,
  type AmpConversation,
  type OrbRun,
  type SessionShape,
} from "./conversation.ts";
import type { AmpEventBatch } from "./events.ts";
import { toSessionShape } from "./options.ts";
import { projectAmpEvent, type OracleReports, type ProjectionContext } from "./project.ts";
import { usageBreakdown, type ThreadWriter, type TurnScribe } from "./timeline.ts";

/** How long the pump lingers after Amp's terminal line before settling the
 * turn, waiting for a steer to continue on the same process. */
export const STEERING_IDLE_MS = 250;

/** Deterministic provider thread id. Re-derivable from the bb thread id, so
 * a store-missed resume can recognize its own minting (fresh-record path). */
export function mintProviderThreadId(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("hex");
  return `amp-${digest.slice(0, 24)}`;
}

export interface AmpSessionRecord {
  /** Amp's own thread id (`T-…`); null until the first CLI line reveals it,
   * which still marks the record restorable (a fresh thread continues as a
   * fresh thread). */
  ampThreadId: string | null;
  executionTarget: "local" | "orb";
  /** The bb thread this record belongs to; "" for adopted ACP-era records
   * (the old store never kept the bb thread id). */
  threadId: string;
}

export interface SessionStore {
  read(providerThreadId: string): Promise<AmpSessionRecord | null>;
  write(providerThreadId: string, record: AmpSessionRecord): Promise<void>;
  delete(providerThreadId: string): Promise<void>;
}

export interface TurnStartArgs {
  /** `PromptInput[]` as validated by the wire schema; only text blocks reach
   * Amp today. */
  input: readonly unknown[];
  /** Null for the first turn embedded in `thread/start` — that input has no
   * request id and therefore no `input.accepted`. */
  clientRequestId: string | null;
  options: BridgeExecutionOptions;
}

export interface SteerArgs extends TurnStartArgs {
  clientRequestId: string;
  /** Required string on the wire (deviation (d) from the sketch, which had
   * it nullable). Unused beyond validation: this bridge runs one turn at a
   * time and the settled check covers staleness. */
  expectedTurnId: string;
}

/** Thrown by `steer` when there is nothing to steer; the entry answers it
 * with JSON-RPC -32001 (NO_ACTIVE_TURN). */
export class NoActiveTurnError extends Error {}

export interface SessionDeps {
  createConversation(args: { shape: SessionShape; continueFrom: string | null }): AmpConversation;
  runOrb(args: { prompt: string; shape: SessionShape; continueFrom: string | null }): OrbRun;
  /** One-shot `amp threads …` CLI invocation (archive, rename); the SDK
   * exports no helpers for these. */
  threadCommand(argv: readonly string[]): Promise<{ ok: boolean; stderr: string }>;
  /** Oracle report persistence for the projection (deviation (h): the sketch
   * passed only `finishOracleReport`, but `ProjectionContext` needs
   * begin/write too, so the whole surface rides here). */
  oracle: OracleReports;
}

export interface AmpSessionArgs {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  /** Resolved by the entry (fresh, resumed, or adopted from the ACP-era
   * store); the session mutates `ampThreadId` and writes it through. */
  record: AmpSessionRecord;
  writer: ThreadWriter;
  store: SessionStore;
  disallowedTools: readonly string[];
  /** From the tool proxy; "" when the thread has no dynamic tools. */
  mcpConfigDigest: string;
  bbToolIds: ReadonlySet<string>;
  deps: SessionDeps;
}

export interface AmpSession {
  readonly threadId: string;
  readonly providerThreadId: string;
  /** Run one turn. `turn/start` is already answered; this promise is the
   * pump — it resolves when the turn settled on the timeline. */
  startTurn(args: TurnStartArgs): Promise<void>;
  /** Resolves once Amp consumed the input (`input.accepted` already sent).
   * Throws `NoActiveTurnError` when there is no live turn to steer. */
  steer(args: SteerArgs): Promise<void>;
  /** "interrupt" settles the live turn as interrupted; "release" drops the
   * session with NO settlement deltas — fabricating an interruption is what
   * bb#1584 was. Resolves after the settlement (if any) is flushed. */
  stop(intent: "interrupt" | "release"): Promise<void>;
  /** Abort everything and delete the persisted record. Idempotent. */
  discard(): Promise<void>;
  archive(archived: boolean): Promise<void>;
  rename(name: string): Promise<void>;
  /** Silent teardown for SIGTERM: abort, no deltas, nothing persisted. */
  close(): void;
}

/** Why a shape change restarts the CLI, for the `session.replaced` notice.
 * Context is only lost when no Amp thread exists yet to `--continue`. */
export function planRestart(args: {
  current: SessionShape;
  next: SessionShape;
  ampThreadId: string | null;
}): { restart: boolean; reason: string; contextLost: boolean } {
  const { current, next, ampThreadId } = args;
  if (shapesEqual(current, next)) return { restart: false, reason: "", contextLost: false };
  const reasons: string[] = [];
  if (current.cwd !== next.cwd) reasons.push("the working directory changed");
  if (current.mode !== next.mode) {
    reasons.push(`the Amp mode changed (${current.mode} -> ${next.mode})`);
  }
  if (current.dangerouslyAllowAll !== next.dangerouslyAllowAll) {
    reasons.push("the permission mode changed");
  }
  if (current.fast !== next.fast) reasons.push("Amp Fast mode changed");
  const denied = (shape: SessionShape): string => [...shape.denied].sort().join(",");
  if (denied(current) !== denied(next)) reasons.push("the disallowed tool list changed");
  if (current.mcpConfigDigest !== next.mcpConfigDigest) {
    reasons.push("the dynamic tool set changed");
  }
  return {
    restart: true,
    reason: reasons.join("; ") || "the session configuration changed",
    contextLost: ampThreadId === null,
  };
}

interface ActiveTurn {
  scribe: TurnScribe;
  done: Promise<void>;
  /** Set while the pump sits in the post-terminal idle window; calling it
   * cancels the timer and keeps the pump reading. */
  steerWake: (() => void) | null;
  authRequired: boolean;
}

interface LiveLocal {
  conversation: AmpConversation;
  shape: SessionShape;
  /** Held manually across turns: a for-await `break` would close the
   * generator, and `batches()` is one continuous stream per CLI process. */
  iterator: AsyncIterator<AmpEventBatch>;
}

function promptText(input: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of input) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n\n");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAmpSession(args: AmpSessionArgs): AmpSession {
  const { threadId, providerThreadId, cwd, record, writer, store, deps } = args;

  let local: LiveLocal | null = null;
  let orbRun: OrbRun | null = null;
  let active: ActiveTurn | null = null;
  let stopping: "interrupt" | "release" | null = null;

  const shapeFor = (options: BridgeExecutionOptions): SessionShape =>
    toSessionShape({
      cwd,
      options,
      disallowedTools: args.disallowedTools,
      mcpConfigDigest: args.mcpConfigDigest,
      firstExecution: record.ampThreadId === null,
    });

  const projection = (scribe: TurnScribe): ProjectionContext => ({
    scribe,
    open: new Map(),
    rows: new Map(),
    oracleByCallId: new Map(),
    oracle: deps.oracle,
    bbToolIds: args.bbToolIds,
    cwd,
    addUsage: (usage) => {
      writer.addUsage(usageBreakdown(usage), null);
    },
    raw: (payload, coverage) => {
      writer.raw(payload, coverage);
    },
  });

  const persistAmpThreadId = (ampThreadId: string): void => {
    if (record.ampThreadId !== null) return;
    record.ampThreadId = ampThreadId;
    // Write-through so a crash right now still resumes into the Amp thread.
    // The amp/thread-link state emission joins this in U6.
    void store.write(providerThreadId, { ...record }).catch(() => {});
  };

  const idleWindow = (turn: ActiveTurn): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (steered: boolean): void => {
        if (settled) return;
        settled = true;
        turn.steerWake = null;
        resolve(steered);
      };
      const timer = setTimeout(() => {
        finish(false);
      }, STEERING_IDLE_MS);
      turn.steerWake = () => {
        clearTimeout(timer);
        finish(true);
      };
    });

  /** The stream ended or threw before the turn settled on its own. */
  const settleAfterStreamEnd = (scribe: TurnScribe, error: unknown): void => {
    if (stopping === "release") return; // bb#1584: never fabricate a settlement
    if (scribe.settled) return;
    if (stopping === "interrupt" || local?.conversation.aborted === true) {
      scribe.settle("interrupted");
      return;
    }
    scribe.fail({
      message:
        error === undefined
          ? "Amp ended without reporting a result"
          : `Amp failed: ${describeError(error)}`,
      settlesTurn: true,
    });
  };

  const pump = async (
    turn: ActiveTurn,
    ctx: ProjectionContext,
    iterator: AsyncIterator<AmpEventBatch>,
    steerable: boolean,
  ): Promise<void> => {
    const scribe = turn.scribe;
    try {
      while (true) {
        let result: IteratorResult<AmpEventBatch>;
        try {
          result = await iterator.next();
        } catch (error) {
          settleAfterStreamEnd(scribe, error);
          return;
        }
        if (result.done === true) {
          settleAfterStreamEnd(scribe, undefined);
          return;
        }
        const batch = result.value;
        if (batch.ampThreadId !== null) persistAmpThreadId(batch.ampThreadId);
        for (const event of batch.events) {
          if (event.kind === "resultError" && event.subtype === "auth_required") {
            turn.authRequired = true;
          }
          projectAmpEvent(event, ctx);
        }
        // Live evidence (U5 smoke): in interactive stream-json mode the CLI
        // ends a turn with stop_reason on the assistant message and sends no
        // result line, so assistantStop is the primary turn-end signal —
        // exactly the signal bridge-core keyed on. Result lines still count:
        // that is how zero-work and error turns terminate.
        const turnEnded =
          batch.terminal || batch.events.some((event) => event.kind === "assistantStop");
        if (!turnEnded) continue;
        // A resultError already settled the turn through scribe.fail.
        if (scribe.settled) return;
        if (steerable) {
          const steered = await idleWindow(turn);
          // A stop arrived inside the window: one more next() surfaces the
          // abort and routes settlement through settleAfterStreamEnd.
          if (stopping !== null) continue;
          if (steered) continue;
        }
        scribe.settle("completed");
        return;
      }
    } finally {
      turn.steerWake = null;
      writer.flush();
      if (active === turn) active = null;
    }
  };

  const reportAuthRequired = (turn: ActiveTurn): void => {
    if (!turn.authRequired) return;
    writer.recovery({
      kind: "authRequired",
      message: "Amp is not signed in. Run `amp login` in a terminal, then retry.",
      retryable: true,
    });
  };

  const ensureLocal = (options: BridgeExecutionOptions): LiveLocal => {
    const next = shapeFor(options);
    // A CLI that exited or was interrupted just respawns with --continue;
    // that is not a shape restart and gets no session.replaced notice.
    if (local !== null && (local.conversation.closed || local.conversation.aborted)) {
      local = null;
    }
    if (local !== null && !shapesEqual(local.shape, next)) {
      const plan = planRestart({ current: local.shape, next, ampThreadId: record.ampThreadId });
      writer.replaced({ providerThreadId, reason: plan.reason, contextLost: plan.contextLost });
      local.conversation.abort("restart");
      local = null;
    }
    if (local === null) {
      const conversation = deps.createConversation({
        shape: next,
        continueFrom: record.ampThreadId,
      });
      local = {
        conversation,
        shape: next,
        iterator: conversation.batches()[Symbol.asyncIterator](),
      };
    }
    return local;
  };

  const runLocalTurn = async (
    turn: ActiveTurn,
    ctx: ProjectionContext,
    live: LiveLocal,
    text: string,
    clientRequestId: string | null,
  ): Promise<void> => {
    const delivered = live.conversation.send(text);
    if (clientRequestId !== null) {
      delivered.then(
        () => {
          // Called only from the delivery promise: accepted means Amp took
          // it, not that we queued it.
          turn.scribe.accept(clientRequestId);
          return null;
        },
        () => null,
      );
    }
    delivered.catch(() => {
      if (stopping === null && !turn.scribe.settled) {
        turn.scribe.fail({ message: "Amp did not accept the input", settlesTurn: true });
        writer.flush();
      }
    });
    await pump(turn, ctx, live.iterator, true);
    reportAuthRequired(turn);
  };

  const runOrbTurn = async (
    turn: ActiveTurn,
    ctx: ProjectionContext,
    text: string,
    turnArgs: TurnStartArgs,
  ): Promise<void> => {
    const run = deps.runOrb({
      prompt: text,
      shape: shapeFor(turnArgs.options),
      continueFrom: record.ampThreadId,
    });
    orbRun = run;
    // Orb prompts are one-shot strings with no delivery signal; starting the
    // execution is the acceptance.
    if (turnArgs.clientRequestId !== null) turn.scribe.accept(turnArgs.clientRequestId);
    try {
      await pump(turn, ctx, run.batches()[Symbol.asyncIterator](), false);
    } finally {
      orbRun = null;
    }
    reportAuthRequired(turn);
  };

  return {
    threadId,
    providerThreadId,

    async startTurn(turnArgs) {
      if (active !== null) await active.done.catch(() => {});
      if (stopping !== null) return;
      const text = promptText(turnArgs.input);
      const scribe = writer.scribe();
      const ctx = projection(scribe);
      const turn: ActiveTurn = {
        scribe,
        done: Promise.resolve(),
        steerWake: null,
        authRequired: false,
      };
      active = turn;
      turn.done =
        record.executionTarget === "orb"
          ? runOrbTurn(turn, ctx, text, turnArgs)
          : runLocalTurn(turn, ctx, ensureLocal(turnArgs.options), text, turnArgs.clientRequestId);
      await turn.done;
    },

    async steer(steerArgs) {
      const turn = active;
      if (turn === null || turn.scribe.settled || stopping !== null) {
        throw new NoActiveTurnError("no active turn to steer");
      }
      const live = local;
      if (record.executionTarget === "orb" || live === null || live.conversation.closed) {
        throw new NoActiveTurnError("this session cannot accept steering input");
      }
      const delivered = live.conversation.send(promptText(steerArgs.input), { steer: true });
      // Cancel a pending idle window before awaiting delivery, so the pump
      // is already reading when Amp answers.
      turn.steerWake?.();
      try {
        await delivered;
      } catch {
        throw new NoActiveTurnError("the Amp process no longer accepts input");
      }
      turn.scribe.accept(steerArgs.clientRequestId);
    },

    async stop(intent) {
      stopping = intent;
      const turn = active;
      local?.conversation.abort(intent);
      orbRun?.abort();
      turn?.steerWake?.();
      if (turn !== null) await turn.done.catch(() => {});
    },

    async discard() {
      stopping = "release";
      local?.conversation.abort("release");
      orbRun?.abort();
      active?.steerWake?.();
      await store.delete(providerThreadId);
    },

    async archive(archived) {
      // No Amp thread yet: the thread exists only in bb; nothing to mirror.
      if (record.ampThreadId === null) return;
      const argv = archived
        ? ["threads", "archive", record.ampThreadId]
        : ["threads", "archive", record.ampThreadId, "--unarchive"];
      const result = await deps.threadCommand(argv);
      if (!result.ok) {
        throw new Error(`amp ${argv.join(" ")} failed: ${result.stderr.trim()}`);
      }
    },

    async rename(name) {
      if (record.ampThreadId === null) return;
      const result = await deps.threadCommand(["threads", "rename", record.ampThreadId, name]);
      if (!result.ok) {
        throw new Error(`amp threads rename failed: ${result.stderr.trim()}`);
      }
    },

    close() {
      stopping = "release";
      local?.conversation.abort("release");
      orbRun?.abort();
      active?.steerWake?.();
    },
  };
}
