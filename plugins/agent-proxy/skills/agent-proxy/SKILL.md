---
name: agent-proxy
description: Route Claude Code, Codex, Cursor BYOK, and OpenAI-compatible agents through the CLIProxyAPI proxy. Use for local endpoints and keys, the public Cursor Quick Tunnel, or proxy lifecycle work.
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

| Protocol                                         | Base URL (production default)  |
| ------------------------------------------------ | ------------------------------ |
| OpenAI-compatible (chat completions + responses) | `http://127.0.0.1:8317/v1`     |
| Anthropic (`/v1/messages`)                       | `http://127.0.0.1:8317`        |
| Gemini                                           | `http://127.0.0.1:8317/v1beta` |

Auth: pass the local API key as the bearer token / `x-api-key`.
Production defaults to port 8317. BB development instances derive a stable,
checkout-scoped port. Always read the live endpoint before wiring an agent.

## Cursor BYOK quick tunnel

Enable **Cloudflare Quick Tunnel for Cursor** in Agent Proxy settings. Then run:

```
bb agent-proxy endpoints
```

Use these values in Cursor BYOK:

- OpenAI base URL: the `public openai` value. It already ends in `/v1`.
- OpenAI API key: the `api key` value.

The setting is off by default. When it is off, Agent Proxy does not search for
`cloudflared`. When it is on, Agent Proxy keeps the core running and starts the
tunnel helper after the core.

The helper survives bb closing. Stop shuts down the helper before the core. A
core port change keeps the helper PID and public hostname. A helper restart gets
a new random hostname.

Quick Tunnels are for development. They do not support SSE. Some Cursor
requests may fail. This plugin release has not verified a live Cursor request.

Use `bb agent-proxy status` for the tunnel state. If `cloudflared` is missing,
install it and toggle the setting off and on. If the public endpoint returns
503, start the core or resolve its port conflict. The helper keeps the current
hostname during a temporary core outage. If the host runtime cannot run the
helper, update or reinstall bb, then toggle the setting off and on.

## Env recipes

- Claude Code: `ANTHROPIC_BASE_URL=<anthropic url> ANTHROPIC_AUTH_TOKEN=<key>`
- Codex CLI: `OPENAI_API_KEY=<key> codex -c 'openai_base_url="<openai url>"'`
- OpenAI-compatible SDKs: `OPENAI_BASE_URL=<openai url> OPENAI_API_KEY=<key>`
- Codex persistent: generated standalone `CODEX_HOME` (see the plugin's Agents page)

## CLI

```
bb agent-proxy status                 # core and tunnel state, versions, endpoints
bb agent-proxy start|stop|restart     # lifecycle
bb agent-proxy endpoints              # local and public URLs + local API key
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
- Never start `cloudflared` directly for this feature. The helper restricts the
  public gateway to `/v1` and checks the local bearer key before proxying.
- The proxy listens on 127.0.0.1 of the bb server machine only.
- Save custom GitHub repository and branch values on the Advanced page. A save
  does not replace the running binary; run Install core after the change.
- Do not write proxy settings into `~/.claude.json` or `~/.codex/config.toml`.
  Either may be generated (rendered from a dotfiles repo, for example), so an
  edit there can be overwritten or cause a conflict. Use the env recipes above.
