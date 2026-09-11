# Agent Proxy (deprecated)

Account pooling is now built into bb. The Account Pooler rotates Claude Code
and Codex accounts natively (`bb pool account`, `bb pool status`,
`bb pool routing <claude|codex>`). The standalone Agent Proxy plugin is retired
and has been removed from this repository's plugin catalogs and release
pipeline.

If you still have the old Agent Proxy plugin installed, un-wire your agents
before you disable or remove it from bb's plugin settings:

- Open the plugin's Agents page and restore Claude Code and Codex. The plugin
  wrote `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into
  `~/.claude/settings.json` and pointed Codex at a generated home under
  `~/.bb/plugins/agent-proxy`.
- If the plugin no longer loads, remove those two `env` keys from
  `~/.claude/settings.json` by hand and drop any `CODEX_HOME` pointing into
  `~/.bb/plugins/agent-proxy`.

Cursor BYOK and other OpenAI-compatible routing are no longer covered.
