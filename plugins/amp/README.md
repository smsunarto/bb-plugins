<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Amp

**Run [Amp](https://ampcode.com) in a bb thread, like any built-in provider.**

![bb ≥ 0.36](https://img.shields.io/badge/bb-%E2%89%A5%200.36-88C0D0?style=flat-square)
![macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-3FA266?style=flat-square)
![needs Amp CLI](https://img.shields.io/badge/needs-Amp%20CLI-F1B467?style=flat-square)

</div>

<picture><img src="docs/media/hero.png" alt="Amp in bb: an /orb prompt to run in Amp&#39;s remote sandbox, the Orb session bar with its amp sync command, and an Oracle card" width="100%" /></picture>

bb talks to coding agents over the [Agent Client Protocol](https://agentclientprotocol.com).
This plugin makes Amp one of them.

It ships its own ACP bridge, built on the official `@ampcode/sdk`. Amp appears
in bb's provider list, runs against your bb environment by default, and can run
in an [Amp Orb](https://ampcode.com) cloud sandbox instead when you ask for one.

## Install

First make sure the [Amp CLI](https://ampcode.com/manual#get-started) is installed
and signed in — the plugin drives it and cannot install or authenticate it for you:

```sh
amp --version
amp login
```

**From npm** — one command:

```sh
bb plugin install npm:@smsunarto/bb-plugin-amp
```

**From source** — clone the repo and install the plugin as a local path
source. This is also how you install a change that is not released yet:

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-amp' build
bb plugin install ./plugins/amp
```

## Requirements

- bb ≥ 0.36, on macOS or Linux
- The **Amp CLI**, installed ([get started](https://ampcode.com/manual#get-started))
  and authenticated with `amp login`, or `AMP_API_KEY` set on the provider entry.
  The plugin locates and drives the CLI; it cannot install or sign in to it for you
- An Amp account

## Usage

Pick **Amp** in bb's provider list and start a thread. Everything below is
optional.

### Local and Orb

Amp runs against the bb environment's working directory. To use Amp Orb instead,
put `/orb` in the **first** prompt of a new thread:

```
/orb refactor the payment retry logic
```

**Local or Orb is fixed for the life of the thread.** A `/orb` in a later prompt
will not move an existing thread, so start a new one. Later prompts in an Orb
thread do not need the token.

An Orb thread shows a bar above the composer with the Amp thread id and a copyable
`amp sync T-…` command. Run that in a local checkout to mirror the Orb's live
working-tree changes. Orb brings its own tools, permissions, skills, and MCP
config; bb terminals, files, and diffs still point at the bb environment you
selected.

### Modes

Amp's four modes — low, medium, high, ultra — appear in bb's model picker, each
labelled with the "With ChatGPT Sub" routing as
`<agent> [<effort>] · <oracle> [<effort>]`.

### The Oracle card

When Amp calls its Oracle sub-agent, the thread shows a collapsible card with the
request, the response, and a trace that streams while it runs.

## Diagnostics

A healthy install does not need this command.

| Command | What it does |
|---|---|
| `bb amp status` | Print every link in the chain: Amp CLI, bridge bundle, node runtime, config entry, logo, and provider registration |

```console
$ bb amp status
Amp CLI: /Users/you/.local/bin/amp
bridge bundle: /path/to/plugins/amp/dist/bridge.js
node runtime: /Applications/bb.app/Contents/MacOS/bb (Electron; entry sets ELECTRON_RUN_AS_NODE=1)
config entry acp-amp: present
obsolete config entry acp-amp-orb: absent
logo: present
bb provider acp-amp: registered
auth: handled by the Amp CLI — run `amp login` once, or set AMP_API_KEY in the entry env
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin shows "needs configuration" | Install the Amp CLI, run `amp login`, then `bb plugin reload amp` |
| Amp is not in the provider list | `bb amp status` names the broken link |
| Auth errors in a thread | `amp login`, or add `AMP_API_KEY` to the provider entry's `env` |
| "Could not find a usable Amp CLI" | The recorded `AMP_CLI_PATH` no longer exists. Reinstall Amp, then run `bb plugin reload amp` |
| Local tool calls silently rejected | Amp's permission rules denied them — the bridge posts a notice naming the tools. Set `permission` to `bypass`, or adjust Amp's own settings |
| Orb tool calls rejected | Change the permission settings in the Amp project |
| Orb opens the wrong repository | Add `AMP_ACP_ORB_PROJECT` to the provider entry and start a new thread with `/orb` |
| `/orb` is rejected in a thread | That Amp thread is already Local. Start a new bb thread with `/orb` in its first prompt |
| `Unknown session <id>` on resume | The session mapping was pruned or removed. Start a new thread |

## Develop from source

Install from source as shown under [Install](#install). `bun run build` in
`plugins/amp` produces `dist/bridge.js` alongside `dist/server.js` and
`dist/app.js`.

Never run `npm install` inside `plugins/amp`. The root `overrides` entry that
keeps the real `@ampcode/cli` out of the tree only applies at the workspace
root, and a leaf install makes `@ampcode/sdk` prefer a CLI the plugin did not
configure.

`bb plugin install .` and `bb plugin dev` rebuild the frontend in place from the
published manifest entry, which drops the authored rules from `dist/app.css`.
Run `bun run build` again afterwards.

```sh
bun run typecheck
bun run test                # needs Node ≥ 22.6
```

Unit tests drive the bridge with scripted async generators, so they need no Amp
CLI and no network. The stdio test spawns the real `dist/bridge.js` and does a
JSON-RPC `initialize` round-trip, skipping itself when the bundle is unbuilt.
