<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Dotfiles

**Browse, edit, and sync one dotfiles repo from a bb panel.**

![personal](https://img.shields.io/badge/status-personal%20%C2%B7%20unsupported-E34671?style=flat-square)
![bb 0.37.x](https://img.shields.io/badge/bb-0.37.x-88C0D0?style=flat-square)
![macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-3FA266?style=flat-square)

</div>

> [!IMPORTANT]
> **Not released. Personal tooling, unsupported for external use.**
>
> This plugin is never tagged, so there is no release to install from. Install it
> from a source checkout, as shown below.
>
> The plugin is written against **one specific dotfiles repository layout** — a fixed
> set of file paths and a fixed set of `mise` task names. Against a differently shaped
> repo, every row reads `missing` and every task fails. Read it as a worked example of
> the bb plugin API, or fork it and replace the registry.

Turns a git-tracked dotfiles repository into a small editing console inside bb.

It lists the repo's hand-authored config files grouped by purpose, opens any of them in
an editor beside a live **diff against `git HEAD`**, and saves with a hash check so a
concurrent edit on disk cannot be silently overwritten. The same panel and a
`bb dotfiles` command run the repository's own `mise` tasks — render generated files,
run validation checks, preview an apply, pull published changes, or publish local ones
— and show the combined output when each task finishes.

## Requirements

- bb 0.37.x
- macOS or Linux. There is no Windows path
- `git` and `mise` on `PATH` inside the bb server host's login shell
- A dotfiles repository matching the layout this plugin expects, with the matching
  `mise` task set
- `npx` and network access, only for the Remove-skill control
- Bun, to build the plugin from the checkout

## Install

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-dotfiles' build
bb plugin install ./plugins/dotfiles
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `repoPath` | `~/git/dotfiles` | Path to the dotfiles repository **on the bb server host**. A leading `~` is expanded |

```sh
bb plugin config dotfiles set repoPath ~/path/to/your/dotfiles
```

The next panel or command request uses the new path; no reload is needed. `repoPath`
moves the root and the Skills group is rediscovered underneath it, but the other five
groups and every task name are fixed, so a differently shaped repo still reads
`missing`.

## Usage

Open the **Dotfiles** panel in bb, or run `bb dotfiles`.

- **File list.** Five fixed groups — agent config, settings overlays, shell, mise, repo
  policy — plus a Skills group scanned from the repo, so a new skill appears with no
  code change. Dirty files get an amber dot; absent files get a red `missing` badge.
- **Text editor and live diff.** The editor owns the working file while the diff compares
  it with `git show HEAD:<path>`. Unified and Split views update while you type, and a
  view toggle does not lose unsaved edits.
- **Compare-and-swap saves.** The sha256 recorded when the file was opened is passed to
  the write. If the file changed on disk, the save is refused instead of merged.
- **Stale-render warning.** Saving a file that feeds a generated consumer shows an amber
  line. Use the header's **render** action; render or publish clears the warning.
- **Task runner.** Fourteen tasks, five of them header buttons. Output is capped at
  200,000 characters, and a task is killed after 300 seconds.

Symlinked sources are live as soon as you save them. Settings overlays, MCP config, and
global agent instructions need `render` after a save.

Reads and writes are refused for any path outside the current file list, so neither the
panel nor the CLI can reach arbitrary files under the repo root.

### Commands

| Command | What it does |
|---|---|
| `bb dotfiles list` | Every tweakable file, grouped, with `[dirty]`, `[renders]`, and `[MISSING]` flags |
| `bb dotfiles status` | Branch, then porcelain git status, or `clean` |
| `bb dotfiles cat <path>` | Print one file from the list |
| `bb dotfiles render` | Run the repo's `render` task |
| `bb dotfiles check [target]` | Full validation, or one target |
| `bb dotfiles sync [--publish]` | Consume-only by default; `--publish` rebases and pushes |

> [!WARNING]
> The panel button labelled **sync** is the publishing one: it rebases and pushes. It is
> styled destructive and asks for a confirmation first.
>
> The **Remove skill** control shells out to the global `skills` CLI, which deletes the
> skill for every agent, not only inside `repoPath`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every row reads `missing`, branch reads `missing` | `repoPath` does not exist, or the repository does not match the expected layout |
| A task exits 127 with raw shell text | `mise`, `git`, or `npx` is not on `PATH` in the login shell the plugin resolved |
| A task appears to hang, then dumps all output at once | Expected. Output is buffered until the command exits. Tasks are killed at 300 seconds |
| "File changed on disk since you opened it" | The compare-and-swap refused the save. Reload the file and apply your edit again |

The login shell is resolved once, when the plugin loads. It uses `$SHELL` only when that
ends in `/fish`, then tries `/opt/homebrew/bin/fish`, `/usr/local/bin/fish`, and
`/usr/bin/fish`. A machine with no fish falls back to `/bin/sh -lc`, which reads neither
`~/.bashrc` nor `~/.zshrc` — so `mise` activation is commonly missed there. Install fish
or change `$SHELL`, then run `bb plugin reload dotfiles`.

## Development

```sh
bun install
bun run dev
bun ../../packages/bb-kit-cli/src/cli.ts check
BB_CLI=/absolute/path/to/bb-0.37.0 bun ../../packages/bb-kit-cli/src/cli.ts build
BB_CLI=/absolute/path/to/bb-0.37.0 bun ../../packages/bb-kit-cli/src/cli.ts verify
BB_CLI=/absolute/path/to/bb-0.37.0 bun ../../packages/bb-kit-cli/src/cli.ts doctor
```

The plugin is one bb-kit vertical module under `plugin/modules/dotfiles/`. Its six
operations are the source of truth for native RPC registration and TanStack Query
calls; `bb-kit.lock.json` keeps their wire names stable. Overview and publish use the
canonical `noInput`; the other operations have required literal examples. The
repository watcher builds and reloads the plugin after each source change.

bb-kit 0.1 accepts only bb CLI 0.37.0. `doctor` can use that CLI to report a newer
connected host, an installed source mismatch, or a failed plugin. It is an observation
step only; run the suggested query and UI checklist separately after the correct
checkout is installed and running.

BB supplies the read-only Pierre diff runtime. The text editor is plugin-owned because
BB does not expose Pierre's edit subpath from that same runtime; bundling a second copy
would split Pierre's internal state and break packaged source fallback.
