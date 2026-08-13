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
}

/** Keep the injected seam testable while deriving its option contract from
 * the exact @ampcode/sdk version this plugin pins. */
export type AmpExecuteOptions = AmpOptions;

export type AmpExecutePrompt = string | AsyncIterable<UserInputMessage>;

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

interface SessionState {
  cwd: string;
  mcpConfig: MCPConfig;
  executionTarget: AmpExecutionTarget;
  executionAttempted: boolean;
  threadId: string | null;
  controller: AbortController | null;
  input: MultiTurnPrompt | null;
  steeringController: AbortController | null;
  steeringMonitor: SteeringInputMonitor | null;
  consumedSteeringInputs: ContentBlock[][];
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

class MultiTurnPrompt {
  private readonly prompts: string[];
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(initialPrompt: string) {
    this.prompts = [initialPrompt];
  }

  push(prompt: string): boolean {
    if (this.closed) return false;
    this.prompts.push(prompt);
    this.wake();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  async *stream(signal: AbortSignal): AsyncGenerator<UserInputMessage> {
    let index = 0;
    while (!signal.aborted) {
      while (index < this.prompts.length) {
        yield createUserMessage(this.prompts[index] ?? "");
        index += 1;
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
}

function sameContentBlocks(left: ContentBlock[], right: ContentBlock[]): boolean {
  return isDeepStrictEqual(left, right);
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
      controller: null,
      input: null,
      steeringController: null,
      steeringMonitor,
      consumedSteeringInputs: [],
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
    if (typeof value !== "string") {
      throw new Error(`Unsupported value for config option ${params.configId}`);
    }
    switch (params.configId) {
      case CONFIG_MODE:
        if (!AMP_MODES.some((m) => m.value === value)) {
          throw new Error(`Unsupported Amp mode: ${value}`);
        }
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
        s.permission = value;
        break;
      default:
        throw new Error(`Unsupported config option: ${params.configId}`);
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
    let fast = false;
    if (executionTarget === "local" && s.threadId === null) {
      try {
        fast = await this.resolveFastMode?.() ?? false;
      } catch (error) {
        console.error("[amp] could not read bb Fast mode; using standard service", error);
      }
    }
    const firstExecution = !s.executionAttempted;
    s.executionAttempted = true;
    s.cancelled = false;
    s.active = true;
    const controller = new AbortController();
    s.controller = controller;
    const input = executionTarget === "local" && s.steeringMonitor !== null
      ? new MultiTurnPrompt(routed.prompt)
      : null;
    s.input = input;
    const steeringController = input === null ? null : new AbortController();
    s.steeringController = steeringController;
    let closeInputTimer: ReturnType<typeof setTimeout> | null = null;
    const keepInputOpen = () => {
      if (closeInputTimer === null) return;
      clearTimeout(closeInputTimer);
      closeInputTimer = null;
    };
    const closeInputAfterIdle = () => {
      keepInputOpen();
      closeInputTimer = setTimeout(() => {
        closeInputTimer = null;
        input?.close();
      }, STEERING_IDLE_MS);
    };
    const monitorPromise = input !== null && steeringController !== null
      ? s.steeringMonitor?.run((blocks) => {
          const steering = routeAmpPrompt(blocks);
          // Execution target is fixed by the first prompt. Let bb's queued ACP
          // fallback report an invalid mid-thread /orb request instead.
          if (steering.requestedTarget !== null) return;
          if (!input.push(steering.prompt)) return;
          keepInputOpen();
          s.consumedSteeringInputs.push(blocks);
        }, steeringController.signal).catch((error) => {
          if (!steeringController.signal.aborted) {
            console.error("[amp] bb steering input monitor stopped", error);
          }
        })
      : undefined;
    const translationState: TranslationState = {
      toolNamesById: new Map(),
      oracleReportByToolId: new Map(),
      oracleRootToolIds: new Set(),
      oracleReports: this.oracleReports,
    };

    // Local only needs to clear a stale bar once. Orb re-reports its durable
    // binding on every turn so a transient bb control-plane failure repairs
    // itself without requiring a bridge restart.
    if (firstExecution || executionTarget === "orb") {
      this.reportUsage({
        sessionId: params.sessionId,
        executionTarget,
        ampThreadId: s.threadId,
      });
    }

    const buildOptions = (): AmpExecuteOptions => {
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
      if (executionTarget === "orb") {
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
    };

    let stopReason: StopReason = "end_turn";
    let preserveConsumedSteers = false;
    try {
      // Two attempts at most: the retry only fires when an older Amp CLI rejects
      // an option before streaming anything, so no output can be duplicated.
      for (let attempt = 0; ; attempt++) {
        let streamed = false;
        let softFailed = false;
        let executionError: Error | null = null;
        const attemptInputController = new AbortController();
        try {
          const stream = this.execute({
            prompt: input?.stream(attemptInputController.signal) ?? routed.prompt,
            signal: controller.signal,
            options: buildOptions(),
          });
          for await (const message of stream) {
            streamed = true;
            if (!s.threadId && typeof message.session_id === "string" && message.session_id.length > 0) {
              s.threadId = message.session_id;
              this.store.set(params.sessionId, {
                threadId: s.threadId,
                executionTarget,
              });
              if (executionTarget === "orb") {
                this.reportUsage({
                  sessionId: params.sessionId,
                  executionTarget,
                  ampThreadId: s.threadId,
                });
              }
              console.error(`[amp] thread ${s.threadId}`);
            }

            if (message.type === "system" && message.subtype === "init") {
              const warning = this.mcpStatusWarning(s, message);
              if (warning) await this.sendUpdate(this.textChunk(params.sessionId, warning));
            }

            if (message.type === "assistant" || message.type === "user") {
              const ampStopReason = message.message?.stop_reason;
              if (ampStopReason === "end_turn" || ampStopReason === "max_tokens" || ampStopReason === "refusal") {
                stopReason = ampStopReason;
                if (message.type === "assistant" && input !== null) {
                  // With streaming input, Amp does not emit its final result or
                  // exit until stdin closes. Leave a short window for a steer
                  // accepted alongside this completion, then signal EOF.
                  closeInputAfterIdle();
                }
              }
              for (const notification of toSessionUpdates(message, params.sessionId, translationState)) {
                await this.sendUpdate(notification);
              }
              continue;
            }

            const isErrorMessage =
              (message.type === "result" && message.is_error === true) ||
              (message.type === "system" && typeof message.error === "string" && message.subtype !== "init");
            if (isErrorMessage) {
              const error = typeof message.error === "string" ? message.error : "unknown error";
              const hint = isAuthError(error) ? `\n${AUTH_HINT}` : "";
              await this.sendUpdate(this.textChunk(params.sessionId, `Error: ${error}${hint}`));
              if (message.subtype === "error_max_turns") {
                stopReason = "max_turn_requests";
              } else if (message.subtype === "error_during_execution") {
                if (isAuthError(error)) {
                  executionError = new Error(error);
                } else {
                  softFailed = true;
                }
              } else {
                executionError = new Error(error);
              }
              continue;
            }

            if (message.type === "result" && Array.isArray(message.permission_denials)
              && message.permission_denials.length > 0) {
              const guidance = executionTarget === "orb"
                ? "Configure permissions in the Amp project settings."
                : "Switch the Permissions option to \"bypass\" or adjust amp.permissions in Amp settings.";
              await this.sendUpdate(this.textChunk(
                params.sessionId,
                `Amp denied tool calls under its headless permission rules: ${message.permission_denials.join(", ")}. `
                + guidance,
              ));
            }
          }
          if (executionError) throw executionError;
          const response: PromptResponse = {
            stopReason: s.cancelled ? "cancelled" : (softFailed ? "end_turn" : stopReason),
          };
          preserveConsumedSteers = response.stopReason !== "cancelled";
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (s.cancelled || (error instanceof Error && error.name === "AbortError") || message.includes("aborted")) {
            return { stopReason: "cancelled" };
          }
          const unsupported = unsupportedOptionFrom(message);
          if (unsupported && !streamed && attempt === 0 && !this.unsupported.has(unsupported)) {
            this.unsupported.add(unsupported);
            console.error(
              `[amp] this Amp CLI rejects the flag generated by ${unsupported}; dropping it and retrying. `
              + "Update the Amp CLI to use that control.",
            );
            continue;
          }
          if (isAuthError(message)) {
            throw new Error(`${message}\n${AUTH_HINT}`, { cause: error });
          }
          throw error;
        } finally {
          attemptInputController.abort();
        }
      }
    } finally {
      keepInputOpen();
      input?.close();
      steeringController?.abort();
      await monitorPromise;
      if (!preserveConsumedSteers) s.consumedSteeringInputs = [];
      finishOpenOracleReports(
        translationState,
        s.cancelled
          ? "Oracle execution was cancelled before returning a result."
          : "Oracle execution ended before returning a result.",
      );
      // Only clear state we still own: if a client ever overlapped prompts on
      // one session (bb serializes them today), a stale prompt finishing late
      // must not null the newer prompt's controller and break session/cancel.
      if (s.controller === controller) {
        s.active = false;
        s.cancelled = false;
        s.controller = null;
        s.input = null;
        s.steeringController = null;
      }
      // Amp emits system:init with a session_id at spawn, so this window is
      // tiny — but if the turn ended before any message carried one, the next
      // prompt silently starts a fresh Amp thread. Tell the user.
      if (!s.threadId) {
        await this.sendUpdate(this.textChunk(
          params.sessionId,
          "Note: this turn ended before Amp reported a thread id, so it could not be linked to an Amp thread; the next prompt starts a fresh one.",
        ));
      }
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    if (s.active && s.controller) {
      s.cancelled = true;
      s.input?.close();
      s.steeringController?.abort();
      s.controller.abort();
    }
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
