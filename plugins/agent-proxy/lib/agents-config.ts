// Pure content transforms for wiring agent clients to the proxy. File IO stays
// in server.ts (bb.sdk.files with CAS for user-owned files) so these are
// trivially testable.
//
// Hard constraint: the user's ~/.claude.json and ~/.codex/config.toml are
// rendered from their dotfiles repo and must never be touched. Claude Code is
// wired through the env block of ~/.claude/settings.json; Codex through env
// vars or a generated standalone CODEX_HOME.

export const CLAUDE_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;

export interface ProxyTarget {
  baseUrl: string;
  token: string;
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

/** Remove exactly the two managed keys (dropping env entirely if it becomes
    empty). Safer than restoring a stale backup over interim user edits. */
export function stripClaudeEnv(content: string | null): { content: string; changed: boolean } {
  const settings = parseSettings(content);
  const env = settings.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return { content: `${JSON.stringify(settings, null, 2)}\n`, changed: false };
  }
  const record = env as Record<string, unknown>;
  let changed = false;
  for (const key of CLAUDE_ENV_KEYS) {
    if (key in record) {
      delete record[key];
      changed = true;
    }
  }
  if (Object.keys(record).length === 0) delete settings.env;
  return { content: `${JSON.stringify(settings, null, 2)}\n`, changed };
}

export function claudeApplied(content: string | null, baseUrl: string): boolean {
  try {
    const settings = parseSettings(content);
    const env = settings.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
    return (env as Record<string, unknown>).ANTHROPIC_BASE_URL === baseUrl;
  } catch {
    return false;
  }
}

export const CODEX_ENV_KEY = "AGENT_PROXY_API_KEY";

/** Standalone CODEX_HOME config: guaranteed zero collision with the
    dotfiles-rendered ~/.codex/config.toml, at the cost of not inheriting it. */
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
