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
import { toSessionUpdates, type AmpStreamMessage } from "./translate.ts";

/** Minimal slice of AgentSideConnection the core needs; injected for tests. */
export interface BridgeClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
}

/** Options the bridge passes to @ampcode/sdk execute(). Loose on purpose so
 * the core does not depend on the Amp SDK at runtime; the real execute()
 * validates with its own zod schema. */
export interface AmpExecuteOptions {
  cwd?: string;
  mode?: string;
  effort?: string;
  thinking?: boolean;
  noArchiveAfterExecute?: boolean;
  dangerouslyAllowAll?: boolean;
  continue?: boolean | string;
  mcpConfig?: Record<string, unknown>;
  env?: Record<string, string>;
}

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
  mcpConfig: Record<string, unknown>;
  threadId: string | null;
  controller: AbortController | null;
  cancelled: boolean;
  active: boolean;
  mode: string;
  permission: "default" | "bypass";
}

export interface BridgeDeps {
  execute: AmpExecuteFn;
  store?: SessionStore;
}

const AUTH_HINT = "Amp authentication required: run `amp login` once, or set AMP_API_KEY in the provider env, then retry.";

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
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (!Array.isArray(mcpServers)) return config;
  for (const server of mcpServers) {
    const raw = server as Record<string, unknown>;
    if ("type" in raw && raw.type !== undefined) {
      if (raw.type === "acp") continue;
      const headerList = Array.isArray(raw.headers)
        ? (raw.headers as { name: string; value: string }[])
        : [];
      const headers = Object.fromEntries(headerList.map((h) => [h.name, h.value]));
      config[String(raw.name)] = {
        url: raw.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
      continue;
    }
    const envList = Array.isArray(raw.env) ? (raw.env as { name: string; value: string }[]) : [];
    config[String(raw.name)] = {
      command: raw.command,
      args: raw.args,
      env: envList.length > 0 ? Object.fromEntries(envList.map((e) => [e.name, e.value])) : undefined,
    };
  }
  return config;
}

/**
 * No `thought_level` option: Amp picks its own models and effort per mode, and
 * the CLI has no `--effort` flag, so there is nothing to control. bb still
 * shows a Reasoning row — for ACP providers it falls back to a single entry
 * described as "managed by the connected ACP agent", and that row cannot be
 * suppressed from this side (bb hardcodes a non-empty effort list either way).
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
  mode: "mode",
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
  /** Options this Amp CLI rejected; dropped from every later turn. */
  private readonly unsupported = new Set<keyof AmpExecuteOptions>();
  readonly sessions = new Map<string, SessionState>();

  constructor(client: BridgeClient, deps: BridgeDeps) {
    this.client = client;
    this.execute = deps.execute;
    this.store = deps.store ?? memorySessionStore();
  }


  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
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
    return { configOptions: buildConfigOptions(s) };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.requireSession(params.sessionId);
    s.cancelled = false;
    s.active = true;
    const controller = new AbortController();
    s.controller = controller;

    const buildOptions = (): AmpExecuteOptions => {
      const options: AmpExecuteOptions = {
        cwd: s.cwd,
        mode: s.mode,
        thinking: true,
        noArchiveAfterExecute: true,
        env: { TERM: "dumb" },
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

        if (message.type === "assistant" || message.type === "user") {
          for (const notification of toSessionUpdates(message, params.sessionId)) {
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
          `[amp] this Amp CLI rejects --${unsupported}; dropping it and retrying. `
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

  private async sendUpdate(notification: SessionNotification): Promise<void> {
    try {
      await this.client.sessionUpdate(notification);
    } catch (error) {
      console.error("[acp] sessionUpdate failed", error);
    }
  }
}
