<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Dotfiles

**Browse, edit, and sync one dotfiles repo from a bb panel.**

![personal](https://img.shields.io/badge/status-personal%20%C2%B7%20unsupported-E34671?style=flat-square)
![bb 0.47+](https://img.shields.io/badge/bb-0.47%2B-88C0D0?style=flat-square)
![macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-3FA266?style=flat-square)

</div>

> \[!IMPORTANT]
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

Every read, save, and task runs on one machine: the one picked in the panel, or the
thread's own machine for a `bb dotfiles` command an agent runs. The bb server, the
browser, and that machine can all be different computers.

## Requirements

- bb 0.47+
- macOS or Linux. There is no Windows path
- On each machine the panel acts on: `git` on the bb host daemon's `PATH`, and `mise`
  on `PATH` inside that machine's login shell
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

| Key        | Default          | Meaning                                                                                         |
| ---------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `repoPath` | `~/git/dotfiles` | Path to the dotfiles repository on the target machine. A leading `~` is that machine's home     |
| `hostId`   | empty            | The bb host the panel acts on. Set by the panel's machine menu. Empty means the bb server's own |

```sh
bb plugin config dotfiles set repoPath ~/path/to/your/dotfiles
```

One `repoPath` serves every machine, so keep it `~`-relative when the checkouts live at
the same place under each home. The next panel or command request uses the new path;
no reload is needed. `repoPath`
moves the root and the Skills group is rediscovered underneath it, but the other five
groups and every task name are fixed, so a differently shaped repo still reads
`missing`.

## Usage

Open the **Dotfiles** panel in bb, or run `bb dotfiles`.

- **Machine menu.** The Files tab header picks the machine and shows the repo path on
  it. The panel header names the machine too. An offline machine shows
  `<name> is not connected.` instead of an empty list.
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
- **Task runner.** Fourteen tasks, five of them header buttons, run on the panel's
  machine. Output is capped at 200,000 characters, and a task is killed after 300
  seconds.

Symlinked sources are live as soon as you save them. Settings overlays, MCP config, and
global agent instructions need `render` after a save.

Reads and writes are refused for any path outside the current file list, so neither the
panel nor the CLI can reach arbitrary files under the repo root.

### Commands

A command run from an agent's thread acts on that thread's machine. Outside a thread it
acts on the panel's machine. Each command prints `host: <machine> · repo: <path>` on
stderr, so stdout stays the command's own output.

| Command                        | What it does                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `bb dotfiles list`             | Every tweakable file, grouped, with `[dirty]`, `[renders]`, and `[MISSING]` flags |
| `bb dotfiles status`           | Branch, then porcelain git status, or `clean`                                     |
| `bb dotfiles cat <path>`       | Print one file from the list                                                      |
| `bb dotfiles render`           | Run the repo's `render` task                                                      |
| `bb dotfiles check [target]`   | Full validation, or one target                                                    |
| `bb dotfiles sync [--publish]` | Consume-only by default; `--publish` rebases and pushes                           |

> \[!WARNING]
> The panel button labelled **sync** is the publishing one: it rebases and pushes. It is
> styled destructive and asks for a confirmation first.
>
> The **Remove skill** control shells out to the global `skills` CLI on the panel's
> machine, which deletes the skill for every agent there, not only inside `repoPath`.

## Troubleshooting

| Symptom                                               | Cause                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Every row reads `missing`, branch reads `missing`     | `repoPath` does not exist on that machine, or the repo does not match the layout      |
| `<machine> is not connected`                          | That machine's bb host daemon is offline. Pick another machine or reconnect it        |
| A task exits 127 with raw shell text                  | `mise`, `git`, or `npx` is not on `PATH` in the login shell the plugin resolved       |
| A task appears to hang, then dumps all output at once | Expected. Output is buffered until the command exits. Tasks are killed at 300 seconds |
| "File changed on disk since you opened it"            | The compare-and-swap refused the save. Reload the file and apply your edit again      |

Tasks run through the target machine's login shell, resolved for each task. It uses
`$SHELL` only when that ends in `/fish`, then tries `/opt/homebrew/bin/fish`,
`/usr/local/bin/fish`, and `/usr/bin/fish`. A machine with no fish falls back to
`/bin/sh -lc`, which reads neither `~/.bashrc` nor `~/.zshrc` — so `mise` activation is
commonly missed there. Install fish or change `$SHELL` for the bb host daemon.

Git status and `HEAD` reads run `git` directly, never through the login shell, so shell
start-up errors cannot leak into the dirty list or the diff.

## Development

```sh
bun install
bun run dev        # watch + rebuild against the BB selected by the CLI
bun run lint
bun run typecheck
bun run test       # node --test --import tsx
bun run build      # bb plugin build . — needs the bb CLI on PATH
bun run verify     # lint + typecheck + tests + build
```

The plugin is written on the raw `@get-bb/plugin-sdk`. `src/server/server.ts` is the
composition root: it declares the RPC contract, registers each RPC handler and CLI
command, and wires Sentry reporting. `src/server/git.ts`
picks the target machine and reaches it. `src/host/host.ts` runs on every bb host
daemon and does the repo work there: git reads, skill discovery, `~` expansion, and
tasks. `src/shared/` holds the domain values and the host contract.
`src/server/rpc/` and `src/server/command/` hold one unit per file, with a test file
beside each unit; the RPC names are the procedures keys and are a stable public
contract. `src/app/` holds the panel app. The repository watcher builds and reloads the plugin after each source change.

The build and verify scripts call the bb CLI directly (`bb plugin build .`), so a
bb 0.44 checkout must be on PATH. Run the query and UI checklist against the dev
instance after the plugin is installed and running.

BB supplies the read-only Pierre diff runtime. All files, including Markdown, use
the CodeMirror source editor. No separate editor worker assets are required.
