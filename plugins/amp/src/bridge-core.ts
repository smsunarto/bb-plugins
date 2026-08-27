// Testable core of the Amp ACP bridge. The Amp SDK's execute() function is
// injected so unit tests can drive the agent with a fake async generator.
// bb is the only intended ACP client; the surface matches exactly what bb
// calls (see README architecture notes).
import { isDeepStrictEqual } from "node:util";
import type {
  Agent,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { MCPConfig } from "@ampcode/sdk";
import { finishOpenOracleReports, toSessionUpdates, type TranslationState } from "./translate.ts";
import { isAuthError, type AmpEventBatch, type AmpMcpServerStatus } from "./bridge/events.ts";
import { createFileOracleReportStore, type OracleReportStore } from "./oracle-report-store.ts";
import { stripOrbDirectives } from "./orb-directive.ts";
import type { AmpExecutionTarget } from "./execution-target.ts";
import type { SteeringInputMonitor } from "./bb-steering-monitor.ts";
import type { AmpPermissionMode } from "./permission-mode.ts";
import {
  createAmpConversation,
  createRetryState,
  runOrb,
  type AmpConversation,
  type AmpConversationDeps,
  type AmpExecuteFn,
  type SessionShape,
} from "./bridge/conversation.ts";

/** Minimal slice of AgentSideConnection the core needs; injected for tests. */
export interface BridgeClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  signal?: AbortSignal;
}

// Amp-vocabulary execution types and the unsupported-option probe moved to
// bridge/conversation.ts in U3; re-exported because the ACP surface and its
// tests import them from this module.
export {
  unsupportedOptionFrom,
  type AmpExecuteOptions,
  type AmpExecutePrompt,
  type AmpExecuteFn,
  type AmpUserInputMessage,
} from "./bridge/conversation.ts";

export interface SessionBinding {
  threadId: string;
  executionTarget: AmpExecutionTarget;
}

export interface ExecutionUsageReport {
  sessionId: string;
  executionTarget: AmpExecutionTarget;
  ampThreadId: string | null;
}

export type ExecutionUsageReporter = (report: ExecutionUsageReport) => void | Promise<void>;

/** Persists the ACP session -> Amp thread execution boundary so session/load
 * can resume safely across bridge restarts. Implementations must never throw. */
export interface SessionStore {
  get(sessionId: string): SessionBinding | null;
  set(sessionId: string, binding: SessionBinding): void;
}

export const memorySessionStore = (): SessionStore => {
  const map = new Map<string, SessionBinding>();
  return {
    get: (sessionId) => map.get(sessionId) ?? null,
    set: (sessionId, binding) => void map.set(sessionId, binding),
  };
};

export const CONFIG_MODE = "amp-mode";
export const CONFIG_REASONING = "reasoning";
export const CONFIG_PERMISSION = "permission";

/**
 * Mode names carry the model Amp runs as a trailing parenthesised group.
 *
 * bb splits a model label on `/^(.*\S)\s*\(([^()]+)\)$/` and renders the tail
 * dimmed next to the name — the same mechanism behind Claude Code's
 * "Opus 5 (1M)" showing as `Opus 5 1M`. The group must be last and must not
 * contain parentheses of its own, or the whole string renders verbatim.
 *
 * The badge reads `<agent> [<effort>] · <oracle> [<effort>]` using the "With
 * ChatGPT Sub" mapping from https://ampcode.com/modes and needs updating when
 * Amp changes it. `·` is deliberate: parentheses inside the group would
 * defeat the split.
 */
export const AMP_MODES = [
  {
    value: "low",
    name: "Low (GPT 5.6 Terra [low] · GPT 5.6 Sol [high])",
    description: "Fast and economical for simple, well-defined tasks.",
  },
  {
    value: "medium",
    name: "Medium (GPT 5.6 Sol [medium] · GPT 5.6 Sol [high])",
    description: "Balanced capability and cost for everyday coding tasks.",
  },
  {
    value: "high",
    name: "High (GPT 5.6 Sol [x-high] · GPT 5.6 Sol [high])",
    description: "Greater capability and reasoning for difficult tasks.",
  },
  {
    value: "ultra",
    name: "Ultra (Fable 5 [high] · GPT 5.6 Sol [high])",
    description: "Maximum capability for the most demanding tasks.",
  },
] as const;

const PERMISSION_MODES = [
  {
    value: "default",
    name: "Default",
    description: "Use Amp's own permission rules. Headless asks are auto-rejected and reported.",
  },
  {
    value: "bypass",
    name: "Bypass",
    description: "Force-allow every tool call (amp.dangerouslyAllowAll).",
  },
] as const;

interface TurnOutputState {
  translationState: TranslationState;
  stopReason: StopReason;
  softFailed: boolean;
  executionError: Error | null;
}

interface LocalTurn extends TurnOutputState {
  promise: Promise<PromptResponse>;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
  prompt: string;
  /** A reused process must echo this prompt before output can belong to it. */
  awaitingInputEcho: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  steeringController: AbortController | null;
  monitorPromise: Promise<void> | null;
  sawAssistantStop: boolean;
  sawRuntimeTerminal: boolean;
  settled: boolean;
}

interface LocalRuntime {
  /** One long-lived SDK execution owns Amp-managed processes across ACP turns. */
  conversation: AmpConversation;
  pump: Promise<void>;
  turn: LocalTurn | null;
  closed: boolean;
}

interface SessionState {
  cwd: string;
  mcpConfig: MCPConfig;
  executionTarget: AmpExecutionTarget;
  executionAttempted: boolean;
  threadId: string | null;
  localRuntime: LocalRuntime | null;
  orbController: { abort(): void } | null;
  steeringMonitor: SteeringInputMonitor | null;
  consumedSteeringInputs: ContentBlock[][];
  restartLocalRuntime: boolean;
  cancelled: boolean;
  active: boolean;
  mode: string;
  permission: AmpPermissionMode;
  reportedMcpStatuses: Set<string>;
}

export interface BridgeDeps {
  execute: AmpExecuteFn;
  createSteeringMonitor?: () => Promise<SteeringInputMonitor | null>;
  resolveInitialPermission?: () => Promise<AmpPermissionMode | null>;
  resolveFastMode?: () => Promise<boolean>;
  store?: SessionStore;
  oracleReports?: OracleReportStore;
  orbProject?: string;
  reportExecutionUsage?: ExecutionUsageReporter;
}

const AUTH_HINT =
  "Amp authentication required: run `amp login` once, or set AMP_API_KEY in the provider env, then retry.";
export const AMP_ACP_LABEL = "via-amp-acp";
const STEERING_IDLE_MS = 250;
const RETRY_LOCAL_RUNTIME = Symbol("retry-local-runtime");

function sameContentBlocks(left: ContentBlock[], right: ContentBlock[]): boolean {
  return isDeepStrictEqual(left, right);
}

export { isAuthError };

/** ACP McpServer[] (bb sends the stdio shape) -> Amp mcpConfig record. */
export function convertMcpServers(mcpServers: McpServer[] | undefined | null): MCPConfig {
  const config: MCPConfig = {};
  if (!Array.isArray(mcpServers)) return config;
  for (const server of mcpServers) {
    if ("type" in server) {
      if (server.type === "acp") continue;
      const headers = Object.fromEntries(
        server.headers.map((header) => [header.name, header.value]),
      );
      config[server.name] = {
        url: server.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        transport: server.type === "sse" ? "sse" : undefined,
      };
      continue;
    }
    config[server.name] = {
      command: server.command,
      args: server.args,
      env:
        server.env.length > 0
          ? Object.fromEntries(server.env.map((variable) => [variable.name, variable.value]))
          : undefined,
    };
  }
  return config;
}

const MCP_ATTENTION_STATUSES = new Set([
  "awaiting-approval",
  "denied",
  "failed",
  "blocked-by-registry",
]);

function buildConfigOptions(s: SessionState): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: CONFIG_MODE,
      name: "Amp Mode",
      description: "Amp execution mode (bb shows this as the model picker).",
      category: "model",
      currentValue: s.mode,
      options: AMP_MODES.map((m) => ({ value: m.value, name: m.name, description: m.description })),
    },
    {
      type: "select",
      id: CONFIG_REASONING,
      name: "Reasoning",
      description: "Reasoning effort is managed by the selected Amp mode.",
      category: "thought_level",
      currentValue: "default",
      options: [{ value: "default", name: "Amp mode default" }],
    },
  ];
  if (s.executionTarget === "local") {
    options.push({
      type: "select",
      id: CONFIG_PERMISSION,
      name: "Permissions",
      description: "Whether Amp applies its configured permission rules or force-allows all tools.",
      category: "mode",
      currentValue: s.permission,
      options: PERMISSION_MODES.map((p) => ({
        value: p.value,
        name: p.name,
        description: p.description,
      })),
    });
  }
  return options;
}

export interface RoutedAmpPrompt {
  prompt: string;
  requestedTarget: AmpExecutionTarget | null;
  directiveOnly: boolean;
}

const BB_SYSTEM_INSTRUCTIONS_PATTERN = /^<system_instructions>\n[\s\S]*\n<\/system_instructions>$/u;
const BB_ATTACHMENT_PLACEHOLDER_PATTERN =
  /^\[(?:image attachment|image attachment on disk|unreadable image attachment): [\s\S]*\]$/u;
const BB_PLUGIN_CONTEXT_PATTERN = /^Context for @[\s\S]+ \(resolved by plugin "[^"]+"\):\n\n/u;
const BB_AGENT_MESSAGE_PATTERN = /^\[bb message from thread:[^\]]+\]\n\n/u;
const BB_SYSTEM_MESSAGE_PATTERN = /^\[bb system\]\n\n/u;

function isBbDirectiveIneligibleText(text: string): boolean {
  return (
    BB_ATTACHMENT_PLACEHOLDER_PATTERN.test(text) ||
    BB_PLUGIN_CONTEXT_PATTERN.test(text) ||
    BB_AGENT_MESSAGE_PATTERN.test(text) ||
    BB_SYSTEM_MESSAGE_PATTERN.test(text) ||
    text === "Please continue."
  );
}

/**
 * bb's ACP adapter loses PromptInput visibility, but keeps block order: its
 * generated instructions lead the prompt and plugin context follows the main
 * text. Route only the first non-generated text block. Embedded resources and
 * hidden bb framing may contain the same bytes and must never change execution.
 */
export function routeAmpPrompt(blocks: ContentBlock[]): RoutedAmpPrompt {
  let text = "";
  let requestedTarget: AmpExecutionTarget | null = null;
  let directiveOnly = false;
  let directiveCandidateResolved = false;
  for (const [index, block] of blocks.entries()) {
    switch (block.type) {
      case "text": {
        let stripped = block.text;
        const isLeadingInstructions =
          index === 0 && BB_SYSTEM_INSTRUCTIONS_PATTERN.test(block.text);
        if (!directiveCandidateResolved && !isLeadingInstructions) {
          directiveCandidateResolved = true;
          if (!isBbDirectiveIneligibleText(block.text)) {
            const routed = stripOrbDirectives(block.text);
            stripped = routed.text;
            if (routed.found) {
              requestedTarget = "orb";
            }
            directiveOnly = requestedTarget !== null && stripped.trim().length === 0;
          }
        }
        text += stripped;
        break;
      }
      case "resource_link":
        text += `\n${block.uri}\n`;
        break;
      case "resource":
        if ("text" in block.resource) {
          text += `\n<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>\n`;
        }
        break;
      default:
        break;
    }
  }
  return {
    prompt: text,
    requestedTarget,
    directiveOnly,
  };
}

export class AmpBridgeAgent implements Agent {
  private readonly client: BridgeClient;
  private readonly execute: AmpExecuteFn;
  private readonly createSteeringMonitor: (() => Promise<SteeringInputMonitor | null>) | undefined;
  private readonly resolveInitialPermission: (() => Promise<AmpPermissionMode | null>) | undefined;
  private readonly resolveFastMode: (() => Promise<boolean>) | undefined;
  private readonly store: SessionStore;
  private readonly oracleReports: OracleReportStore;
  private readonly orbProject: string | undefined;
  private readonly reportExecutionUsage: ExecutionUsageReporter | undefined;
  /** bb retries a failed session/load with session/new on the same process.
   * Latch the failure so a missing Orb boundary can never fall back to Local. */
  private failedLoad: Error | null = null;
  /** Options this Amp CLI rejected; dropped from every later spawn. */
  private readonly retry = createRetryState();
  private shuttingDown = false;
  readonly sessions = new Map<string, SessionState>();

  constructor(client: BridgeClient, deps: BridgeDeps) {
    this.client = client;
    this.execute = deps.execute;
    this.createSteeringMonitor = deps.createSteeringMonitor;
    this.resolveInitialPermission = deps.resolveInitialPermission;
    this.resolveFastMode = deps.resolveFastMode;
    this.store = deps.store ?? memorySessionStore();
    this.oracleReports = deps.oracleReports ?? createFileOracleReportStore();
    this.orbProject = deps.orbProject?.trim() || undefined;
    this.reportExecutionUsage = deps.reportExecutionUsage;
    // AgentSideConnection invokes its agent factory before assigning its own
    // internal connection, so its signal getter is not readable until the
    // current constructor stack finishes.
    queueMicrotask(() => this.watchConnectionSignal());
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, embeddedContext: true },
        // Capabilities are agent-wide, while `/orb` is resolved on the first
        // prompt. Local accepts these transports; Orb uses its own Amp project
        // configuration and does not forward bb's MCP selection.
        mcpCapabilities: { http: true, sse: true },
      },
      // No authMethods: auth is handled by the Amp CLI (`amp login`) or
      // AMP_API_KEY in the provider env.
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  private async createState(
    cwd: string,
    mcpServers: McpServer[] | undefined | null,
    executionTarget: AmpExecutionTarget = "local",
  ): Promise<SessionState> {
    const mcpConfig = convertMcpServers(mcpServers);
    let steeringMonitor: SteeringInputMonitor | null = null;
    let permission: AmpPermissionMode = "default";
    try {
      steeringMonitor = (await this.createSteeringMonitor?.()) ?? null;
    } catch (error) {
      console.error(
        "[amp] could not initialize bb steering input; queued follow-ups remain available",
        error,
      );
    }
    try {
      permission = (await this.resolveInitialPermission?.()) ?? permission;
    } catch (error) {
      console.error("[amp] could not read bb permission; using Amp's normal rules", error);
    }
    return {
      cwd: cwd || process.cwd(),
      mcpConfig,
      executionTarget,
      executionAttempted: false,
      threadId: null,
      localRuntime: null,
      orbController: null,
      steeringMonitor,
      consumedSteeringInputs: [],
      restartLocalRuntime: false,
      cancelled: false,
      active: false,
      mode: "medium",
      permission,
      reportedMcpStatuses: new Set(),
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.failedLoad !== null) {
      throw new Error(
        `Amp refused bb's fresh Local fallback after a session/load failure: ${this.failedLoad.message} Start a new bb thread.`,
        { cause: this.failedLoad },
      );
    }
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const state = await this.createState(params.cwd, params.mcpServers);
    this.sessions.set(sessionId, state);
    return {
      sessionId,
      configOptions: buildConfigOptions(state),
    };
  }

  // Note: the ACP spec directs agents advertising loadSession to replay the
  // conversation history via session/update before returning. This bridge
  // intentionally skips the replay: bb (the only intended client) drops all
  // session/update notifications received while session/load is in flight,
  // and Amp itself re-hydrates the thread server-side via `continue`.
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    try {
      const binding = this.store.get(params.sessionId);
      if (!binding) {
        throw new Error(
          `Unknown session ${params.sessionId}: its saved Amp thread and execution target are missing or invalid.`,
        );
      }
      const state = await this.createState(params.cwd, params.mcpServers, binding.executionTarget);
      state.executionAttempted = true;
      state.threadId = binding.threadId;
      this.sessions.set(params.sessionId, state);
      this.reportUsage({
        sessionId: params.sessionId,
        executionTarget: binding.executionTarget,
        ampThreadId: binding.threadId,
      });
      return { configOptions: buildConfigOptions(state) };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failedLoad = failure;
      throw failure;
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const s = this.requireSession(params.sessionId);
    const value = params.value;
    let restartLocalRuntime = false;
    if (typeof value !== "string") {
      throw new Error(`Unsupported value for config option ${params.configId}`);
    }
    switch (params.configId) {
      case CONFIG_MODE:
        if (!AMP_MODES.some((m) => m.value === value)) {
          throw new Error(`Unsupported Amp mode: ${value}`);
        }
        restartLocalRuntime = s.mode !== value;
        s.mode = value;
        break;
      case CONFIG_REASONING:
        if (value !== "default") {
          throw new Error(`Unsupported reasoning mode: ${value}`);
        }
        break;
      case CONFIG_PERMISSION:
        if (value !== "default" && value !== "bypass") {
          throw new Error(`Unsupported permission mode: ${value}`);
        }
        if (s.executionTarget === "orb") {
          throw new Error("Amp Orb permissions are configured in the Amp project");
        }
        restartLocalRuntime = s.permission !== value;
        s.permission = value;
        break;
      default:
        throw new Error(`Unsupported config option: ${params.configId}`);
    }
    if (restartLocalRuntime && s.localRuntime !== null) {
      if (s.active) {
        // Execute options are process-wide. Preserve the active turn, then
        // restart lazily so the next prompt uses the new mode or permission.
        s.restartLocalRuntime = true;
      } else {
        await this.stopLocalRuntime(s, s.localRuntime);
      }
    }
    const configOptions = buildConfigOptions(s);
    await this.sendUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
    return { configOptions };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.requireSession(params.sessionId);
    if (this.shuttingDown) throw new Error("Amp bridge connection is closed");
    const consumedSteeringInput = s.consumedSteeringInputs[0];
    if (!s.active && consumedSteeringInput !== undefined) {
      if (sameContentBlocks(consumedSteeringInput, params.prompt)) {
        s.consumedSteeringInputs.shift();
        return { stopReason: "end_turn" };
      }
      s.consumedSteeringInputs = [];
    }
    const routed = routeAmpPrompt(params.prompt);
    if (routed.requestedTarget !== null && routed.directiveOnly) {
      throw new Error("Add instructions to the prompt with the /orb directive");
    }
    if (routed.requestedTarget === "orb" && s.executionTarget !== "orb") {
      if (s.executionAttempted || s.active || s.threadId !== null) {
        throw new Error(
          "This Amp thread already runs Local and cannot switch to Orb. Start a new bb thread and include /orb in its first prompt.",
        );
      }
      s.executionTarget = "orb";
    }
    const executionTarget = s.executionTarget;
    const firstExecution = !s.executionAttempted;
    s.executionAttempted = true;

    // Local only needs to clear a stale link once. Orb re-reports its durable
    // binding on every turn so a transient bb control-plane failure repairs
    // itself without requiring a bridge restart.
    if (firstExecution || executionTarget === "orb") {
      this.reportUsage({
        sessionId: params.sessionId,
        executionTarget,
        ampThreadId: s.threadId,
      });
    }

    return executionTarget === "local"
      ? this.promptLocal(params.sessionId, s, routed.prompt)
      : this.promptOrb(params.sessionId, s, routed.prompt);
  }

  private async promptLocal(
    sessionId: string,
    s: SessionState,
    prompt: string,
    retryLateTerminal = true,
  ): Promise<PromptResponse> {
    if (s.active) throw new Error("Amp received overlapping prompts for one session");
    s.cancelled = false;
    s.active = true;

    let runtime = s.localRuntime;
    let fast = false;
    let startRuntime = false;
    if (runtime === null || runtime.closed || runtime.conversation.aborted) {
      if (s.threadId === null) {
        try {
          fast = (await this.resolveFastMode?.()) ?? false;
        } catch (error) {
          console.error("[amp] could not read bb Fast mode; using standard service", error);
        }
      }
      if (s.cancelled || this.shuttingDown) {
        s.active = false;
        s.cancelled = false;
        return { stopReason: "cancelled" };
      }
      runtime = {
        conversation: this.createLocalConversation(s, fast),
        pump: Promise.resolve(),
        turn: null,
        closed: false,
      };
      s.localRuntime = runtime;
      startRuntime = true;
    }

    const turn = this.createLocalTurn(prompt, !startRuntime);
    runtime.turn = turn;
    this.startSteeringMonitor(sessionId, s, runtime, turn);
    if (runtime.conversation.closed) {
      await this.finishLocalTurn(
        sessionId,
        s,
        runtime,
        turn,
        null,
        new Error("Amp input closed before the prompt could be sent"),
      );
      await this.stopLocalRuntime(s, runtime);
    } else {
      // Settlement is driven by the output pump; the delivered promise's
      // close-time rejection is noise here.
      void runtime.conversation.send(prompt).catch(() => {});
      if (startRuntime) {
        runtime.pump = this.runLocalRuntime(sessionId, s, runtime);
        void runtime.pump.catch((error) => {
          console.error("[amp] Local output pump stopped unexpectedly", error);
        });
      }
    }
    try {
      return await turn.promise;
    } catch (error) {
      if (error !== RETRY_LOCAL_RUNTIME) throw error;
      if (retryLateTerminal && !this.shuttingDown) {
        return this.promptLocal(sessionId, s, prompt, false);
      }
      if (this.shuttingDown) return { stopReason: "cancelled" };
      throw new Error("Amp Local execution ended before it accepted the next prompt", {
        cause: error,
      });
    }
  }

  private async runLocalRuntime(
    sessionId: string,
    s: SessionState,
    runtime: LocalRuntime,
  ): Promise<void> {
    // Startup retries for unsupported CLI flags happen inside the
    // conversation; this pump only sees batches from an accepted spawn.
    try {
      for await (const batch of runtime.conversation.batches()) {
        const turn = runtime.turn;
        if (turn === null || turn.settled) {
          await this.handleIdleLocalMessage(sessionId, s, runtime, batch);
          continue;
        }
        if (turn.awaitingInputEcho) {
          const echoed = batch.events.some(
            (event) => event.kind === "userEcho" && event.text === turn.prompt,
          );
          if (echoed) {
            turn.awaitingInputEcho = false;
          } else if (batch.terminal) {
            await this.handleIdleLocalMessage(sessionId, s, runtime, batch);
            runtime.conversation.abort("restart");
            await this.finishLocalTurn(sessionId, s, runtime, turn, null, RETRY_LOCAL_RUNTIME);
            if (s.localRuntime === runtime) s.localRuntime = null;
            return;
          } else {
            await this.handleIdleLocalMessage(sessionId, s, runtime, batch);
            continue;
          }
        }
        this.clearLocalTurnTimer(turn);
        const terminalStop = await this.handleStreamMessage(sessionId, s, "local", turn, batch);
        if (batch.terminal) {
          turn.sawRuntimeTerminal = true;
          runtime.conversation.closeInput();
        }
        if (terminalStop !== null && runtime.turn === turn && !turn.settled) {
          turn.sawAssistantStop = true;
          turn.idleTimer = setTimeout(() => {
            turn.idleTimer = null;
            void this.finishLocalTurn(sessionId, s, runtime, turn, {
              stopReason: turn.softFailed ? "end_turn" : terminalStop,
            }).catch((error) => {
              console.error("[amp] failed to settle a Local turn", error);
            });
          }, STEERING_IDLE_MS);
        }
      }
    } catch (error) {
      await this.finishLocalRuntime(sessionId, s, runtime, error);
      return;
    }
    await this.finishLocalRuntime(sessionId, s, runtime, null);
  }

  private async promptOrb(
    sessionId: string,
    s: SessionState,
    prompt: string,
  ): Promise<PromptResponse> {
    if (s.active) throw new Error("Amp received overlapping prompts for one session");
    s.cancelled = false;
    s.active = true;
    // Startup retries for unsupported CLI flags happen inside runOrb.
    const run = runOrb({
      prompt,
      project: !s.threadId && this.orbProject !== undefined ? this.orbProject : null,
      continueFrom: s.threadId,
      shape: this.sessionShape(s, false),
      labels: [AMP_ACP_LABEL],
      deps: this.conversationDeps(),
    });
    s.orbController = run;
    const turn = this.createTurnOutputState();
    try {
      for await (const batch of run.batches()) {
        await this.handleStreamMessage(sessionId, s, "orb", turn, batch);
      }
      if (turn.executionError) throw turn.executionError;
      return {
        stopReason: s.cancelled ? "cancelled" : turn.softFailed ? "end_turn" : turn.stopReason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        s.cancelled ||
        (error instanceof Error && error.name === "AbortError") ||
        message.includes("aborted")
      ) {
        return { stopReason: "cancelled" };
      }
      if (isAuthError(message)) {
        throw new Error(`${message}\n${AUTH_HINT}`, { cause: error });
      }
      throw error;
    } finally {
      finishOpenOracleReports(
        turn.translationState,
        s.cancelled
          ? "Oracle execution was cancelled before returning a result."
          : "Oracle execution ended before returning a result.",
      );
      // Only clear state we still own: if a client ever overlapped prompts on
      // one session (bb serializes them today), a stale prompt finishing late
      // must not null the newer prompt's controller and break session/cancel.
      if (s.orbController === run) {
        s.active = false;
        s.cancelled = false;
        s.orbController = null;
      }
      // Amp emits system:init with a session_id at spawn, so this window is
      // tiny — but if the turn ended before any message carried one, the next
      // prompt silently starts a fresh Amp thread. Tell the user.
      if (!s.threadId) {
        await this.sendUpdate(
          this.textChunk(
            sessionId,
            "Note: this turn ended before Amp reported a thread id, so it could not be linked to an Amp thread; the next prompt starts a fresh one.",
          ),
        );
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s || !s.active) return;
    s.cancelled = true;
    const runtime = s.localRuntime;
    if (runtime !== null && runtime.turn !== null) {
      this.clearLocalTurnTimer(runtime.turn);
      runtime.turn.steeringController?.abort();
      runtime.conversation.abort("interrupt");
      return;
    }
    s.orbController?.abort();
  }

  /** Stop every persistent Local execution when the ACP connection closes. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (s.active) s.cancelled = true;
      const runtime = s.localRuntime;
      if (runtime !== null) {
        if (s.localRuntime === runtime) s.localRuntime = null;
        runtime.closed = true;
        runtime.conversation.abort("release");
        pending.push(runtime.pump);
      }
      s.orbController?.abort();
    }
    await Promise.allSettled(pending);
  }

  private watchConnectionSignal(): void {
    const signal = this.client.signal;
    if (!signal) return;
    const shutdown = () => {
      void this.shutdown().catch((error) => {
        console.error("[amp] failed to shut down after the ACP connection closed", error);
      });
    };
    if (signal.aborted) shutdown();
    else signal.addEventListener("abort", shutdown, { once: true });
  }

  /** Spawn configuration for one Local conversation. The shape snapshots
   * session controls at spawn time; execute options are process-wide, so a
   * mid-turn config change restarts the runtime instead of mutating this. */
  private createLocalConversation(s: SessionState, fast: boolean): AmpConversation {
    return createAmpConversation({
      shape: this.sessionShape(s, fast),
      continueFrom: s.threadId,
      mcpConfig: s.mcpConfig,
      labels: [AMP_ACP_LABEL],
      deps: this.conversationDeps(),
    });
  }

  private sessionShape(s: SessionState, fast: boolean): SessionShape {
    return {
      cwd: s.cwd,
      // Validated against AMP_MODES by setSessionConfigOption.
      mode: s.mode as SessionShape["mode"],
      // Always override the persisted Amp setting. bb Full force-allows all
      // tools; Accept Edits keeps Amp's normal rules and explicitly turns
      // off a user-level amp.dangerouslyAllowAll=true setting.
      dangerouslyAllowAll: s.permission === "bypass",
      fast,
      // ACP sessions carry no disallowed-tool list; the native session
      // layer (U5) fills these from BridgeExecutionOptions.
      denied: [],
      // The ACP path compares runtimes, not shapes; U5 computes digests.
      mcpConfigDigest: "",
    };
  }

  private conversationDeps(): AmpConversationDeps {
    return {
      execute: this.execute,
      // The ACP host wires the CLI path through process.env (bridge.ts).
      ampCliPath: null,
      env: { TERM: "dumb" },
      retry: this.retry,
    };
  }

  private createTurnOutputState(): TurnOutputState {
    return {
      translationState: {
        toolNamesById: new Map(),
        oracleReportByToolId: new Map(),
        oracleRootToolIds: new Set(),
        oracleReports: this.oracleReports,
      },
      stopReason: "end_turn",
      softFailed: false,
      executionError: null,
    };
  }

  private createLocalTurn(prompt: string, awaitingInputEcho: boolean): LocalTurn {
    let resolve!: (response: PromptResponse) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<PromptResponse>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return {
      ...this.createTurnOutputState(),
      promise,
      resolve,
      reject,
      prompt,
      awaitingInputEcho,
      idleTimer: null,
      steeringController: null,
      monitorPromise: null,
      sawAssistantStop: false,
      sawRuntimeTerminal: false,
      settled: false,
    };
  }

  private startSteeringMonitor(
    _sessionId: string,
    s: SessionState,
    runtime: LocalRuntime,
    turn: LocalTurn,
  ): void {
    if (s.steeringMonitor === null) return;
    const controller = new AbortController();
    turn.steeringController = controller;
    turn.monitorPromise = s.steeringMonitor
      .run((blocks) => {
        if (runtime.turn !== turn || turn.settled) return;
        const steering = routeAmpPrompt(blocks);
        // Execution target is fixed by the first prompt. Let bb's queued ACP
        // fallback report an invalid mid-thread /orb request instead.
        if (steering.requestedTarget !== null) return;
        if (runtime.conversation.closed) return;
        void runtime.conversation.send(steering.prompt, { steer: true }).catch(() => {});
        this.clearLocalTurnTimer(turn);
        s.consumedSteeringInputs.push(blocks);
      }, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("[amp] bb steering input monitor stopped", error);
        }
      });
  }

  private clearLocalTurnTimer(turn: LocalTurn): void {
    if (turn.idleTimer === null) return;
    clearTimeout(turn.idleTimer);
    turn.idleTimer = null;
  }

  private async finishLocalTurn(
    sessionId: string,
    s: SessionState,
    runtime: LocalRuntime,
    turn: LocalTurn,
    response: PromptResponse | null,
    failure?: unknown,
  ): Promise<void> {
    if (turn.settled || runtime.turn !== turn) return;
    turn.settled = true;
    this.clearLocalTurnTimer(turn);
    turn.steeringController?.abort();
    await turn.monitorPromise;
    finishOpenOracleReports(
      turn.translationState,
      response?.stopReason === "cancelled"
        ? "Oracle execution was cancelled before returning a result."
        : "Oracle execution ended before returning a result.",
    );

    if (response?.stopReason === "cancelled" || failure !== undefined) {
      s.consumedSteeringInputs = [];
    }
    if (!s.threadId) {
      await this.sendUpdate(
        this.textChunk(
          sessionId,
          "Note: this turn ended before Amp reported a thread id, so it could not be linked to an Amp thread; the next prompt starts a fresh one.",
        ),
      );
    }

    if (s.restartLocalRuntime) {
      s.restartLocalRuntime = false;
      if (s.localRuntime === runtime) s.localRuntime = null;
      runtime.closed = true;
      runtime.conversation.abort("restart");
    }
    const cancelled = s.cancelled || this.shuttingDown;
    runtime.turn = null;
    s.active = false;
    s.cancelled = false;

    if (failure !== undefined) {
      if (failure === RETRY_LOCAL_RUNTIME) {
        if (cancelled) turn.resolve({ stopReason: "cancelled" });
        else turn.reject(failure);
        return;
      }
      const error = failure instanceof Error ? failure : new Error(String(failure));
      if (isAuthError(error.message) && !error.message.includes(AUTH_HINT)) {
        turn.reject(new Error(`${error.message}\n${AUTH_HINT}`, { cause: error }));
      } else {
        turn.reject(error);
      }
      return;
    }
    turn.resolve(response ?? { stopReason: "end_turn" });
  }

  private async finishLocalRuntime(
    sessionId: string,
    s: SessionState,
    runtime: LocalRuntime,
    error: unknown,
  ): Promise<void> {
    runtime.conversation.closeInput();
    runtime.closed = true;
    try {
      const turn = runtime.turn;
      if (turn === null || turn.settled) {
        if (error !== null && !runtime.conversation.aborted) {
          console.error("[amp] Local execution stopped while idle", error);
        }
        return;
      }

      const message = error instanceof Error ? error.message : String(error ?? "");
      if (
        s.cancelled ||
        runtime.conversation.aborted ||
        (error instanceof Error && error.name === "AbortError") ||
        message.toLowerCase().includes("aborted")
      ) {
        await this.finishLocalTurn(sessionId, s, runtime, turn, { stopReason: "cancelled" });
        return;
      }

      const failure = turn.executionError ?? error;
      if (failure !== null) {
        await this.finishLocalTurn(sessionId, s, runtime, turn, null, failure);
        return;
      }
      if (!turn.sawAssistantStop && !turn.sawRuntimeTerminal) {
        await this.finishLocalTurn(
          sessionId,
          s,
          runtime,
          turn,
          null,
          new Error("Amp Local execution ended before the turn completed"),
        );
        return;
      }
      await this.finishLocalTurn(sessionId, s, runtime, turn, {
        stopReason: turn.softFailed ? "end_turn" : turn.stopReason,
      });
    } finally {
      if (s.localRuntime === runtime) s.localRuntime = null;
    }
  }

  private async stopLocalRuntime(s: SessionState, runtime: LocalRuntime): Promise<void> {
    if (s.localRuntime === runtime) s.localRuntime = null;
    runtime.closed = true;
    runtime.conversation.abort("release");
    await runtime.pump;
  }

  private async handleStreamMessage(
    sessionId: string,
    s: SessionState,
    executionTarget: AmpExecutionTarget,
    turn: TurnOutputState,
    batch: AmpEventBatch,
  ): Promise<StopReason | null> {
    if (!s.threadId && batch.ampThreadId !== null) {
      s.threadId = batch.ampThreadId;
      this.store.set(sessionId, {
        threadId: s.threadId,
        executionTarget,
      });
      this.reportUsage({
        sessionId,
        executionTarget,
        ampThreadId: s.threadId,
      });
      console.error(`[amp] thread ${s.threadId}`);
    }

    let terminalStop: StopReason | null = null;
    for (const event of batch.events) {
      switch (event.kind) {
        case "init": {
          const warning = this.mcpStatusWarning(s, event.mcpServers);
          if (warning) await this.sendUpdate(this.textChunk(sessionId, warning));
          break;
        }
        case "assistantStop":
          turn.stopReason = event.reason;
          terminalStop = event.reason;
          break;
        case "resultError": {
          // Error classification (auth, unsupported flag, turn limit) lives in
          // bridge/events.ts; this switch only decides how the turn settles.
          const hint = isAuthError(event.message) ? `\n${AUTH_HINT}` : "";
          await this.sendUpdate(this.textChunk(sessionId, `Error: ${event.message}${hint}`));
          if (event.subtype === "error_max_turns") {
            turn.stopReason = "max_turn_requests";
          } else if (event.subtype === "error_during_execution") {
            turn.softFailed = true;
          } else {
            turn.executionError = new Error(event.message);
          }
          break;
        }
        case "resultOk":
          if (event.denials.length > 0) {
            await this.reportPermissionDenials(sessionId, executionTarget, event.denials);
          }
          break;
        case "userEcho":
        case "usage":
        case "raw":
          break;
        default:
          for (const notification of toSessionUpdates(event, sessionId, turn.translationState)) {
            await this.sendUpdate(notification);
          }
          break;
      }
    }
    return terminalStop;
  }

  private async handleIdleLocalMessage(
    sessionId: string,
    _s: SessionState,
    runtime: LocalRuntime,
    batch: AmpEventBatch,
  ): Promise<void> {
    if (batch.terminal) {
      // Close synchronously before reporting denials: another ACP prompt can
      // arrive while sessionUpdate is in flight and must start a new process.
      runtime.closed = true;
      runtime.conversation.closeInput();
      console.error(
        "[amp] received terminal output after the ACP turn settled; restarting Local Amp",
      );
    }
    for (const event of batch.events) {
      if ((event.kind === "resultOk" || event.kind === "resultError") && event.denials.length > 0) {
        await this.reportPermissionDenials(sessionId, "local", event.denials);
      }
    }
  }

  private async reportPermissionDenials(
    sessionId: string,
    executionTarget: AmpExecutionTarget,
    denials: readonly string[],
  ): Promise<void> {
    const guidance =
      executionTarget === "orb"
        ? "Configure permissions in the Amp project settings."
        : 'Switch the Permissions option to "bypass" or adjust amp.permissions in Amp settings.';
    await this.sendUpdate(
      this.textChunk(
        sessionId,
        `Amp denied tool calls under its headless permission rules: ${denials.join(", ")}. ${guidance}`,
      ),
    );
  }

  private reportUsage(report: ExecutionUsageReport): void {
    if (!this.reportExecutionUsage) return;
    try {
      void Promise.resolve(this.reportExecutionUsage(report)).catch((error) => {
        console.error("[amp] failed to report execution usage", error);
      });
    } catch (error) {
      console.error("[amp] failed to report execution usage", error);
    }
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    return s;
  }

  private textChunk(sessionId: string, text: string): SessionNotification {
    return {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    };
  }

  private mcpStatusWarning(s: SessionState, servers: readonly AmpMcpServerStatus[]): string | null {
    const issues: string[] = [];
    for (const server of servers) {
      if (!MCP_ATTENTION_STATUSES.has(server.status)) continue;
      const key = `${server.name}\0${server.status}`;
      if (s.reportedMcpStatuses.has(key)) continue;
      s.reportedMcpStatuses.add(key);
      issues.push(`${server.name} (${server.status.replaceAll("-", " ")})`);
    }
    if (issues.length === 0) return null;
    const subject = issues.length === 1 ? "server needs" : "servers need";
    return `Amp MCP ${subject} attention: ${issues.join(", ")}.`;
  }

  private async sendUpdate(notification: SessionNotification): Promise<void> {
    try {
      await this.client.sessionUpdate(notification);
    } catch (error) {
      console.error("[acp] sessionUpdate failed", error);
    }
  }
}
