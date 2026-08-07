# bb-plugins

Monorepo for personal [bb](https://github.com/bb-app) plugins. One Bun workspace, one lockfile.

## Plugins

| Id | Path | What it does |
|---|---|---|
| `agent-proxy` | `plugins/agent-proxy` | Runs and manages a local CLIProxyAPI core: install/supervise the binary, OAuth accounts, providers, usage, agent wiring. |
| `amp` | `plugins/amp` | Registers Amp as a custom ACP provider through a bundled ACP bridge. |
| `dotfiles` | `plugins/dotfiles` | Browse, edit, render, and sync the dotfiles repo. |
| `gh-stack` | `plugins/gh-stack` | Visualize and drive stacked pull requests. |
| `ghostty` | `plugins/ghostty` | Terminal tabs rendered by libghostty (WebAssembly) instead of the built-in terminal. |
| `notify` | `plugins/notify` | Desktop notifications when a thread finishes or fails, posted by the BB window itself. |
| `pr-walkthrough` | `plugins/pr-walkthrough` | Generate a human-friendly pull-request walkthrough with a built-in viewer panel. |
| `theme` | `plugins/theme` | Contributes Scott's Theme as a selectable palette (`plugin:theme:smsunarto`). |

The plugin id comes from the `name` field in each `package.json` with the `bb-plugin-` prefix removed. The directory name is not used.

## Setup

```sh
bun install          # one package store at the repo root, linked per plugin
bun run build        # bb plugin build for every plugin
```

Bun installs this workspace isolated: every dependency is unpacked once into
`node_modules/.bun/` and symlinked into the `plugins/<name>/node_modules` of
each plugin that declares it. A plugin therefore only resolves what its own
`package.json` lists — a missing dependency fails here rather than in bb.

## Install into bb

Each plugin is installed as a local path source, so bb reads the files in place. Edit, rebuild, reload — no reinstall.

```sh
bb plugin install ./plugins/<name>
```

## Daily commands

| Command | Effect |
|---|---|
| `bun run build` | Build every plugin. |
| `bun run typecheck` | Type-check every plugin. |
| `bun run lint` | Run oxlint over the repo (`lint:fix` to apply fixes). |
| `bun run test` | Run every plugin's tests (`amp`, `agent-proxy`, `notify`). |
| `bun run clean` | Remove every `dist/`. |
| `bun run --filter './plugins/<name>' build` | Build one plugin. |
| `bb plugin dev plugins/<name>` | Watch one plugin and hot-reload its frontend. |
| `bb plugin reload <id>` | Reload one plugin after a backend change. |
| `bb plugin logs <id>` | Tail one plugin's log. |

## Notes

- `dist/` is generated and git-ignored. Run `bun run build` after a fresh clone.
- The root `overrides` entry replaces `@ampcode/cli` with a stub in `plugins/amp/vendor/`, so the Amp bridge resolves the real CLI from `AMP_CLI_PATH` instead of bundling one. Bun only honours `overrides` in the workspace root, so it must stay there.
- `plugins/pr-walkthrough/skills/pr-walkthrough/scripts/compile_walkthrough.py` (with its `guide_contract.py` sibling) compiles walkthrough MDX into the JSON the plugin's viewer panel renders. It is plain Python with no Node or frontend build behind it, so it is not covered by `bun run build`; the two modules resolve each other by sibling path and must stay together.
