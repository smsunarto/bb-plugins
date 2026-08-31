/**
 * `src/bridge/entry.ts` — the native provider bridge entry point.
 *
 * Owns the wire: JSON-RPC dispatch, param validation, result shapes, and the
 * session registry. Everything Amp-flavored happens behind `session.ts`.
 * Importing this module starts nothing (the conformance test drives
 * `handleLine` in-process); the one exception is the `--mcp-stdio` re-exec
 * below, which must run at module evaluation because the MCP child is plain
 * `node <artifact> --mcp-stdio` and nothing calls `start()` there.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sentryPerformanceReporter,
  type SentryPerformanceReporter,
} from "@bb-kit/sentry/performance";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  createBridgeIo,
  createPendingToolCallTracker,
  experimental_BridgeRecoveryError as BridgeRecoveryError,
  experimental_defineProviderBridge,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadArchiveParamsSchema,
  threadDiscardParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeCapabilities,
  type BridgeExecutionOptions,
  type DynamicTool,
} from "@get-bb/plugin-sdk/provider-bridge";
import { resolveAmpCliLaunch } from "../../lib/provision.ts";
import { AMP_WIRE_MODELS } from "./model-catalog.ts";
import { createFileOracleReportStore } from "../oracle-report-store.ts";
import { consumeOrbIntent } from "../orb-intent.ts";
import { createSessionStore } from "../session-store.ts";
import { installStderrGuard } from "../stderr-guard.ts";
import {
  createAmpConversation,
  createRetryState,
  runOrb,
  type AmpConversationDeps,
} from "./conversation.ts";
import { createAmpExecute } from "./execute.ts";
import { readProviderOptions } from "./options.ts";
import type { OracleReports } from "./project.ts";
import {
  createAmpSession,
  mintProviderThreadId,
  NoActiveTurnError,
  type AmpSession,
  type AmpSessionRecord,
  type SessionStore,
} from "./session.ts";
import { createThreadWriter, type ThreadWriter } from "./timeline.ts";
import { runMcpStdioChild, startToolProxy, type ToolProxy } from "./tool-proxy.ts";

// The MCP child re-executes this artifact; it must never touch bridge state.
if (process.argv.includes("--mcp-stdio")) {
  runMcpStdioChild();
}

/** Amp thread label marking threads driven through bb. */
const AMP_ACP_LABEL = "via-amp-acp";

/**
 * `grammarVersions: [3, 3]` is load-bearing: omitting it reads as [2, 2] and
 * the runtime refuses the bridge. `steerMode: "inject"` is truthful only
 * because of the session pump's post-terminal idle window.
 */
const CAPABILITIES: BridgeCapabilities = {
  grammarVersions: [3, 3],
  sessionRestore: true,
  threadArchive: true,
  threadRename: true,
  threadGoalClear: false,
  fork: "none",
  approvalEnforcedBy: "runtime",
  steerMode: "inject",
  skills: { configure: false },
};

type JsonRpcId = string | number;

interface ManagedSession {
  session: AmpSession;
  writer: ThreadWriter;
  proxy: ToolProxy | null;
  /** Identity for the pending-tool-call tracker. */
  scope: object;
}

interface BridgeState {
  store: SessionStore;
  oracle: OracleReports;
  performance: SentryPerformanceReporter | undefined;
  /** The bridge's persistent data directory. The composer's armed Orb
   * intent (src/orb-intent.ts) is consumed from here at thread/start. */
  dataDir: string;
}

let state: BridgeState | null = null;
const sessions = new Map<string, ManagedSession>();

const io = createBridgeIo();
const tracker = createPendingToolCallTracker({
  sendToolCall: (request) => {
    io.send(request);
  },
});

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

function providerOptionsOf(options: BridgeExecutionOptions): unknown {
  return (options as { providerOptions?: unknown }).providerOptions;
}

/** Sessionless requests (archive or rename with no open session) carry no
 * providerOptions, so they resolve the CLI themselves. `resolveAmpCliLaunch`
 * is the same resolution the registration uses, rather than a fall back to
 * bare `amp`: a GUI-launched daemon has a minimal PATH, which is why that
 * search looks in `~/.local/bin` and friends at all. Resolving differently
 * here archived and renamed through a binary the sessions never used, or
 * through none. Reusing it also means a stale `AMP_CLI_PATH` is checked for
 * executability and superseded by a fresh search, instead of being spawned
 * because it is set. */
function ambientCliPath(): string {
  const configured = process.env.AMP_CLI_PATH?.trim();
  const recorded = configured !== undefined && configured.length > 0 ? configured : null;
  return resolveAmpCliLaunch(recorded)?.command ?? "amp";
}

/** The Amp CLI a session spawns: the registration's providerOptions win over
 * the ambient AMP_CLI_PATH, with bare `amp` on PATH as the last resort. */
function resolveCliPath(options: BridgeExecutionOptions): string {
  return readProviderOptions(providerOptionsOf(options)).ampCliPath ?? ambientCliPath();
}

/** One-shot `amp threads …` invocation (archive, rename), outside the
 * execute wire. */
function threadCommand(cliPath: string) {
  return (argv: readonly string[]): Promise<{ ok: boolean; stderr: string }> =>
    new Promise((resolve) => {
      const nodeWrapped = /\.(cjs|js|mjs)$/.test(cliPath);
      const child = spawn(
        nodeWrapped ? process.execPath : cliPath,
        nodeWrapped ? [cliPath, ...argv] : [...argv],
        { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        resolve({ ok: false, stderr: error.message });
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0, stderr });
      });
    });
}

function archiveArgv(ampThreadId: string, archived: boolean): string[] {
  return archived
    ? ["threads", "archive", ampThreadId]
    : ["threads", "archive", ampThreadId, "--unarchive"];
}

function createOracleReports(): OracleReports {
  const reportStore = createFileOracleReportStore();
  const completed = new Set<string>();
  return {
    begin(question) {
      const reportId = reportStore.start(question);
      if (reportId === null) return null;
      return {
        reportId,
        write: (text) => {
          completed.add(reportId);
          reportStore.complete(reportId, text, false);
        },
      };
    },
    finish(reportId, status) {
      if (completed.delete(reportId)) return;
      reportStore.complete(
        reportId,
        status === "error" ? "The Oracle call failed before producing a report." : "",
        status === "error",
      );
    },
  };
}

function dropSession(threadId: string, reason: string): void {
  const managed = sessions.get(threadId);
  if (managed === undefined) return;
  managed.session.close();
  tracker.resolvePendingToolCalls(managed.scope, reason);
  managed.proxy?.close();
  sessions.delete(threadId);
}

async function openSession(args: {
  bridge: BridgeState;
  threadId: string;
  providerThreadId: string;
  cwd: string;
  record: AmpSessionRecord;
  disallowedTools: readonly string[];
  dynamicTools: readonly DynamicTool[];
  options: BridgeExecutionOptions;
}): Promise<ManagedSession> {
  const cliPath = resolveCliPath(args.options);
  const scope = {};
  let proxy: ToolProxy | null = null;
  if (args.dynamicTools.length > 0) {
    proxy = await startToolProxy({
      tools: args.dynamicTools,
      threadId: args.threadId,
      entryPath: fileURLToPath(import.meta.url),
      callTool: (call) =>
        tracker.forwardToolCall({
          arguments: call.arguments,
          providerThreadId: args.providerThreadId,
          scope,
          threadId: args.threadId,
          toolName: call.tool,
        }),
    });
  }
  const writer = createThreadWriter({
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sessionRestorable: true,
    resetIdSpace: true,
    send: (message) => {
      io.send(message);
    },
  });
  const deps: AmpConversationDeps = {
    execute: createAmpExecute({ cliPath }),
    env: {},
    retry: createRetryState(),
    startTrace: ({ executor, continuation, mcp, mode, attempt }) =>
      args.bridge.performance?.start({
        operation: "cli.startup",
        variant: `${executor}.${continuation}.${mcp ? "mcp" : "no-mcp"}.${mode}.attempt-${attempt}`,
      }),
  };
  const mcpConfig = proxy?.config ?? null;
  const orbProject = readProviderOptions(providerOptionsOf(args.options)).orbProject ?? null;
  const session = createAmpSession({
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: args.cwd,
    record: args.record,
    writer,
    store: args.bridge.store,
    disallowedTools: args.disallowedTools,
    mcpConfigDigest: proxy?.digest ?? "",
    bbToolIds: proxy?.toolIds ?? new Set<string>(),
    deps: {
      createConversation: ({ shape, continueFrom }) =>
        createAmpConversation({ shape, continueFrom, mcpConfig, labels: [AMP_ACP_LABEL], deps }),
      runOrb: ({ prompt, shape, continueFrom }) =>
        runOrb({
          prompt,
          project: continueFrom === null ? orbProject : null,
          continueFrom,
          shape,
          labels: [AMP_ACP_LABEL],
          deps,
        }),
      threadCommand: threadCommand(cliPath),
      oracle: args.bridge.oracle,
    },
  });
  return { session, writer, proxy, scope };
}

function startFirstInput(
  managed: ManagedSession,
  input: unknown,
  options: BridgeExecutionOptions,
): void {
  if (!Array.isArray(input) || input.length === 0) return;
  // thread/start input carries no clientRequestId, so no input.accepted.
  void managed.session.startTurn({ input, clientRequestId: null, options }).catch(() => {});
}

async function archiveThread(
  id: JsonRpcId,
  params: { providerThreadId: string; threadId: string },
  archived: boolean,
): Promise<void> {
  const managed = sessions.get(params.threadId);
  if (managed !== undefined) {
    await managed.session.archive(archived);
    io.sendResult(id, {});
    return;
  }
  const record = await requireState().store.read(params.providerThreadId);
  if (record === null || record.ampThreadId === null) {
    // Nothing exists on Amp's side; the bb-side archive still succeeds.
    io.sendResult(id, {});
    return;
  }
  const result = await threadCommand(ambientCliPath())(archiveArgv(record.ampThreadId, archived));
  if (!result.ok) throw new Error(`amp threads archive failed: ${result.stderr.trim()}`);
  io.sendResult(id, {});
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void | Promise<void>;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id) => {
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    // One model whose reasoning efforts are Amp's modes; options.ts maps the
    // level onto --mode. This live answer replaces the declaration's
    // cold-cache fallback, so both read src/bridge/model-catalog.ts.
    io.sendResult(id, { models: AMP_WIRE_MODELS, selectedOnlyModels: [] });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
      return;
    }
    io.sendResult(id, { supported: false });
  },

  [BRIDGE_REQUEST_METHODS.providerUsage]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.providerUsage, parsed.error.issues);
      return;
    }
    io.sendResult(id, { supported: false });
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: (id) => {
    methodNotFound(id, BRIDGE_REQUEST_METHODS.providerInstallationStatus);
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: (id) => {
    methodNotFound(id, BRIDGE_REQUEST_METHODS.providerInstallationRun);
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: async (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    const bridge = requireState();
    const { threadId, cwd, options } = parsed.data;
    const providerThreadId = mintProviderThreadId(threadId);
    dropSession(threadId, "the thread was restarted");
    const existing = await bridge.store.read(providerThreadId);
    let record: AmpSessionRecord;
    if (existing !== null && existing.threadId === threadId) {
      record = existing;
    } else {
      // Only a fresh record consumes the composer's armed Orb intent. The
      // executor is fixed when the thread is created, matching Amp, whose
      // executor is a creation-time option.
      const orb = consumeOrbIntent(bridge.dataDir);
      record = { ampThreadId: null, executionTarget: orb ? "orb" : "local", threadId };
      // Write-through so the choice survives a restart before the first turn.
      // Local needs this as much as Orb: without a record the restart looks
      // like a fresh thread, so an intent armed in the meantime would be
      // consumed for a thread whose executor was already settled.
      await bridge.store.write(providerThreadId, record);
    }
    const managed = await openSession({
      bridge,
      threadId,
      providerThreadId,
      cwd,
      record,
      disallowedTools: parsed.data.disallowedTools ?? [],
      dynamicTools: parsed.data.dynamicTools ?? [],
      options,
    });
    sessions.set(threadId, managed);
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
    startFirstInput(managed, parsed.data.input, options);
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: async (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    const bridge = requireState();
    const { threadId, providerThreadId, cwd, options } = parsed.data;
    dropSession(threadId, "the thread was resumed");
    let record = await bridge.store.read(providerThreadId);
    if (record !== null && record.threadId === "") {
      // Adopted ACP-era record: bind it to this bb thread now.
      record = { ...record, threadId };
    } else if (record === null && providerThreadId === mintProviderThreadId(threadId)) {
      // Our own minting with no record: the thread never revealed an Amp
      // thread id, which still resumes — as a fresh Amp conversation.
      record = { ampThreadId: null, executionTarget: "local", threadId };
    }
    if (record === null || record.threadId !== threadId) {
      throw new BridgeRecoveryError({
        code: BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
        message: `No Amp session record for ${providerThreadId}`,
        recovery: {
          kind: "restartRecommended",
          message: "The Amp session for this thread cannot be recovered; start a new thread.",
          retryable: false,
        },
      });
    }
    const managed = await openSession({
      bridge,
      threadId,
      providerThreadId,
      cwd,
      record,
      disallowedTools: parsed.data.disallowedTools ?? [],
      dynamicTools: parsed.data.dynamicTools ?? [],
      options,
    });
    sessions.set(threadId, managed);
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
    startFirstInput(managed, parsed.data.input, options);
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const managed = sessions.get(parsed.data.threadId);
    if (managed === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Unknown thread ${parsed.data.threadId}: send thread/start first`,
      );
      return;
    }
    // Answer first: the result acknowledges the turn; the work is deltas.
    io.sendResult(id, {});
    void managed.session
      .startTurn({
        input: parsed.data.input,
        clientRequestId: parsed.data.clientRequestId,
        options: parsed.data.options,
      })
      .catch(() => {});
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: async (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const managed = sessions.get(parsed.data.threadId);
    if (managed === undefined) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active turn for this thread");
      return;
    }
    try {
      await managed.session.steer({
        input: parsed.data.input,
        clientRequestId: parsed.data.clientRequestId,
        options: parsed.data.options,
        expectedTurnId: parsed.data.expectedTurnId,
      });
      io.sendResult(id, {});
    } catch (error) {
      if (error instanceof NoActiveTurnError) {
        io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, error.message);
        return;
      }
      throw error;
    }
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: async (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const managed = sessions.get(parsed.data.threadId);
    if (managed !== undefined) {
      // stop() resolves after the settlement (if any) is flushed, which is
      // what puts the interrupted boundary on the wire before this result.
      await managed.session.stop(parsed.data.intent);
      tracker.resolvePendingToolCalls(managed.scope, "the session was stopped");
      managed.proxy?.close();
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
    const managed = sessions.get(parsed.data.threadId);
    if (managed !== undefined) {
      await managed.session.discard();
      tracker.resolvePendingToolCalls(managed.scope, "the session was discarded");
      managed.proxy?.close();
      sessions.delete(parsed.data.threadId);
    } else {
      await requireState().store.delete(parsed.data.providerThreadId);
    }
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadArchive]: async (id, params) => {
    const parsed = threadArchiveParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadArchive, parsed.error.issues);
      return;
    }
    await archiveThread(id, parsed.data, true);
  },

  [BRIDGE_REQUEST_METHODS.threadUnarchive]: async (id, params) => {
    const parsed = threadUnarchiveParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadUnarchive, parsed.error.issues);
      return;
    }
    await archiveThread(id, parsed.data, false);
  },

  [BRIDGE_REQUEST_METHODS.threadNameSet]: async (id, params) => {
    const parsed = threadNameSetParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadNameSet, parsed.error.issues);
      return;
    }
    const managed = sessions.get(parsed.data.threadId);
    if (managed !== undefined) {
      await managed.session.rename(parsed.data.title);
      io.sendResult(id, {});
      return;
    }
    const record = await requireState().store.read(parsed.data.providerThreadId);
    if (record === null || record.ampThreadId === null) {
      io.sendResult(id, {});
      return;
    }
    const result = await threadCommand(ambientCliPath())([
      "threads",
      "rename",
      record.ampThreadId,
      parsed.data.title,
    ]);
    if (!result.ok) throw new Error(`amp threads rename failed: ${result.stderr.trim()}`);
    io.sendResult(id, {});
  },

  // Declared unsupported in CAPABILITIES; answered, never dropped.
  [BRIDGE_REQUEST_METHODS.threadGoalClear]: (id) => {
    methodNotFound(id, BRIDGE_REQUEST_METHODS.threadGoalClear);
  },
  [BRIDGE_REQUEST_METHODS.threadFork]: (id) => {
    methodNotFound(id, BRIDGE_REQUEST_METHODS.threadFork);
  },
  [BRIDGE_REQUEST_METHODS.skillsConfigure]: (id) => {
    methodNotFound(id, BRIDGE_REQUEST_METHODS.skillsConfigure);
  },
};

function handleResponse(message: unknown): void {
  tracker.handleToolCallResponse(message as Parameters<typeof tracker.handleToolCallResponse>[0]);
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Non-JSON lines are ignored, never answered.
  }
  if (typeof message !== "object" || message === null) return;
  const record = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof record.method !== "string") {
    handleResponse(record);
    return;
  }
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return; // notification
  const handler = handlers[record.method];
  if (handler === undefined) {
    methodNotFound(id, record.method);
    return;
  }
  runBridgeRequest({
    request: { id, method: record.method, params: record.params },
    sendError: io.sendError,
    handleRequest: async (request) => {
      await handler(request.id, request.params);
    },
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    installStderrGuard();
    state = {
      store: createSessionStore({ dir: join(context.dataDir, "sessions") }),
      oracle: createOracleReports(),
      performance: sentryPerformanceReporter({
        dsn: process.env.SENTRY_DSN,
        release: process.env.SENTRY_RELEASE,
        environment: process.env.SENTRY_ENVIRONMENT,
      })({ pluginId: context.pluginId }),
      dataDir: context.dataDir,
    };
  },
  onSigterm() {
    // Release-abort everything: no settlement deltas, nothing fabricated.
    for (const threadId of Array.from(sessions.keys())) {
      dropSession(threadId, "the bridge is shutting down");
    }
    void state?.performance?.dispose(2_000);
  },
});
