# bb-plugin-agent-proxy

EasyCLIProxyAPI, rebuilt as a bb plugin. Owns a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) core on the bb
server machine: installs the release binary, supervises the process, and
exposes management UI inside bb.

## Features

- **Core lifecycle** — download/update the release binary (sha256-verified,
  never auto-swapped), autostart on plugin load, crash restart with backoff,
  manual stop stays stopped. Home page + sidebar indicators + `bb agent-proxy` CLI.
- **Sidebar state** — the "Agent Proxy" row in bb's main sidebar is tinted by
  core state (green running, amber pulsing while starting/stopping, red
  crashed, dimmed stopped). bb renders that row itself and reads `navPanel`
  title/icon once, so a content script sets one `data-agent-proxy-state`
  attribute on it and `app.css` does the rest. Pushed instantly from
  `useCoreStatus` while a panel is mounted, with a 5s poll as the floor. It
  depends on host DOM internals (`[data-testid="plugin-nav-sidebar-items"]`
  and the row label), so it degrades to painting nothing if either changes.
- **OAuth** — Claude and Codex browser flows via the core's management API;
  auth-file list with enable/disable, delete, quota state, and quota reset.
- **Providers** — upstream credential collections (`claude-api-key`,
  `codex-api-key`, `gemini-api-key`, `openai-compatibility`) and proxy access
  keys, edited whole-array.
- **Usage** — the core's `api-key-usage` view (20 × 10-minute buckets per
  provider key). CLIProxyAPI removed durable per-request history in v6.10.0.
- **Agents** — zero-collision wiring for Claude Code (env block in
  `~/.claude/settings.json`, timestamped backups, restore removes only the
  managed keys) and Codex (env vars or a generated standalone `CODEX_HOME`).
  Never touches dotfiles-rendered `~/.claude.json` / `~/.codex/config.toml`.

## Layout on disk

`<bb dataDir>/plugins/agent-proxy/`:

- `core/bin/cli-proxy-api` + `core/bin/.version` — installed binary
- `core/config.yaml` — co-owned: plugin bootstraps it, the core bcrypt-hashes
  `secret-key` in place and persists management-API writes into it
- `core/auth/` — OAuth credential files (auth-dir)
- `core/secrets/` — generated management + local API keys (0600)
- `backups/` — timestamped copies of user files before the plugin writes them

## Settings

- `autostart` (default on) — start the core when the plugin loads
- `port` (default 8317)
- `managementKey` (secret, optional) — overrides the generated key

Port/key changes stop the core, rewrite `config.yaml` surgically, and restart
it if it was running.

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # node --test (release, config, install, supervisor, client, agents)
bun run build       # bb plugin build .
bb plugin install . # register in place; then: bb plugin dev
```

Note: the core binary is quarantine-free because it is written by node and
extracted with `tar`; if macOS Gatekeeper ever kills it on launch, run
`xattr -d com.apple.quarantine <core/bin/cli-proxy-api>`.
