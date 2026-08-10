# bb-plugin-agent-proxy

EasyCLIProxyAPI, rebuilt as a bb plugin. Owns a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
core on the bb server machine: installs the published release archive for the
platform, or builds the resolved commit with the local Go toolchain when the
ref ships none, runs it as a persistent
operating-system service, and exposes management UI inside bb. It uses
`launchd` on macOS and user `systemd` on Linux. The proxy continues to run
after bb exits. Windows is not supported.

## Features

- **Core lifecycle** — two install paths behind one Install core button. A ref
  that names a published release downloads that release's archive for the
  platform and verifies its sha256 against the release's own `checksums.txt`;
  any other ref (branch, commit, fork) downloads a commit-pinned source archive
  and builds it with Go. Either way the binary is published behind a stable
  pointer only after it lands. The pointer swap is atomic. A persistent
  operating-system service
  starts it at login, keeps it alive after bb exits, and restarts it after a
  crash. Manual Stop disables the service until Start or the autostart setting
  enables it again. Home page + sidebar indicators + `bb agent-proxy` CLI.
- **Advanced source settings** — change the GitHub repository and branch from
  the Advanced page. The defaults are `router-for-me/CLIProxyAPI#latest`, where
  the `latest` ref resolves to the newest published GitHub release (drafts and
  prereleases excluded) and then to that tag's commit. Saving a source does not
  change the running binary; Install core resolves and installs it.
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
  keys, edited whole-array with stale-write detection. The generated local key
  is always preserved.
- **Usage** — the core's `api-key-usage` view (20 × 10-minute buckets per
  provider key). CLIProxyAPI removed durable per-request history in v6.10.0.
- **Agents** — zero-collision wiring for Claude Code (env block in
  `~/.claude/settings.json`, timestamped backups, restore reinstates previous
  values without overwriting later user edits) and Codex (a per-invocation
  `openai_base_url` override or generated standalone `CODEX_HOME`).
  Never touches `~/.claude.json` / `~/.codex/config.toml`, so a generated one
  (rendered from a dotfiles repo, for example) stays intact.

## Layout on disk

`<bb dataDir>/plugins/agent-proxy/`:

- `core/bin/current` — stable pointer to the active binary + version marker
- `core/versions/` — immutable installed builds; binary and source-revision marker switch together
- `core/config.yaml` — co-owned: plugin bootstraps it, the core bcrypt-hashes
  `secret-key` in place and persists management-API writes into it
- `core/service/core.log` — bounded-read macOS/Linux log source for the Home page
- `core/service/runtime-fingerprint` — hash of the startup settings used by the running service
- `core/auth/` — OAuth credential files (auth-dir)
- `core/secrets/` — generated management + local API keys (0600)
- `backups/` — timestamped copies of user files before the plugin writes them
- `agents/claude-env-state.json` — private ownership metadata used for safe restore

The persistent service definition is platform-specific:

- macOS: `~/Library/LaunchAgents/com.smsunarto.bb.agent-proxy.plist`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/systemd/user/com.smsunarto.bb.agent-proxy.service`

Definitions contain only absolute paths and service settings. Credentials
remain under the core directory.

## Settings

- `autostart` (default on) — keep the login service enabled; it starts at login
  and remains active when bb is closed
- `port` (default 8317)
- `sourceRepository` (default `router-for-me/CLIProxyAPI`) — public GitHub source
- `sourceBranch` (default `latest`) — `latest` for the newest published release,
  or a branch, tag, or commit
- `managementKey` (secret, optional) — overrides the generated key

Autostart changes apply immediately. Port/key changes stop the service,
rewrite `config.yaml` surgically, and restart it if it was running. If these
settings change while the plugin is disabled, the applied runtime fingerprint
causes the same reconciliation on the next plugin start.

The macOS and Linux jobs run with `umask 077`; `core/auth/` is reconciled to
`0700` and existing OAuth credential files to `0600` on plugin load.

## Develop

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # node --test (release, config, install, supervisor, client, agents)
bun run build       # bb plugin build .
bb plugin install . # register in place; then: bb plugin dev
```

Go 1.26 or newer is required only for source builds — that is, for any ref that
ships no release archive for the platform. Installing a published release needs
no toolchain. The Advanced page accepts `owner/repository`, an HTTPS
`github.com` URL, or a `git@github.com` source. `bb agent-proxy install <ref>`
can temporarily install another branch, tag, or commit from the configured
repository without changing the saved source.

Persistent services support macOS (`launchd`) and Linux (user `systemd`). The
bb UI and `bb agent-proxy` commands require a running bb server,
but traffic through `127.0.0.1:8317` does not. Plugin reload, disable, and bb
shutdown stop only the plugin status monitor; they do not stop the operating-
system service.

Note: the core binary is quarantine-free either way — the Go toolchain writes
it directly, and a downloaded release archive is fetched and extracted without
LaunchServices. If macOS Gatekeeper ever kills it on launch, run
`xattr -d com.apple.quarantine <core/bin/cli-proxy-api>`.
