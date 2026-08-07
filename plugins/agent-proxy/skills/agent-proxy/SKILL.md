---
name: agent-proxy
description: Route Claude Code, Codex, and OpenAI-compatible agents through the local CLIProxyAPI proxy managed by the agent-proxy plugin. Use when the user asks to route model traffic through the proxy, needs local proxy endpoints/keys, or wants to manage the proxy core.
---

# Agent Proxy (CLIProxyAPI)

The agent-proxy bb plugin runs a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
core on the bb server machine. It aggregates OAuth accounts (Claude, Codex) and
upstream API keys behind local endpoints with protocol conversion.

## Endpoints

Get live values (URLs + local API key) with:

```
bb agent-proxy endpoints
```

| Protocol | Base URL (default port 8317) |
| --- | --- |
| OpenAI-compatible (chat completions + responses) | `http://127.0.0.1:8317/v1` |
| Anthropic (`/v1/messages`) | `http://127.0.0.1:8317` |
| Gemini | `http://127.0.0.1:8317/v1beta` |

Auth: pass the local API key as the bearer token / `x-api-key`.

## Env recipes

- Claude Code: `ANTHROPIC_BASE_URL=<anthropic url> ANTHROPIC_AUTH_TOKEN=<key>`
- Codex / OpenAI SDKs: `OPENAI_BASE_URL=<openai url> OPENAI_API_KEY=<key>`
- Codex persistent: generated standalone `CODEX_HOME` (see the plugin's Agents page)

## CLI

```
bb agent-proxy status                 # core state, versions, endpoints
bb agent-proxy start|stop|restart     # lifecycle
bb agent-proxy endpoints              # URLs + local API key
bb agent-proxy install [version]      # install/update the core binary
bb agent-proxy oauth <claude|codex>   # browser OAuth flow (prints URL, waits)
bb agent-proxy providers              # configured credentials + auth files
bb agent-proxy usage                  # recent request buckets (JSON)
```

## Rules

- Manage the core only through `bb agent-proxy` (or the plugin UI). Never spawn
  the `cli-proxy-api` binary directly and never edit its `config.yaml` by hand —
  the plugin and the core co-own that file.
- The proxy listens on 127.0.0.1 of the bb server machine only.
- Do not write proxy settings into `~/.claude.json` or `~/.codex/config.toml`;
  those are rendered from the user's dotfiles repo. Use the env recipes above.
