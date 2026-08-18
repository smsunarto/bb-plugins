<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Agent Proxy

**Pool several Claude Code and Codex subscriptions, and load-balance across them.**

![bb ≥ 0.36](https://img.shields.io/badge/bb-%E2%89%A5%200.36-88C0D0?style=flat-square)
![macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-3FA266?style=flat-square)
![service](https://img.shields.io/badge/runs%20as-login%20service-F1B467?style=flat-square)

</div>

<picture><img src="docs/media/hero.png" alt="The Agent Proxy core page with the proxy running, beside bb's sidebar where the Agent Proxy row is tinted green while every other plugin stays grey" width="100%" /></picture>

Agent Proxy installs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) on
the machine that runs the bb server and gives it a management UI inside bb.

## Features

- **Pool several subscriptions** — authorize more than one Claude Code or Codex account and requests spread across every credential that matches the model. Round-robin by default; weighted and fill-first available.
- **Quota failover** — a 429 moves to the next account instead of failing the request.
- **One address for every provider** — Claude, Codex/ChatGPT, Gemini, and any OpenAI-compatible account on `http://127.0.0.1:8317`, translated across the OpenAI, Anthropic, and Gemini wire protocols.
- **Outlives bb** — the core runs as a login service, `launchd` on macOS and `systemd` on Linux, so it keeps serving after bb closes.
- **Green when it is up** — the sidebar row tints by core state: green running, amber starting or stopping, red crashed, dimmed when stopped.
- **One-click wiring** — point Claude Code, Codex, or anything else at the proxy without clobbering a config you generate yourself.
- **Installed and signed in from the panel** — one button for the core, browser OAuth for Claude and Codex, and each credential's quota state.

> **Stop is not permanent.** Stop disables the login job, but with `autostart` on
> (the default) the next bb start or `bb plugin reload` brings the core back. Turn
> `autostart` off for a stop that survives a reload.

| Client | What Apply does |
|---|---|
| **Claude Code** | Merges the base URL and token into `~/.claude/settings.json` after a timestamped backup. Restore reverts only the entries you have not since edited. `~/.claude.json` is never touched. |
| **Codex** | Gives you a copy-ready command or a generated `CODEX_HOME`. Never edits `~/.codex/config.toml`. |
| **Anything else** | The plain base URL and API key. |

## Install

**From the marketplace** — add this repository once, then install by name:

```sh
bb marketplace add git:github.com/smsunarto/bb-plugins
bb plugin install agent-proxy
```

bb resolves the newest `agent-proxy/vX.Y.Z` tag and builds the plugin from it against
your bb, so the bundle always matches the host it runs on. `bb plugin update
agent-proxy` follows the same release line. If another marketplace you have added
publishes a `agent-proxy`, spell it `agent-proxy@smsunarto`.

<details>
<summary>Installing the tag directly, without the marketplace</summary>

```sh
bb plugin install git:github.com/smsunarto/bb-plugins@semver:agent-proxy/:* --plugin agent-proxy
```

`*` always resolves the newest `agent-proxy/vX.Y.Z` tag; replace it with a range such
as `^0.2.0` to pin a line. `--plugin agent-proxy` names the entry of
[`.bb/plugins.json`](../../.bb/plugins.json) that points at this directory.

</details>

**From source** — clone the repo and install the plugin as a local path
source. This is also how you install a change that is not released yet:

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-agent-proxy' build
bb plugin install ./plugins/agent-proxy
```

The source path needs Bun and the `bb` CLI. It installs the plugin as a **local
path source**, so bb reads the files in place: edit, rebuild, reload, with no
reinstall.

## First run

Open **Agent Proxy** in bb's sidebar, press **Install core**, then sign in under
**OAuth** or paste API keys under **Providers**.

These two steps stay manual on purpose. The core is a separate program that the
plugin fetches or builds on your machine, and OAuth sign-in opens a browser.

## Requirements

- **macOS** with `launchd`, or **Linux** with a `systemd --user` session. The plugin refuses to load on anything else.
- `tar` on `PATH`.
- **Go 1.26+** — only if you build from a non-release ref. A published release needs no toolchain.
- Outbound HTTPS to GitHub, to fetch the core.
- At least one upstream account: a Claude or ChatGPT subscription for the OAuth flows, or an Anthropic / OpenAI / Gemini / OpenAI-compatible API key.
- A free TCP port on loopback (8317 by default). A conflict shows up as a crash loop on the Home page.

## Endpoints

| Protocol | Base URL |
|---|---|
| OpenAI-compatible | `http://127.0.0.1:8317/v1` |
| Anthropic (`/v1/messages`) | `http://127.0.0.1:8317` |
| Gemini | `http://127.0.0.1:8317/v1beta` |

The proxy listens on loopback of the bb server machine only.

## Commands

| Command | What it does |
|---|---|
| `bb agent-proxy status` | State, pid, port, service manager, definition path, installed and latest version, endpoints |
| `bb agent-proxy start` | Enable and start the login service |
| `bb agent-proxy stop` | Stop *and* disable the login service |
| `bb agent-proxy restart` | Rewrite the definition if it changed, then restart |
| `bb agent-proxy endpoints` | Print the three base URLs and the local API key |
| `bb agent-proxy install [ref]` | Install the configured source, or a one-off ref without changing the saved setting |
| `bb agent-proxy oauth <claude\|codex>` | Start a browser OAuth flow and poll for up to 3 minutes |
| `bb agent-proxy providers` | Count configured entries per collection, then list auth files |
| `bb agent-proxy usage` | Print the usage report as JSON |

## Settings

| Key | Default | Meaning |
|---|---|---|
| `autostart` | `true` | Keep the login service enabled, so the core starts at login and survives bb closing |
| `port` | `8317` | Listen port. Out-of-range or unparseable values fall back to 8317 |
| `sourceRepository` | `router-for-me/CLIProxyAPI` | Public GitHub source |
| `sourceBranch` | `latest` | `latest` resolves to the newest published release; or a branch, tag, or commit |
| `managementKey` | *(generated)* | Secret. Overrides the auto-generated management key |

Autostart applies immediately. The core reads the port and the management key only
at startup, so a change to either stops the service, rewrites `config.yaml`, and
restarts the service if it was running. A change made while the plugin is disabled
is applied on its next start.

## On disk

Everything lives under `<bb dataDir>/plugins/agent-proxy/`:

| Path | Contents |
|---|---|
| `core/auth/` | Your OAuth credentials |
| `core/secrets/` | Generated API keys |
| `backups/` | Timestamped copies of any file the plugin edits, taken before it writes |
| `core/service/core.log` | The log behind the Home page's tail |

Credentials and keys are written `0600` and never leave this directory — the
service definition holds only paths and service settings.

## Troubleshooting

- **Crash loop right after install** — usually a port conflict. Change `port`, or free 8317.
- **"Unavailable — is the core running?"** on OAuth, Providers, or Usage — those pages talk to the core's management API, so the core must be up first.
- **Removed the plugin, service still there** — the operating system owns the process by design. Run `bb agent-proxy stop` *before* you remove the plugin, or delete the definition by hand.
- **macOS Gatekeeper kills the binary** — it should not be quarantined, but if it happens: `xattr -d com.apple.quarantine <core/bin/current/cli-proxy-api>`.

## Develop from source

Install from source as shown under [Install](#install), then check a change
with:

```sh
bun run --filter '@smsunarto/bb-plugin-agent-proxy' typecheck
bun run --filter '@smsunarto/bb-plugin-agent-proxy' test
```

The test script needs Node 22.6+.
