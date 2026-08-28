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
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "@ampcode/sdk";
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
import { AMP_CLI_SHIM_REAL_CLI_ENV } from "../amp-cli-shim.ts";
import { createFileOracleReportStore } from "../oracle-report-store.ts";
import { createSessionStore } from "../session-store.ts";
import { installStderrGuard } from "../stderr-guard.ts";
import {
  createAmpConversation,
  createRetryState,
  runOrb,
  type AmpConversationDeps,
} from "./conversation.ts";
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
}

let state: BridgeState | null = null;
let processGuardsInstalled = false;
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

interface CliEnvironment {
  /** Shim path also merged into the child env as AMP_CLI_PATH, or null when
   * the ambient process env carries the CLI location. */
  ampCliPath: string | null;
  /** Extra child env on top of process.env. */
  env: Record<string, string>;
}

/**
 * The Amp SDK resolves its CLI from `process.env.AMP_CLI_PATH` only, so a
 * providerOptions override must land there, not just in execute options.
 */
function cliEnvironment(options: BridgeExecutionOptions): CliEnvironment {
  const providerOptions = readProviderOptions(providerOptionsOf(options));
  const env: Record<string, string> = {};
  if (providerOptions.ampRealCliPath !== undefined) {
    env[AMP_CLI_SHIM_REAL_CLI_ENV] = providerOptions.ampRealCliPath;
  }
  if (providerOptions.ampCliPath !== undefined) {
    process.env.AMP_CLI_PATH = providerOptions.ampCliPath;
    return { ampCliPath: providerOptions.ampCliPath, env };
  }
  return { ampCliPath: null, env };
}

/** ACP-era parity: an ambient AMP_CLI_PATH pointing at the real CLI is
 * re-pointed through the bundled shim when one sits beside this artifact. */
function repointThroughShim(): void {
  const shim = join(dirname(fileURLToPath(import.meta.url)), "amp-cli-shim.js");
  const configured = process.env.AMP_CLI_PATH?.trim();
  if (
    configured !== undefined &&
    configured.length > 0 &&
    configured !== shim &&
    existsSync(shim)
  ) {
    process.env[AMP_CLI_SHIM_REAL_CLI_ENV] = configured;
    process.env.AMP_CLI_PATH = shim;
  }
}

/** One-shot `amp threads …` invocation; the SDK exports no helpers for
 * archive or rename, so this shells out to the same CLI executions use. */
function threadCommand(extraEnv: Record<string, string>) {
  return (argv: readonly string[]): Promise<{ ok: boolean; stderr: string }> =>
    new Promise((resolve) => {
      const configured = process.env.AMP_CLI_PATH?.trim();
      const cli = configured !== undefined && configured.length > 0 ? configured : "amp";
      const nodeWrapped = /\.(cjs|js|mjs)$/.test(cli);
      const child = spawn(
        nodeWrapped ? process.execPath : cli,
        nodeWrapped ? [cli, ...argv] : [...argv],
        { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] },
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
  const cli = cliEnvironment(args.options);
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
    execute,
    ampCliPath: cli.ampCliPath,
    env: cli.env,
    retry: createRetryState(),
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
      threadCommand: threadCommand(cli.env),
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
  const result = await threadCommand({})(archiveArgv(record.ampThreadId, archived));
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
    // Amp owns model choice through its mode; bb's reasoning ladder maps to
    // it in options.ts. No model list to offer.
    io.sendResult(id, { models: [], selectedOnlyModels: [] });
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
    const record: AmpSessionRecord =
      existing !== null && existing.threadId === threadId
        ? existing
        : { ampThreadId: null, executionTarget: "local", threadId };
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
    const result = await threadCommand({})([
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

function installProcessGuards(): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  // The Amp SDK writes to its child's stdin without an error listener, so a
  // dying CLI surfaces as an EPIPE uncaughtException. Ignore exactly that;
  // anything else keeps the default crash (the daemon restarts the bridge).
  process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      console.error("[bridge] ignored child stdin EPIPE");
      return;
    }
    console.error("[bridge] uncaught exception", error);
    process.exit(1);
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    installStderrGuard();
    installProcessGuards();
    repointThroughShim();
    state = {
      store: createSessionStore({ dir: join(context.dataDir, "sessions") }),
      oracle: createOracleReports(),
    };
  },
  onSigterm() {
    // Release-abort everything: no settlement deltas, nothing fabricated.
    for (const threadId of Array.from(sessions.keys())) {
      dropSession(threadId, "the bridge is shutting down");
    }
  },
});
