# bb-plugin-amp

Registers [Amp](https://ampcode.com) as a custom ACP provider in bb. The plugin ships its own ACP bridge built on the official `@ampcode/sdk` — no third-party adapter (`amp-acp`) is required.

## Architecture

```
bb (ACP client, JSON-RPC over stdio)
  └─ spawns: node <plugin>/dist/bridge.js        (managed customAcpAgents entry)
       └─ ACP agent side: @agentclientprotocol/sdk (AgentSideConnection + ndJsonStream)
       └─ per prompt turn: @ampcode/sdk execute()  (one `amp --execute --stream-json-thinking` run)
            └─ Amp CLI, resolved via AMP_CLI_PATH   (set on the managed entry env)
```

- One `execute()` call per ACP prompt turn. The Amp thread id (`session_id` on every stream message) is captured from the first message and later turns pass `continue: <threadId>`, so a bb thread maps to a single Amp thread. `--no-archive-after-execute` keeps the thread continuable.
- Amp stream messages are translated to ACP `session/update` notifications: text → `agent_message_chunk`, thinking → `agent_thought_chunk` (the bridge always runs with `thinking: true`), `tool_use` → `tool_call`, `tool_result` → `tool_call_update`. Amp emits whole messages per line — there is no token-level streaming to forward.
- sessionId → Amp thread id mappings persist in `$XDG_STATE_HOME/bb-plugin-amp/sessions.json` (default `~/.local/state/...`), so bb thread resume (`session/load`) reconnects to the original Amp thread across bridge restarts.

### Config options exposed over ACP

| id | category | values | bb UI |
|---|---|---|---|
| `amp-mode` | `model` | low, medium, high, ultra | model picker, labelled `Medium (GPT 5.6 Sol · GPT 5.6 Sol)` |
| `permission` | `mode` | default, bypass | not rendered by bb today |

### Showing Amp's model in the picker

Mode labels carry the models Amp actually runs as a trailing parenthesised group — `Medium (GPT 5.6 Sol · GPT 5.6 Sol)`, reading `<agent> · <oracle>`. bb splits a model label on

```js
/^(.*\S)\s*\(([^()]+)\)$/   // -> { base, tag }; tag renders dimmed beside the name
```

in both the picker rows and the composer chip, so it displays as **Medium** GPT 5.6 Sol · GPT 5.6 Sol. This is the same mechanism behind Claude Code's `Opus 5 (1M)` rendering as `Opus 5 1M` — nothing provider-specific about it.

Constraints: the group must be last and must not contain parentheses of its own, or the label renders verbatim. The option *values* stay `low`/`medium`/`high`/`ultra`, so `--model medium` and the CLI flag are unaffected. `·` is used as the separator for that reason. Models come from [ampcode.com/modes](https://ampcode.com/modes) and are hand-maintained in `AMP_MODES`.

bb's host daemon caches ACP model discovery for 60s, so a label change takes up to a minute to appear.

### No reasoning option, and why the Reasoning row still appears

Amp selects its own model and effort per mode (see [ampcode.com/modes](https://ampcode.com/modes)) and the CLI has no `--effort` flag, so the bridge advertises no `thought_level` option and never sends an effort.

bb still renders a **Reasoning** row showing `Medium`. That cannot be suppressed from the agent side: for ACP providers bb substitutes a fixed fallback

```js
[{ reasoningEffort: "medium", description: "Reasoning effort is managed by the connected ACP agent." }]
```

in both of its model-discovery paths, and the row renders whenever that list is non-empty. The row is inert — nothing bb puts there reaches Amp.

Related: bb takes the reasoning label from a hardcoded table keyed by level (`none`/`low`/`medium`/`high`/`xhigh` → "Extra High"/…), not from anything the agent sends, so the slot cannot be repurposed to display other text. Only the **model** option's entry names are rendered verbatim.

### Why the bundle resolves the CLI from AMP_CLI_PATH

`@ampcode/sdk` prefers a require-resolvable `@ampcode/cli` package over `AMP_CLI_PATH`. This package uses an npm `overrides` entry that replaces `@ampcode/cli` with a local stub (`vendor/ampcode-cli-stub`), so that resolver returns null and the CLI configured by provisioning always wins (this also avoids installing a duplicate 70 MB CLI binary into `node_modules`).

## Requirements

- Node ≥ 20. The managed entry reuses whatever executable ran setup — that is bb's own Electron binary when setup runs inside the app, in which case the entry also sets `ELECTRON_RUN_AS_NODE=1`, since Electron otherwise launches the GUI instead of running the bridge script.
- Amp CLI installed (https://ampcode.com/manual#get-started) and authenticated: run `amp login` once, or set `AMP_API_KEY` in the managed entry env.
- bb ≥ 0.35.

## Install

```sh
cd bb-plugin-amp
npm install
npm run build          # bundles src/bridge.ts -> dist/bridge.js
bb plugin install . --yes
bb amp setup           # writes the managed customAcpAgents entry + logo, reloads bb config
bb amp status          # verify
```

`bb amp setup` writes this entry into `<bb data dir>/config.json` (merging over any existing `id: "amp"` entry, preserving unknown keys and env vars):

```json
{
	"id": "amp",
	"displayName": "Amp",
	"command": "<node used at setup time>",
	"args": ["<plugin dir>/dist/bridge.js"],
	"env": { "AMP_CLI_PATH": "<resolved amp binary>" },
	"logo": "logos/amp.svg"
}
```

## Development

```sh
npm test           # node --test (bridge core with a fake execute(), provisioning, stdio smoke test)
npm run typecheck  # tsc --noEmit
npm run build      # esbuild bundle
```

The bridge core (`src/bridge-core.ts`) takes `execute` as an injected dependency, so unit tests drive it with scripted async generators — no Amp CLI or network involved. The stdio smoke test spawns the real `dist/bridge.js` and performs a raw JSON-RPC `initialize` round-trip (it skips itself when the bundle is unbuilt).

## Troubleshooting

- **"Bridge bundle not found"** from `bb amp setup` — run `npm install && npm run build` in the plugin directory.
- **"Could not find a usable Amp CLI"** in a thread — the `AMP_CLI_PATH` in the managed entry no longer exists. Reinstall Amp, then rerun `bb amp setup`.
- **Auth errors in a thread** — run `amp login` in a terminal, or add `AMP_API_KEY` to the entry's `env` in `<bb data dir>/config.json`.
- **Tool calls silently rejected** — Amp's headless permission rules denied them (the bridge posts a notice listing the tools). Set the `permission` option to `bypass`, or adjust `amp.permissions` / `amp.commands.allowlist` in Amp settings.
- **Thread resume starts fresh with a warning** — the sessionId → thread mapping is missing from `~/.local/state/bb-plugin-amp/sessions.json` (e.g. pruned after 200 sessions, or removed).
- **Provider not listed** — `bb amp status` shows each link in the chain (CLI, bundle, config entry, logo, provider registration).
