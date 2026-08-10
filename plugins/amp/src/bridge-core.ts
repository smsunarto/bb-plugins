// Testable core of the Amp ACP bridge. The Amp SDK's execute() function is
// injected so unit tests can drive the agent with a fake async generator.
// bb is the only intended ACP client; the surface matches exactly what bb
// calls (see README architecture notes).
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
import type { AmpOptions, MCPConfig } from "@ampcode/sdk";
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

/** Minimal slice of AgentSideConnection the core needs; injected for tests. */
export interface BridgeClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
}

/** Keep the injected seam testable while deriving its option contract from
 * the exact @ampcode/sdk version this plugin pins. */
export type AmpExecuteOptions = AmpOptions;

export type AmpExecuteFn = (args: {
  prompt: string;
  signal?: AbortSignal;
  options?: AmpExecuteOptions;
}) => AsyncIterable<AmpStreamMessage>;

/** Persists ACP sessionId -> Amp thread id so session/load can resume a
 * thread across bridge restarts. Implementations must never throw. */
export interface SessionStore {
  get(sessionId: string): string | null;
  set(sessionId: string, threadId: string): void;
}

export const memorySessionStore = (): SessionStore => {
  const map = new Map<string, string>();
  return {
    get: (sessionId) => map.get(sessionId) ?? null,
    set: (sessionId, threadId) => void map.set(sessionId, threadId),
  };
};

export const CONFIG_MODE = "amp-mode";
export const CONFIG_PERMISSION = "permission";

/**
 * Mode names carry the model Amp runs as a trailing parenthesised group.
 *
 * bb splits a model label on `/^(.*\S)\s*\(([^()]+)\)$/` and renders the tail
 * dimmed next to the name — the same mechanism behind Claude Code's
 * "Opus 5 (1M)" showing as `Opus 5 1M`. The group must be last and must not
 * contain parentheses of its own, or the whole string renders verbatim.
 *
 * The badge reads `<agent> · <oracle>`. Models come from
 * https://ampcode.com/modes and need updating when Amp changes them. `·` is
 * deliberate: parentheses inside the group would defeat the split.
 */
export const AMP_MODES = [
  {
    value: "low",
    name: "Low (GLM 5.2 · GPT 5.6 Sol)",
    description: "Fast and economical for simple, well-defined tasks.",
  },
  {
    value: "medium",
    name: "Medium (GPT 5.6 Sol · GPT 5.6 Sol)",
    description: "Balanced capability and cost for everyday coding tasks.",
  },
  {
    value: "high",
    name: "High (GPT 5.6 Sol · Fable 5)",
    description: "Greater capability and reasoning for difficult tasks.",
  },
  {
    value: "ultra",
    name: "Ultra (Fable 5 · GPT 5.6 Sol)",
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
    description: "Force-allow every tool call (--dangerously-allow-all).",
  },
] as const;

interface SessionState {
  cwd: string;
  mcpConfig: MCPConfig;
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: string;
  permission: "default" | "bypass";
  reportedMcpStatuses: Set<string>;
}

export interface BridgeDeps {
  execute: AmpExecuteFn;
  store?: SessionStore;
  oracleReports?: OracleReportStore;
}

const AUTH_HINT = "Amp authentication required: run `amp login` once, or set AMP_API_KEY in the provider env, then retry.";
export const AMP_ACP_LABEL = "via-amp-acp";

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

/**
 * No `thought_level` option yet: the SDK supports explicit effort overrides,
 * but omission means "use the Amp mode default" and bb cannot represent that
 * state alongside explicit values. Advertising a recognized current value
 * would cause bb to send an override and silently change existing runs.
 */
function buildConfigOptions(s: SessionState): SessionConfigOption[] {
  return [
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
      id: CONFIG_PERMISSION,
      name: "Permissions",
      description: "Whether Amp applies its configured permission rules or force-allows all tools.",
      category: "mode",
      currentValue: s.permission,
      options: PERMISSION_MODES.map((p) => ({ value: p.value, name: p.name, description: p.description })),
    },
  ];
}

function flattenPrompt(blocks: ContentBlock[]): string {
  let text = "";
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        text += block.text;
        break;
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
  return text;
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
  private readonly store: SessionStore;
  private readonly oracleReports: OracleReportStore;
  /** Options this Amp CLI rejected; dropped from every later turn. */
  private readonly unsupported = new Set<keyof AmpExecuteOptions>();
  readonly sessions = new Map<string, SessionState>();

  constructor(client: BridgeClient, deps: BridgeDeps) {
    this.client = client;
    this.execute = deps.execute;
    this.store = deps.store ?? memorySessionStore();
    this.oracleReports = deps.oracleReports ?? createFileOracleReportStore();
  }


  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      // No authMethods: auth is handled by the Amp CLI (`amp login`) or
      // AMP_API_KEY in the provider env.
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  private createState(cwd: string, mcpServers: McpServer[] | undefined | null): SessionState {
    return {
      cwd: cwd || process.cwd(),
      mcpConfig: convertMcpServers(mcpServers),
      threadId: null,
      controller: null,
      cancelled: false,
      active: false,
      mode: "medium",
      permission: "default",
      reportedMcpStatuses: new Set(),
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const state = this.createState(params.cwd, params.mcpServers);
    this.sessions.set(sessionId, state);
    return { sessionId, configOptions: buildConfigOptions(state) };
  }

  // Note: the ACP spec directs agents advertising loadSession to replay the
  // conversation history via session/update before returning. This bridge
  // intentionally skips the replay: bb (the only intended client) drops all
  // session/update notifications received while session/load is in flight,
  // and Amp itself re-hydrates the thread server-side via `continue`.
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const threadId = this.store.get(params.sessionId);
    if (!threadId) {
      throw new Error(`Unknown session ${params.sessionId}: no Amp thread recorded for it`);
    }
    const state = this.createState(params.cwd, params.mcpServers);
    state.threadId = threadId;
    this.sessions.set(params.sessionId, state);
    return { configOptions: buildConfigOptions(state) };
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
      case CONFIG_PERMISSION:
        if (value !== "default" && value !== "bypass") {
          throw new Error(`Unsupported permission mode: ${value}`);
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
    s.cancelled = false;
    s.active = true;
    const controller = new AbortController();
    s.controller = controller;
    const translationState: TranslationState = {
      toolNamesById: new Map(),
      oracleReportByToolId: new Map(),
      oracleRootToolIds: new Set(),
      oracleReports: this.oracleReports,
    };

    const buildOptions = (): AmpExecuteOptions => {
      const options: AmpExecuteOptions = {
        cwd: s.cwd,
        mode: s.mode,
        thinking: true,
        noArchiveAfterExecute: true,
        env: { TERM: "dumb" },
        labels: [AMP_ACP_LABEL],
      };
      if (s.permission === "bypass") options.dangerouslyAllowAll = true;
      if (Object.keys(s.mcpConfig).length > 0) options.mcpConfig = s.mcpConfig;
      if (s.threadId) options.continue = s.threadId;
      for (const key of this.unsupported) delete options[key];
      return options;
    };

    let stopReason: StopReason = "end_turn";
    try {
    // Two attempts at most: the retry only fires when an older Amp CLI rejects
    // an option before streaming anything, so no output can be duplicated.
    for (let attempt = 0; ; attempt++) {
    let streamed = false;
    let executionError: Error | null = null;
    try {
      const stream = this.execute({
        prompt: flattenPrompt(params.prompt),
        signal: controller.signal,
        options: buildOptions(),
      });
      for await (const message of stream) {
        streamed = true;
        if (!s.threadId && typeof message.session_id === "string" && message.session_id.length > 0) {
          s.threadId = message.session_id;
          this.store.set(params.sessionId, s.threadId);
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
          if (message.subtype === "error_max_turns") {
            stopReason = "max_turn_requests";
          }
          const error = typeof message.error === "string" ? message.error : "unknown error";
          const hint = isAuthError(error) ? `\n${AUTH_HINT}` : "";
          await this.sendUpdate(this.textChunk(params.sessionId, `Error: ${error}${hint}`));
          if (message.subtype !== "error_max_turns") {
            executionError = new Error(error);
          }
          continue;
        }

        if (message.type === "result" && Array.isArray(message.permission_denials)
          && message.permission_denials.length > 0) {
          await this.sendUpdate(this.textChunk(
            params.sessionId,
            `Amp denied tool calls under its headless permission rules: ${message.permission_denials.join(", ")}. `
              + "Switch the Permissions option to \"bypass\" or adjust amp.permissions in Amp settings.",
          ));
        }
      }
      if (executionError) throw executionError;
      return { stopReason: s.cancelled ? "cancelled" : stopReason };
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
    }
    }
    } finally {
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
      s.controller.abort();
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
