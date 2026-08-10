---
name: agent-proxy
description: Route Claude Code, Codex, and OpenAI-compatible agents through the local CLIProxyAPI proxy managed by the agent-proxy plugin. Use when the user asks to route model traffic through the proxy, needs local proxy endpoints/keys, or wants to manage the proxy core.
---

# Agent Proxy (CLIProxyAPI)

The agent-proxy bb plugin manages a local CLIProxyAPI core on the bb server
machine as a persistent operating-system service: `launchd` on macOS, user
`systemd` on Linux. Windows is not supported. The core stays available when bb
is closed. It aggregates OAuth accounts (Claude, Codex) and upstream API keys
behind local endpoints with protocol conversion. The default source is
`router-for-me/CLIProxyAPI#latest`, where `latest` means the newest published
GitHub release; the plugin's Advanced page can select another public GitHub
repository and ref.

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
- Codex CLI: `OPENAI_API_KEY=<key> codex -c 'openai_base_url="<openai url>"'`
- OpenAI-compatible SDKs: `OPENAI_BASE_URL=<openai url> OPENAI_API_KEY=<key>`
- Codex persistent: generated standalone `CODEX_HOME` (see the plugin's Agents page)

## CLI

```
bb agent-proxy status                 # core state, versions, endpoints
bb agent-proxy start|stop|restart     # lifecycle
bb agent-proxy endpoints              # URLs + local API key
bb agent-proxy install [ref]          # install configured source (release archive, else source build); ref temporarily overrides branch
bb agent-proxy oauth <claude|codex>   # browser OAuth flow (prints URL, waits)
bb agent-proxy providers              # configured credentials + auth files
bb agent-proxy usage                  # recent request buckets (JSON)
```

The commands and plugin UI require bb to be running. Requests to the local
proxy endpoints do not. `Stop` disables and unloads the login service; `Start`
enables and loads it again.

## Rules

- Manage the core only through `bb agent-proxy` (or the plugin UI). Never spawn
  the `cli-proxy-api` binary directly and never edit its `config.yaml` by hand —
  the plugin and the core co-own that file.
- Never edit or load the generated service definition by hand. The plugin owns
  the macOS LaunchAgent or Linux user unit and reloads it when needed.
- The proxy listens on 127.0.0.1 of the bb server machine only.
- Save custom GitHub repository and branch values on the Advanced page. A save
  does not replace the running binary; run Install core after the change.
- Do not write proxy settings into `~/.claude.json` or `~/.codex/config.toml`.
  Either may be generated (rendered from a dotfiles repo, for example), so an
  edit there can be overwritten or cause a conflict. Use the env recipes above.
