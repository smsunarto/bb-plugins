/**
 * `src/bridge/entry.ts` — the wire, and nothing else.
 *
 * JSON-RPC dispatch, param validation, result shapes, and the session
 * registry. Everything nanocodex-flavored happens behind `session.ts`.
 * Importing this module starts nothing: the conformance suite drives
 * `handleLine` in-process, and `start()` is the only thing that touches disk.
 *
 * The bootstrap (`provider-bridge-worker-entry.mjs`) owns argv, stdin framing,
 * the temp dir, signal wiring, and wire recording. This module must never read
 * stdin and must never install a signal handler.
 */

import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  createBridgeIo,
  experimental_defineProviderBridge,
  modelListParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeCapabilities,
  type BridgeExecutionOptions,
  type PromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  DEFAULT_HISTORY_BUDGET_BYTES,
  NANOCODEX_ARGS_OVERRIDE_ENV,
  NANOCODEX_COMMAND_OVERRIDE_ENV,
  NANOCODEX_WIRE_MODELS,
} from "../catalog.ts";
import {
  mintProviderThreadId,
  openThreadContinuity,
  UnknownCheckpointError,
} from "./continuity.ts";
import { probeHealth, probeInstallation, runInstallation } from "./maintenance.ts";
import { createNanocodexSession, NoActiveTurnError, type NanocodexSession } from "./session.ts";
import { createThreadWriter } from "./timeline.ts";

/**
 * The handshake facts.
 *
 * `grammarVersions: [3, 3]` is load-bearing: omitting it reads as [2, 2] and
 * the runtime refuses the bridge outright.
 *
 * `sessionRestore: true` and the per-thread `sessionRestorable: true` are the
 * honest answer for this bridge, and they are honest ONLY because continuity
 * is bridge-owned. A nanocodex session cannot be restored; a bb thread's
 * ledger always can, and the ledger is what a resume restores. The per-thread
 * flag also switches on the runtime's idle-session reaping, which is exactly
 * right here — there is no live child to lose, so releasing an idle thread
 * costs nothing and reclaims runtime bookkeeping. It does mean `thread/resume`
 * is a HOT path, which is why it is total (see `openThreadContinuity`).
 *
 * `fork: "checkpoint"` because a ledger slice is a fork. Every `turn.boundary`
 * carries `providerCheckpointId = String(ordinal)`, and forking at one copies
 * the file up to that ordinal. The declaration in `lib/declaration.ts` says
 * `checkpoint` too — the handshake may narrow the declaration but never widen
 * it, so the two are pinned together by `test/declaration.test.ts`.
 *
 * `approvalEnforcedBy: "provider"` because the child pauses for nothing and
 * cannot be asked: it reads no stdin. This bridge will never send
 * `interaction/request`, and `permissionModes: ["full"]` in the declaration is
 * the matching fact.
 *
 * `steerMode: "queue"` — `session.ts` holds a steer to the next prompt
 * boundary. Nothing reads the mode yet; it is declared because it is true.
 */
export const CAPABILITIES: BridgeCapabilities = {
  grammarVersions: [3, 3],
  sessionRestore: true,
  fork: "checkpoint",
  approvalEnforcedBy: "provider",
  steerMode: "queue",
  threadArchive: false,
  threadRename: false,
  threadGoalClear: false,
  skills: { configure: false },
};

/**
 * The start/resume/fork result. `sessionRestorable` is absent from the 0.4.21
 * bundled types because the identity schemas are `.passthrough()`; bb's
 * `packages/provider-bridge-protocol` defines it, and the runtime reads it from
 * the RESULT (a `thread/identity` notification does not substitute for it).
 */
interface ThreadIdentityResult {
  providerThreadId: string;
  sessionRestorable: boolean;
}

interface BridgeState {
  /** `<pluginDataDir>`; ledgers live under `<dataDir>/threads/`. */
  readonly dataDir: string;
}

let state: BridgeState | null = null;

/** bb threadId -> session. The only mutable bridge-scope state besides `state`. */
const sessions = new Map<string, NanocodexSession>();

const io = createBridgeIo();

type JsonRpcId = string | number;

function requireState(): BridgeState {
  if (state === null) throw new Error("The bridge received a request before start()");
  return state;
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

function methodNotFound(id: JsonRpcId, method: string): void {
  io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not implemented: ${method}`);
}

interface ResolvedProviderOptions {
  readonly cliPath: string | null;
  readonly budgetBytes: number;
  readonly features: { subagents: boolean; webSearch: boolean; imageGeneration: boolean; mcpDefaults: boolean };
}

/** What `deriveProviderOptions` in `lib/declaration.ts` produced, read defensively: a bridge must not crash on a stale registration's shape. */
function readProviderOptions(providerOptions: unknown): ResolvedProviderOptions {
  const record =
    typeof providerOptions === "object" && providerOptions !== null
      ? (providerOptions as Record<string, unknown>)
      : {};
  const features =
    typeof record.features === "object" && record.features !== null
      ? (record.features as Record<string, unknown>)
      : {};
  const flag = (value: unknown): boolean => value !== false;
  return {
    cliPath: typeof record.nanocodexCliPath === "string" ? record.nanocodexCliPath : null,
    budgetBytes:
      typeof record.historyBudgetBytes === "number" && record.historyBudgetBytes > 0
        ? record.historyBudgetBytes
        : DEFAULT_HISTORY_BUDGET_BYTES,
    features: {
      subagents: flag(features.subagents),
      webSearch: flag(features.webSearch),
      imageGeneration: flag(features.imageGeneration),
      mcpDefaults: flag(features.mcpDefaults),
    },
  };
}

/** The test seam: `BB_NANOCODEX_COMMAND`/`BB_NANOCODEX_ARGS` override the spawn. BB_-prefixed on purpose, so the child-env sanitizer strips them from the child. */
function resolveLaunch(cliPath: string | null): { command: string; argsPrefix: readonly string[] } {
  const commandOverride = process.env[NANOCODEX_COMMAND_OVERRIDE_ENV]?.trim();
  const argsOverride = process.env[NANOCODEX_ARGS_OVERRIDE_ENV];
  const command =
    commandOverride !== undefined && commandOverride.length > 0
      ? commandOverride
      : (cliPath ?? "nanocodex");
  let argsPrefix: readonly string[] = [];
  if (argsOverride !== undefined && argsOverride.length > 0) {
    try {
      const parsed: unknown = JSON.parse(argsOverride);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        argsPrefix = parsed;
      }
    } catch {
      argsPrefix = argsOverride.split(/\s+/).filter((entry) => entry.length > 0);
    }
  }
  return { command, argsPrefix };
}

function dropSession(threadId: string): void {
  const session = sessions.get(threadId);
  if (session === undefined) return;
  session.close();
  sessions.delete(threadId);
}

/**
 * "Result first, then work" as a value (the AfterReply pattern). The JSON-RPC
 * result must be on the wire before the first delta, and a function that both
 * builds the writer (which emits `thread/identity` + `session.reset` on
 * construction) and sends the result gets that ordering wrong invisibly. So
 * `prepareSession` does no emitting at all: the handler sends `result`, THEN
 * calls `afterReply()`, which constructs the writer and runs any embedded
 * input. The ordering is in the type, not in reviewer vigilance.
 */
interface AfterReply<T> {
  readonly result: T;
  afterReply(): void;
}

/**
 * Open a session for a thread, whatever brought us here.
 *
 * `thread/start`, `thread/resume` and `thread/fork` differ in exactly one
 * respect — which ledger the new session starts from — so they share one body
 * and differ by one argument. Collapsing them is not tidiness: three copies of
 * "mint the id, open the ledger, build the writer, announce identity, reset the
 * session, maybe run the embedded input" is three chances to forget the
 * `session.reset` (Gotcha 3) or to emit a delta before identity (Gotcha 6).
 *
 * Always produces an identity. See `openThreadContinuity`: a resume that
 * errors fails the turn submission with no daemon-side fallback, so this
 * function has no error path for a missing or unreadable ledger.
 */
function prepareSession(args: {
  threadId: string;
  cwd: string;
  /** null: mint from `threadId`. Otherwise the id the runtime handed back. */
  providerThreadId: string | null;
  /** Present only for `thread/fork`. */
  forkFrom: { sourceProviderThreadId: string; throughOrdinal: number | null } | null;
  params: {
    options: BridgeExecutionOptions;
    instructionMode: "append" | "replace";
    input?: readonly PromptInput[];
  };
}): AfterReply<ThreadIdentityResult> {
  const bridge = requireState();
  const { threadId, cwd, params } = args;
  dropSession(threadId);

  const continuity =
    args.forkFrom !== null
      ? openThreadContinuity({
          dataDir: bridge.dataDir,
          providerThreadId: args.forkFrom.sourceProviderThreadId,
        }).forkInto({ threadId, throughOrdinal: args.forkFrom.throughOrdinal })
      : openThreadContinuity({
          dataDir: bridge.dataDir,
          providerThreadId: args.providerThreadId ?? mintProviderThreadId(threadId),
        });

  const resolved = readProviderOptions(params.options.providerOptions);
  const providerThreadId = continuity.providerThreadId;

  return {
    result: { providerThreadId, sessionRestorable: true },
    afterReply() {
      const writer = createThreadWriter({
        threadId,
        providerThreadId,
        send: (message) => {
          io.send(message);
        },
      });
      const session = createNanocodexSession({
        threadId,
        cwd,
        writer,
        continuity,
        launch: resolveLaunch(resolved.cliPath),
        instructionMode: params.instructionMode,
        budgetBytes: resolved.budgetBytes,
        features: resolved.features,
        expectHistory: args.providerThreadId !== null && args.forkFrom === null,
      });
      sessions.set(threadId, session);
      const input = params.input;
      if (input !== undefined && input.length > 0) {
        // thread/start input carries no clientRequestId and therefore no acceptance.
        session.submit({ input, clientRequestId: null, options: params.options });
      }
    },
  };
}

/** The maintenance verbs run sessionless; the CLI they probe is the same one the sessions would spawn. */
function maintenanceCommand(providerOptions: unknown): string | null {
  const launch = resolveLaunch(readProviderOptions(providerOptions).cliPath);
  return launch.command;
}

/**
 * Dispatch. Every declared method answers; every undeclared one answers
 * METHOD_NOT_FOUND rather than going silent (conformance-checked, and
 * `maintenance` in the declaration gates which ones the runtime will even ask).
 */
const handlers: Record<string, (id: JsonRpcId, params: unknown) => void | Promise<void>> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id) => {
    io.sendResult(id, { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: CAPABILITIES });
  },

  /** The static catalog, from the same constant the declaration's fallback reads. `cwd` is ignored: the catalog is not workspace-dependent. */
  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    io.sendResult(id, { models: NANOCODEX_WIRE_MODELS, selectedOnlyModels: [] });
  },

  /** Declared `maintenance: {health: true}`; answered from `maintenance.ts`. */
  [BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
      return;
    }
    io.sendResult(id, await probeHealth({ command: maintenanceCommand(parsed.data.providerOptions) }));
  },

  /** Declared `usage: false`. nanocodex has no credible usage source — `credits` sits behind the optional `tempo` cargo feature and is absent from default builds. */
  [BRIDGE_REQUEST_METHODS.providerUsage]: (id) => {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, "provider/usage is not declared");
  },

  /** Declared `installation: true`: nanocodex is not npm-distributed, so install is unavailable but `nanocodex update` exists. */
  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: async (id, params) => {
    const parsed = providerInstallationStatusParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerInstallationStatus, parsed.error.issues);
      return;
    }
    io.sendResult(id, await probeInstallation({ command: maintenanceCommand(parsed.data.providerOptions) }));
  },
  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: async (id, params) => {
    const parsed = providerInstallationRunParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerInstallationRun, parsed.error.issues);
      return;
    }
    io.sendResult(
      id,
      await runInstallation({
        action: parsed.data.action,
        command: maintenanceCommand(parsed.data.providerOptions),
      }),
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    const prepared = prepareSession({
      threadId: parsed.data.threadId,
      cwd: parsed.data.cwd,
      providerThreadId: null,
      forkFrom: null,
      params: {
        options: parsed.data.options,
        instructionMode: parsed.data.instructionMode,
        input: parsed.data.input,
      },
    });
    io.sendResult(id, prepared.result);
    prepared.afterReply();
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    // No SESSION_NOT_RESTORABLE path exists, by design: openThreadContinuity
    // is total and an amnesiac thread beats a bricked one.
    const prepared = prepareSession({
      threadId: parsed.data.threadId,
      cwd: parsed.data.cwd,
      providerThreadId: parsed.data.providerThreadId,
      forkFrom: null,
      params: {
        options: parsed.data.options,
        instructionMode: parsed.data.instructionMode,
        input: parsed.data.input as readonly PromptInput[] | undefined,
      },
    });
    io.sendResult(id, prepared.result);
    prepared.afterReply();
  },

  [BRIDGE_REQUEST_METHODS.threadFork]: (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      return;
    }
    const rawCheckpoint = parsed.data.sourceProviderCheckpointId;
    const throughOrdinal = rawCheckpoint === undefined ? null : Number(rawCheckpoint);
    if (throughOrdinal !== null && !Number.isInteger(throughOrdinal)) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED,
        `Not a nanocodex checkpoint id: ${rawCheckpoint}`,
      );
      return;
    }
    let prepared: AfterReply<ThreadIdentityResult>;
    try {
      prepared = prepareSession({
        threadId: parsed.data.threadId,
        cwd: parsed.data.cwd,
        providerThreadId: null,
        forkFrom: {
          sourceProviderThreadId: parsed.data.sourceProviderThreadId,
          throughOrdinal,
        },
        params: {
          options: parsed.data.options,
          instructionMode: parsed.data.instructionMode,
        },
      });
    } catch (error) {
      if (error instanceof UnknownCheckpointError) {
        io.sendError(id, BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED, error.message);
        return;
      }
      throw error;
    }
    io.sendResult(id, prepared.result);
    prepared.afterReply();
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Unknown thread ${parsed.data.threadId}: send thread/start first`,
      );
      return;
    }
    // Answer first: the result acknowledges the turn; the work is deltas.
    io.sendResult(id, {});
    session.submit({
      input: parsed.data.input as readonly PromptInput[],
      clientRequestId: parsed.data.clientRequestId,
      options: parsed.data.options,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active turn for this thread");
      return;
    }
    try {
      session.steer({
        input: parsed.data.input as readonly PromptInput[],
        clientRequestId: parsed.data.clientRequestId,
        options: parsed.data.options,
        expectedTurnId: parsed.data.expectedTurnId,
      });
    } catch (error) {
      if (error instanceof NoActiveTurnError) {
        io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, error.message);
        return;
      }
      throw error;
    }
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: async (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session !== undefined) {
      // stop() resolves after the settlement (if any) is flushed, which is
      // what puts an interrupted boundary on the wire before this result.
      await session.stop(parsed.data.intent);
      sessions.delete(parsed.data.threadId);
    }
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: async (id, params) => {
    const parsed = threadDiscardParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadDiscard, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session !== undefined) {
      await session.discard();
      sessions.delete(parsed.data.threadId);
    } else {
      openThreadContinuity({
        dataDir: requireState().dataDir,
        providerThreadId: parsed.data.providerThreadId,
      }).discard();
    }
    io.sendResult(id, {});
  },

  // Declared false in CAPABILITIES; answered, never dropped.
  [BRIDGE_REQUEST_METHODS.threadArchive]: (id) => methodNotFound(id, BRIDGE_REQUEST_METHODS.threadArchive),
  [BRIDGE_REQUEST_METHODS.threadUnarchive]: (id) => methodNotFound(id, BRIDGE_REQUEST_METHODS.threadUnarchive),
  [BRIDGE_REQUEST_METHODS.threadNameSet]: (id) => methodNotFound(id, BRIDGE_REQUEST_METHODS.threadNameSet),
  [BRIDGE_REQUEST_METHODS.threadGoalClear]: (id) => methodNotFound(id, BRIDGE_REQUEST_METHODS.threadGoalClear),
  [BRIDGE_REQUEST_METHODS.skillsConfigure]: (id) => methodNotFound(id, BRIDGE_REQUEST_METHODS.skillsConfigure),
};

/**
 * The one line handler.
 *
 * A parsed object with NO `method` field is a response to a bridge-originated
 * request — that absence is the only marker separating a runtime reply from a
 * runtime request. This bridge originates none (it sends no `item/tool/call`
 * and no `interaction/request`), so a response can only be a stray and is
 * dropped. Non-JSON lines are ignored, never answered.
 */
export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null) return;
  const record = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof record.method !== "string") return;
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return;
  const method = record.method;
  const handler = handlers[method];
  if (handler === undefined) {
    methodNotFound(id, method);
    return;
  }
  runBridgeRequest({
    request: { id, method, params: record.params },
    sendError: io.sendError,
    handleRequest: async (request) => {
      await handler(request.id, request.params);
    },
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    state = { dataDir: context.dataDir };
  },
  /**
   * SIGTERM/SIGINT: kill every child and emit nothing. Fabricating boundaries
   * on the way down would write interruptions into threads the user never
   * interrupted; the runtime re-establishes the sessions on the next turn, and
   * the ledger already holds everything that mattered.
   */
  onSigterm() {
    for (const session of sessions.values()) session.close();
  },
  onSigint() {
    for (const session of sessions.values()) session.close();
  },
  onClose() {
    for (const session of sessions.values()) session.close();
  },
});
