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
import {
  createUserMessage,
  type AmpOptions,
  type MCPConfig,
  type UserInputMessage,
} from "@ampcode/sdk";
import {
  finishOpenOracleReports,
  toSessionUpdates,
  type AmpStreamMessage,
  type TranslationState,
} from "./translate.ts";
import {
  createFileOracleReportStore,
  type OracleReportStore,
} from "./oracle-report-store.ts";
import { stripOrbDirectives } from "./orb-directive.ts";
import type { AmpExecutionTarget } from "./execution-target.ts";
import type { SteeringInputMonitor } from "./bb-steering-monitor.ts";
import type { AmpPermissionMode } from "./permission-mode.ts";
import { AMP_CLI_SHIM_FAST_ENV } from "./amp-cli-shim.ts";

/** Minimal slice of AgentSideConnection the core needs; injected for tests. */
export interface BridgeClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  signal?: AbortSignal;
}

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
}) => AsyncIterable<AmpStreamMessage>;

export interface SessionBinding {
  threadId: string;
  executionTarget: AmpExecutionTarget;
}

export interface ExecutionUsageReport {
  sessionId: string;
  executionTarget: AmpExecutionTarget;
  ampThreadId: string | null;
}

export type ExecutionUsageReporter = (
  report: ExecutionUsageReport,
) => void | Promise<void>;

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
  controller: AbortController;
  input: MultiTurnPrompt;
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
  orbController: AbortController | null;
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

const AUTH_HINT = "Amp authentication required: run `amp login` once, or set AMP_API_KEY in the provider env, then retry.";
export const AMP_ACP_LABEL = "via-amp-acp";
const STEERING_IDLE_MS = 250;
const RETRY_LOCAL_RUNTIME = Symbol("retry-local-runtime");

class MultiTurnPrompt {
  private readonly prompts: AmpUserInputMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private baseIndex = 0;
  private deliveredIndex = 0;
  private replayable = true;
  private closed = false;

  push(prompt: string, steer = false): boolean {
    if (this.closed) return false;
    const message = createUserMessage(prompt) as AmpUserInputMessage;
    this.prompts.push(steer ? { ...message, steer: true } : message);
    this.wake();
    return true;
  }

  /** Once Amp emits output, startup succeeded and no option retry can replay
   * accepted input. Drop delivered messages as the persistent stream advances. */
  commit(): void {
    if (!this.replayable) return;
    this.replayable = false;
    this.prune(this.deliveredIndex);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  async *stream(signal: AbortSignal): AsyncGenerator<AmpUserInputMessage> {
    let index = this.baseIndex;
    while (!signal.aborted) {
      while (index < this.baseIndex + this.prompts.length) {
        const prompt = this.prompts[index - this.baseIndex]!;
        index += 1;
        this.deliveredIndex = Math.max(this.deliveredIndex, index);
        if (!this.replayable) this.prune(index);
        yield prompt;
      }
      if (this.closed) return;
      await this.wait(signal);
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || this.closed) return resolve();
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

  private prune(index: number): void {
    const count = Math.min(index - this.baseIndex, this.prompts.length);
    if (count <= 0) return;
    this.prompts.splice(0, count);
    this.baseIndex += count;
  }
}

function sameContentBlocks(left: ContentBlock[], right: ContentBlock[]): boolean {
  return isDeepStrictEqual(left, right);
}

function echoedUserText(message: AmpStreamMessage): string | null {
  if (
    message.type !== "user"
    || (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null)
    || !Array.isArray(message.message?.content)
  ) {
    return null;
  }
  let text = "";
  for (const block of message.message.content) {
    if (
      block === null
      || typeof block !== "object"
      || Array.isArray(block)
      || (block as Record<string, unknown>).type !== "text"
      || typeof (block as Record<string, unknown>).text !== "string"
    ) {
      return null;
    }
    text += (block as { text: string }).text;
  }
  return text;
}

export function isAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid or missing api key") ||
    lower.includes("run 'amp login'") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("no api key found") ||
    (lower.includes("api key") && (lower.includes("missing") || lower.includes("invalid")))
  );
}

/** ACP McpServer[] (bb sends the stdio shape) -> Amp mcpConfig record. */
export function convertMcpServers(
  mcpServers: McpServer[] | undefined | null,
): MCPConfig {
  const config: MCPConfig = {};
  if (!Array.isArray(mcpServers)) return config;
  for (const server of mcpServers) {
    if ("type" in server) {
      if (server.type === "acp") continue;
      const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
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
      env: server.env.length > 0
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
      options: PERMISSION_MODES.map((p) => ({ value: p.value, name: p.name, description: p.description })),
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
const BB_ATTACHMENT_PLACEHOLDER_PATTERN = /^\[(?:image attachment|image attachment on disk|unreadable image attachment): [\s\S]*\]$/u;
const BB_PLUGIN_CONTEXT_PATTERN = /^Context for @[\s\S]+ \(resolved by plugin "[^"]+"\):\n\n/u;
const BB_AGENT_MESSAGE_PATTERN = /^\[bb message from thread:[^\]]+\]\n\n/u;
const BB_SYSTEM_MESSAGE_PATTERN = /^\[bb system\]\n\n/u;

function isBbDirectiveIneligibleText(text: string): boolean {
  return BB_ATTACHMENT_PLACEHOLDER_PATTERN.test(text)
    || BB_PLUGIN_CONTEXT_PATTERN.test(text)
    || BB_AGENT_MESSAGE_PATTERN.test(text)
    || BB_SYSTEM_MESSAGE_PATTERN.test(text)
    || text === "Please continue.";
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
        const isLeadingInstructions = index === 0
          && BB_SYSTEM_INSTRUCTIONS_PATTERN.test(block.text);
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

/**
 * Amp CLI flags the SDK may emit, mapped back to the execute() option that
 * produces them. An Amp CLI older than the SDK rejects unknown flags at argv
 * parse time ("error: unknown option '--effort'"), which would otherwise fail
 * every turn; the bridge drops the offending option and retries instead.
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
  const match = /unknown option\s+['"`‘’]?--([a-z0-9-]+)/i.exec(message);
  if (!match) return null;
  return FLAG_TO_OPTION[match[1].toLowerCase()] ?? null;
}

export class AmpBridgeAgent implements Agent {
  private readonly client: BridgeClient;
  private readonly execute: AmpExecuteFn;
  private readonly createSteeringMonitor:
    | (() => Promise<SteeringInputMonitor | null>)
    | undefined;
  private readonly resolveInitialPermission:
    | (() => Promise<AmpPermissionMode | null>)
    | undefined;
  private readonly resolveFastMode: (() => Promise<boolean>) | undefined;
  private readonly store: SessionStore;
  private readonly oracleReports: OracleReportStore;
  private readonly orbProject: string | undefined;
  private readonly reportExecutionUsage: ExecutionUsageReporter | undefined;
  /** bb retries a failed session/load with session/new on the same process.
   * Latch the failure so a missing Orb boundary can never fall back to Local. */
  private failedLoad: Error | null = null;
  /** Options this Amp CLI rejected; dropped from every later turn. */
  private readonly unsupported = new Set<keyof AmpExecuteOptions>();
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
      steeringMonitor = await this.createSteeringMonitor?.() ?? null;
    } catch (error) {
      console.error(
        "[amp] could not initialize bb steering input; queued follow-ups remain available",
        error,
      );
    }
    try {
      permission = await this.resolveInitialPermission?.() ?? permission;
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
      const state = await this.createState(
        params.cwd,
        params.mcpServers,
        binding.executionTarget,
      );
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
    if (runtime === null || runtime.closed || runtime.controller.signal.aborted) {
      if (s.threadId === null) {
        try {
          fast = await this.resolveFastMode?.() ?? false;
        } catch (error) {
          console.error("[amp] could not read bb Fast mode; using standard service", error);
        }
      }
      if (s.cancelled || this.shuttingDown) {
        s.active = false;
        s.cancelled = false;
        return { stopReason: "cancelled" };
      }
      const controller = new AbortController();
      runtime = {
        controller,
        input: new MultiTurnPrompt(),
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
    if (!runtime.input.push(prompt)) {
      await this.finishLocalTurn(
        sessionId,
        s,
        runtime,
        turn,
        null,
        new Error("Amp input closed before the prompt could be sent"),
      );
      await this.stopLocalRuntime(s, runtime);
    } else if (startRuntime) {
      runtime.pump = this.runLocalRuntime(sessionId, s, runtime, fast);
      void runtime.pump.catch((error) => {
        console.error("[amp] Local output pump stopped unexpectedly", error);
      });
    }
    try {
      return await turn.promise;
    } catch (error) {
      if (error !== RETRY_LOCAL_RUNTIME) throw error;
      if (retryLateTerminal && !this.shuttingDown) {
        return this.promptLocal(sessionId, s, prompt, false);
      }
      if (this.shuttingDown) return { stopReason: "cancelled" };
      throw new Error(
        "Amp Local execution ended before it accepted the next prompt",
        { cause: error },
      );
    }
  }

  private async runLocalRuntime(
    sessionId: string,
    s: SessionState,
    runtime: LocalRuntime,
    fast: boolean,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      let streamed = false;
      const attemptInputController = new AbortController();
      try {
        const stream = this.execute({
          prompt: runtime.input.stream(attemptInputController.signal),
          signal: runtime.controller.signal,
          options: this.buildExecuteOptions(s, fast),
        });
        for await (const message of stream) {
          streamed = true;
          runtime.input.commit();
          const runtimeTerminal = message.type === "result"
            || (message.type === "system"
              && message.subtype !== "init"
              && typeof message.error === "string");
          const turn = runtime.turn;
          if (turn === null || turn.settled) {
            await this.handleIdleLocalMessage(sessionId, s, runtime, message);
            continue;
          }
          if (turn.awaitingInputEcho) {
            if (echoedUserText(message) === turn.prompt) {
              turn.awaitingInputEcho = false;
            } else if (runtimeTerminal) {
              await this.handleIdleLocalMessage(sessionId, s, runtime, message);
              runtime.controller.abort();
              await this.finishLocalTurn(
                sessionId,
                s,
                runtime,
                turn,
                null,
                RETRY_LOCAL_RUNTIME,
              );
              if (s.localRuntime === runtime) s.localRuntime = null;
              return;
            } else {
              await this.handleIdleLocalMessage(sessionId, s, runtime, message);
              continue;
            }
          }
          this.clearLocalTurnTimer(turn);
          const terminalStop = await this.handleStreamMessage(
            sessionId,
            s,
            "local",
            turn,
            message,
          );
          if (runtimeTerminal) {
            turn.sawRuntimeTerminal = true;
            runtime.input.close();
          }
          if (terminalStop !== null && runtime.turn === turn && !turn.settled) {
            turn.sawAssistantStop = true;
            turn.idleTimer = setTimeout(() => {
              turn.idleTimer = null;
              void this.finishLocalTurn(
                sessionId,
                s,
                runtime,
                turn,
                { stopReason: turn.softFailed ? "end_turn" : terminalStop },
              ).catch((error) => {
                console.error("[amp] failed to settle a Local turn", error);
              });
            }, STEERING_IDLE_MS);
          }
        }
        await this.finishLocalRuntime(sessionId, s, runtime, null);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unsupported = unsupportedOptionFrom(message);
        if (
          unsupported
          && !streamed
          && attempt === 0
          && !runtime.controller.signal.aborted
          && !this.unsupported.has(unsupported)
        ) {
          this.unsupported.add(unsupported);
          console.error(
            `[amp] this Amp CLI rejects the flag generated by ${String(unsupported)}; dropping it and retrying. `
            + "Update the Amp CLI to use that control.",
          );
          continue;
        }
        await this.finishLocalRuntime(sessionId, s, runtime, error);
        return;
      } finally {
        attemptInputController.abort();
      }
    }
  }

  private async promptOrb(
    sessionId: string,
    s: SessionState,
    prompt: string,
  ): Promise<PromptResponse> {
    if (s.active) throw new Error("Amp received overlapping prompts for one session");
    s.cancelled = false;
    s.active = true;
    const controller = new AbortController();
    s.orbController = controller;
    const turn = this.createTurnOutputState();
    try {
      // Two attempts at most: the retry only fires when an older Amp CLI rejects
      // an option before streaming anything, so no output can be duplicated.
      for (let attempt = 0; ; attempt++) {
        let streamed = false;
        try {
          const stream = this.execute({
            prompt,
            signal: controller.signal,
            options: this.buildExecuteOptions(s, false),
          });
          for await (const message of stream) {
            streamed = true;
            await this.handleStreamMessage(sessionId, s, "orb", turn, message);
          }
          if (turn.executionError) throw turn.executionError;
          return {
            stopReason: s.cancelled
              ? "cancelled"
              : (turn.softFailed ? "end_turn" : turn.stopReason),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (s.cancelled || (error instanceof Error && error.name === "AbortError") || message.includes("aborted")) {
            return { stopReason: "cancelled" };
          }
          const unsupported = unsupportedOptionFrom(message);
          if (unsupported && !streamed && attempt === 0 && !this.unsupported.has(unsupported)) {
            this.unsupported.add(unsupported);
            console.error(
              `[amp] this Amp CLI rejects the flag generated by ${String(unsupported)}; dropping it and retrying. `
              + "Update the Amp CLI to use that control.",
            );
            continue;
          }
          if (isAuthError(message)) {
            throw new Error(`${message}\n${AUTH_HINT}`, { cause: error });
          }
          throw error;
        }
      }
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
      if (s.orbController === controller) {
        s.active = false;
        s.cancelled = false;
        s.orbController = null;
      }
      // Amp emits system:init with a session_id at spawn, so this window is
      // tiny — but if the turn ended before any message carried one, the next
      // prompt silently starts a fresh Amp thread. Tell the user.
      if (!s.threadId) {
        await this.sendUpdate(this.textChunk(
          sessionId,
          "Note: this turn ended before Amp reported a thread id, so it could not be linked to an Amp thread; the next prompt starts a fresh one.",
        ));
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
      runtime.input.close();
      runtime.controller.abort();
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
        runtime.input.close();
        runtime.controller.abort();
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

  private buildExecuteOptions(s: SessionState, fast: boolean): AmpExecuteOptions {
    const options: AmpExecuteOptions = {
      cwd: s.cwd,
      mode: s.mode,
      thinking: true,
      noArchiveAfterExecute: true,
      env: {
        TERM: "dumb",
        ...(fast && !s.threadId ? { [AMP_CLI_SHIM_FAST_ENV]: "1" } : {}),
      },
      labels: [AMP_ACP_LABEL],
    };
    if (s.executionTarget === "orb") {
      options.executor = "orb";
      // `project` selects the repository for a new Orb thread. A continued
      // thread already owns that selection, so do not send both controls.
      if (!s.threadId && this.orbProject !== undefined) {
        options.project = this.orbProject;
      }
    } else {
      // Always override the persisted Amp setting. bb Full force-allows all
      // tools; Accept Edits keeps Amp's normal rules and explicitly turns
      // off a user-level amp.dangerouslyAllowAll=true setting.
      options.dangerouslyAllowAll = s.permission === "bypass";
      if (Object.keys(s.mcpConfig).length > 0) options.mcpConfig = s.mcpConfig;
    }
    if (s.threadId) options.continue = s.threadId;
    for (const key of this.unsupported) delete options[key];
    return options;
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
    turn.monitorPromise = s.steeringMonitor.run((blocks) => {
      if (runtime.turn !== turn || turn.settled) return;
      const steering = routeAmpPrompt(blocks);
      // Execution target is fixed by the first prompt. Let bb's queued ACP
      // fallback report an invalid mid-thread /orb request instead.
      if (steering.requestedTarget !== null) return;
      if (!runtime.input.push(steering.prompt, true)) return;
      this.clearLocalTurnTimer(turn);
      s.consumedSteeringInputs.push(blocks);
    }, controller.signal).catch((error) => {
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
      await this.sendUpdate(this.textChunk(
        sessionId,
        "Note: this turn ended before Amp reported a thread id, so it could not be linked to an Amp thread; the next prompt starts a fresh one.",
      ));
    }

    if (s.restartLocalRuntime) {
      s.restartLocalRuntime = false;
      if (s.localRuntime === runtime) s.localRuntime = null;
      runtime.closed = true;
      runtime.input.close();
      runtime.controller.abort();
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
    runtime.input.close();
    runtime.closed = true;
    try {
      const turn = runtime.turn;
      if (turn === null || turn.settled) {
        if (error !== null && !runtime.controller.signal.aborted) {
          console.error("[amp] Local execution stopped while idle", error);
        }
        return;
      }

      const message = error instanceof Error ? error.message : String(error ?? "");
      if (
        s.cancelled
        || runtime.controller.signal.aborted
        || (error instanceof Error && error.name === "AbortError")
        || message.toLowerCase().includes("aborted")
      ) {
        await this.finishLocalTurn(
          sessionId,
          s,
          runtime,
          turn,
          { stopReason: "cancelled" },
        );
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

  private async stopLocalRuntime(
    s: SessionState,
    runtime: LocalRuntime,
  ): Promise<void> {
    if (s.localRuntime === runtime) s.localRuntime = null;
    runtime.closed = true;
    runtime.input.close();
    runtime.controller.abort();
    await runtime.pump;
  }

  private async handleStreamMessage(
    sessionId: string,
    s: SessionState,
    executionTarget: AmpExecutionTarget,
    turn: TurnOutputState,
    message: AmpStreamMessage,
  ): Promise<StopReason | null> {
    if (!s.threadId && typeof message.session_id === "string" && message.session_id.length > 0) {
      s.threadId = message.session_id;
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

    if (message.type === "system" && message.subtype === "init") {
      const warning = this.mcpStatusWarning(s, message);
      if (warning) await this.sendUpdate(this.textChunk(sessionId, warning));
    }

    if (message.type === "assistant" || message.type === "user") {
      const ampStopReason = message.message?.stop_reason;
      if (
        ampStopReason === "end_turn"
        || ampStopReason === "max_tokens"
        || ampStopReason === "refusal"
      ) {
        turn.stopReason = ampStopReason;
      }
      for (const notification of toSessionUpdates(message, sessionId, turn.translationState)) {
        await this.sendUpdate(notification);
      }
      return message.type === "assistant"
          && (ampStopReason === "end_turn"
            || ampStopReason === "max_tokens"
            || ampStopReason === "refusal")
        ? ampStopReason
        : null;
    }

    const isErrorMessage =
      (message.type === "result" && message.is_error === true)
      || (message.type === "system"
        && typeof message.error === "string"
        && message.subtype !== "init");
    if (isErrorMessage) {
      const error = typeof message.error === "string" ? message.error : "unknown error";
      const hint = isAuthError(error) ? `\n${AUTH_HINT}` : "";
      await this.sendUpdate(this.textChunk(sessionId, `Error: ${error}${hint}`));
      if (message.subtype === "error_max_turns") {
        turn.stopReason = "max_turn_requests";
      } else if (message.subtype === "error_during_execution") {
        if (isAuthError(error)) {
          turn.executionError = new Error(error);
        } else {
          turn.softFailed = true;
        }
      } else {
        turn.executionError = new Error(error);
      }
      return null;
    }

    if (
      message.type === "result"
      && Array.isArray(message.permission_denials)
      && message.permission_denials.length > 0
    ) {
      await this.reportPermissionDenials(sessionId, executionTarget, message.permission_denials);
    }
    return null;
  }

  private async handleIdleLocalMessage(
    sessionId: string,
    _s: SessionState,
    runtime: LocalRuntime,
    message: AmpStreamMessage,
  ): Promise<void> {
    const runtimeTerminal = message.type === "result"
      || (message.type === "system"
        && message.subtype !== "init"
        && typeof message.error === "string");
    if (runtimeTerminal) {
      // Close synchronously before reporting denials: another ACP prompt can
      // arrive while sessionUpdate is in flight and must start a new process.
      runtime.closed = true;
      runtime.input.close();
      console.error("[amp] received terminal output after the ACP turn settled; restarting Local Amp");
    }
    if (
      message.type === "result"
      && Array.isArray(message.permission_denials)
      && message.permission_denials.length > 0
    ) {
      await this.reportPermissionDenials(sessionId, "local", message.permission_denials);
    }
  }

  private async reportPermissionDenials(
    sessionId: string,
    executionTarget: AmpExecutionTarget,
    denials: string[],
  ): Promise<void> {
    const guidance = executionTarget === "orb"
      ? "Configure permissions in the Amp project settings."
      : "Switch the Permissions option to \"bypass\" or adjust amp.permissions in Amp settings.";
    await this.sendUpdate(this.textChunk(
      sessionId,
      `Amp denied tool calls under its headless permission rules: ${denials.join(", ")}. ${guidance}`,
    ));
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

  private mcpStatusWarning(s: SessionState, message: AmpStreamMessage): string | null {
    if (!Array.isArray(message.mcp_servers)) return null;
    const issues: string[] = [];
    for (const value of message.mcp_servers) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const server = value as Record<string, unknown>;
      if (typeof server.name !== "string" || typeof server.status !== "string") continue;
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
