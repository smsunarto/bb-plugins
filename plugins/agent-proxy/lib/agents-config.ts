// Pure content transforms for wiring agent clients to the proxy. File IO stays
// in server.ts (bb.sdk.files with CAS for user-owned files) so these are
// trivially testable.
//
// Hard constraint: ~/.claude.json and ~/.codex/config.toml must never be
// touched. Either may be generated (rendered from a dotfiles repo, for
// example), so a write there can be clobbered or cause a conflict. Claude Code
// is wired through the env block of ~/.claude/settings.json; Codex through env
// vars or a generated standalone CODEX_HOME.

export const CLAUDE_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface ProxyTarget {
  baseUrl: string;
  token: string;
}

interface PreviousValue {
  present: boolean;
  value?: unknown;
}

export interface ClaudeEnvState {
  version: 1;
  applied: ProxyTarget;
  previous: {
    baseUrl: PreviousValue;
    token: PreviousValue;
  };
}

function parseSettings(content: string | null): Record<string, unknown> {
  if (content === null || content.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("~/.claude/settings.json is not valid JSON; refusing to modify it");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("~/.claude/settings.json is not a JSON object; refusing to modify it");
  }
  return parsed as Record<string, unknown>;
}

/** Merge the proxy env vars into the settings' env block, preserving every
    other key. Returns the new file content. */
export function applyClaudeEnv(content: string | null, target: ProxyTarget): string {
  const settings = parseSettings(content);
  const env =
    typeof settings.env === "object" && settings.env !== null && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: target.baseUrl,
    ANTHROPIC_AUTH_TOKEN: target.token,
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function previousValue(record: Record<string, unknown>, key: string): PreviousValue {
  return key in record ? { present: true, value: record[key] } : { present: false };
}

/** Capture the values Apply is about to replace. If the current values still
    match a prior application, retain its original baseline across target
    changes (for example, a proxy port change). */
export function captureClaudeEnvState(
  content: string | null,
  target: ProxyTarget,
  existing: ClaudeEnvState | null = null,
): ClaudeEnvState {
  const settings = parseSettings(content);
  const record =
    typeof settings.env === "object" && settings.env !== null && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  const previous =
    existing !== null && claudeApplied(content, existing.applied)
      ? existing.previous
      : {
          baseUrl: previousValue(record, "ANTHROPIC_BASE_URL"),
          token: previousValue(record, "ANTHROPIC_AUTH_TOKEN"),
        };
  return { version: 1, applied: target, previous };
}

function restoreValue(record: Record<string, unknown>, key: string, previous: PreviousValue): void {
  if (previous.present) record[key] = previous.value;
  else delete record[key];
}

/** Restore only values that still equal what Apply wrote. Values changed by
    the user since Apply are left untouched. */
export function restoreClaudeEnv(
  content: string | null,
  state: ClaudeEnvState,
): { content: string; changed: boolean; preservedUserChanges: boolean } {
  const settings = parseSettings(content);
  const env = settings.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return {
      content: `${JSON.stringify(settings, null, 2)}\n`,
      changed: false,
      preservedUserChanges: true,
    };
  }
  const record = env as Record<string, unknown>;
  let changed = false;
  let preservedUserChanges = false;
  if (record.ANTHROPIC_BASE_URL === state.applied.baseUrl) {
    restoreValue(record, "ANTHROPIC_BASE_URL", state.previous.baseUrl);
    changed = true;
  } else {
    preservedUserChanges = true;
  }
  if (record.ANTHROPIC_AUTH_TOKEN === state.applied.token) {
    restoreValue(record, "ANTHROPIC_AUTH_TOKEN", state.previous.token);
    changed = true;
  } else {
    preservedUserChanges = true;
  }
  if (Object.keys(record).length === 0) delete settings.env;
  return { content: `${JSON.stringify(settings, null, 2)}\n`, changed, preservedUserChanges };
}

export function claudeApplied(content: string | null, target: ProxyTarget): boolean {
  try {
    const settings = parseSettings(content);
    const env = settings.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
    const record = env as Record<string, unknown>;
    return (
      record.ANTHROPIC_BASE_URL === target.baseUrl &&
      record.ANTHROPIC_AUTH_TOKEN === target.token
    );
  } catch {
    return false;
  }
}

export const CODEX_ENV_KEY = "AGENT_PROXY_API_KEY";

/** Standalone CODEX_HOME config: guaranteed zero collision with the user's
    ~/.codex/config.toml, at the cost of not inheriting it. */
export function renderCodexConfig(openAiBaseUrl: string): string {
  return [
    "# Managed by bb-plugin-agent-proxy. Use via:",
    `#   CODEX_HOME=<this dir> ${CODEX_ENV_KEY}=<local api key> codex`,
    'model_provider = "agent-proxy"',
    "",
    "[model_providers.agent-proxy]",
    'name = "Agent Proxy (CLIProxyAPI)"',
    `base_url = ${JSON.stringify(openAiBaseUrl)}`,
    'wire_api = "responses"',
    `env_key = "${CODEX_ENV_KEY}"`,
    "",
  ].join("\n");
}
