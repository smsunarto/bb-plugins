# bb-plugins

Monorepo for personal [bb](https://github.com/bb-app) plugins. One Bun workspace, one lockfile, one `node_modules`.

## Plugins

| Id | Path | What it does |
|---|---|---|
| `agent-proxy` | `plugins/agent-proxy` | Run and manage a local CLIProxyAPI core: OAuth accounts, upstream providers, usage, and agent wiring. |
| `amp` | `plugins/amp` | Registers Amp as a custom ACP provider through a bundled ACP bridge. |
| `dotfiles` | `plugins/dotfiles` | Browse, edit, render, and sync the dotfiles repo. |
| `gh-stack` | `plugins/gh-stack` | Visualize and drive stacked pull requests. |
| `notify` | `plugins/notify` | Desktop notifications when a thread finishes or fails, posted by the BB window itself. |
| `pr-walkthrough` | `plugins/pr-walkthrough` | Generate a human-friendly pull-request walkthrough with a built-in viewer panel. |
| `theme` | `plugins/theme` | Contributes Scott's Theme as a selectable palette (`plugin:theme:smsunarto`). |

The plugin id comes from the `name` field in each `package.json` with the `bb-plugin-` prefix removed. The directory name is not used.

## Setup

```sh
bun install          # one hoisted node_modules at the repo root
bun run build        # bb plugin build for every plugin
```

## Install into bb

Each plugin is installed as a local path source, so bb reads the files in place. Edit, rebuild, reload — no reinstall.

```sh
bb plugin install ./plugins/<name>
```

## Daily commands

| Command | Effect |
|---|---|
| `bun run build` | Build every plugin. |
| `bun run build:reload` | Build every plugin, then reload the ones installed in the running bb. |
| `bun run typecheck` | Type-check every plugin. |
| `bun run test` | Run tests (plugins that define a `test` script). |
| `bun run clean` | Remove every `dist/`. |
| `bun run sdk-types:check` | Verify vendored SDK `.d.ts` files match the pinned bb release. |
| `bun run sdk-types:refresh` | Regenerate vendored SDK `.d.ts` files after a bb upgrade. |
| `bun run --filter './plugins/<name>' build` | Build one plugin. |
| `bb plugin dev plugins/<name>` | Watch one plugin and hot-reload its frontend. |
| `bb plugin reload <id>` | Reload one plugin after a backend change. |
| `bb plugin logs <id>` | Tail one plugin's log. |

## Notes

- The bb release this repo tracks is pinned in `package.json` → `config.bbVersion`. CI installs that exact `bb-app` from npm; the `sdk-types:*` scripts refuse to run against a mismatched local bb.
- Each plugin's `types/bb-plugin-sdk*.d.ts` is generated from the pinned bb release — never hand-edited. `bun run sdk-types:refresh` regenerates them; CI runs `sdk-types:check`.
- `dist/` is generated and git-ignored. Run `bun run build` after a fresh clone.
- The root `overrides` entry replaces `@ampcode/cli` with a stub in `plugins/amp/vendor/`, so the Amp bridge resolves the real CLI from `AMP_CLI_PATH` instead of bundling one. Bun only honours `overrides` in the workspace root, so it must stay there.
- `plugins/pr-walkthrough/skills/pr-walkthrough/scripts/compile_walkthrough.py` (with its `guide_contract.py` sibling) compiles walkthrough MDX into the JSON the plugin's viewer panel renders. It is plain Python with no Node or frontend build behind it, so it is not covered by `bun run build`; the two modules resolve each other by sibling path and must stay together.
