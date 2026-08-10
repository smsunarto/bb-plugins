# bb-plugins

Monorepo for personal [bb](https://github.com/bb-app) plugins. One Bun workspace, one lockfile, one `node_modules`.

## Plugins

| Id | Path | What it does |
|---|---|---|
| `agent-proxy` | `plugins/agent-proxy` | Run CLIProxyAPI as a persistent macOS or Linux service with OAuth accounts, providers, usage, and agent wiring. |
| `amp` | `plugins/amp` | Registers Amp as a custom ACP provider through a bundled ACP bridge. |
| `dotfiles` | `plugins/dotfiles` | Browse, edit, render, and sync the dotfiles repo. |
| `gh-stack` | `plugins/gh-stack` | Visualize and drive stacked pull requests. |
| `notify` | `plugins/notify` | Desktop notifications when a BB thread finishes or fails, plus a `notify_user` agent tool and a `bb notify` command. |
| `pr-walkthrough` | `plugins/pr-walkthrough` | Generate a human-friendly pull-request walkthrough with a built-in viewer panel. |
| `t3sidebar` | `plugins/t3sidebar` | Replace bb's sidebar thread list with an inbox of cards that never re-orders. Forked from bb's own example. |
| `theme` | `plugins/theme` | Ships Scott's Theme as a selectable BB palette. |

## Package naming

Use a hybrid convention:

| Package type | Package name | Directory |
|---|---|---|
| Installable bb plugin | `bb-plugin-<id>` | `plugins/<id>` |
| Shared non-plugin package | `@smsunarto/<name>` | `packages/<name>` |

For example, the Agent Proxy plugin is `bb-plugin-agent-proxy` in `plugins/agent-proxy`. bb derives `agent-proxy` from the package name by removing `bb-plugin-`; the directory name does not define its identity. Keep `@smsunarto/*` names for shared packages because scoped bb plugin names do not follow this id contract.

## Setup

```sh
bun install          # one hoisted node_modules at the repo root
bun run build        # bb plugin build for every plugin
```

## Install into bb

Each plugin is installed as a local path source, so bb reads the files in place. Edit, rebuild, reload — no reinstall.

```sh
bb plugin install ~/git/bb-plugins/plugins/<name>
```

## Daily commands

| Command | Effect |
|---|---|
| `bun run build` | Build every plugin. |
| `bun run build:reload` | Build every plugin, then reload the ones installed in the running bb. |
| `bun run dev` | Watch all plugins and reload each one after its files change; live watchers are not duplicated. |
| `bun run --filter 'bb-plugin-<name>' dev` | Watch one plugin and reload it after each change; no-op if its watcher is already running. |
| `bun run reload <id>` | Reload one plugin once. |
| `bun run logs <id> -f` | Follow one plugin's backend log. |
| `bun run typecheck` | Type-check every plugin. |
| `bun run test` | Run tests (plugins that define a `test` script). |
| `bun run clean` | Remove every `dist/`. |
| `bun run sdk-types:check` | Verify vendored SDK `.d.ts` files match the pinned bb release. |
| `bun run sdk-types:refresh` | Regenerate vendored SDK `.d.ts` files after a bb upgrade. |
| `bun run --filter 'bb-plugin-<name>' build` | Build one plugin. |

## Notes

- The bb release this repo tracks is pinned in `package.json` → `config.bbVersion`. CI installs that exact `bb-app` from npm; the `sdk-types:*` scripts refuse to run against a mismatched local bb.
- Each plugin's `types/bb-plugin-sdk*.d.ts` is generated from the pinned bb release — never hand-edited. `bun run sdk-types:refresh` regenerates them; CI runs `sdk-types:check`.
- `dist/` is generated and git-ignored. Run `bun run build` after a fresh clone.
- The root `overrides` entry replaces `@ampcode/cli` with a stub in `plugins/amp/vendor/`, so the Amp bridge resolves the real CLI from `AMP_CLI_PATH` instead of bundling one. Bun only honours `overrides` in the workspace root, so it must stay there.
- `plugins/pr-walkthrough/skills/pr-walkthrough/assets/site-template` is a payload template with its own nested `.gitignore`. Its build output is not tracked.
