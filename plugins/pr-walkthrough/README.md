<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# PR Walkthrough

**Read a pull request in the order it should be explained.**

![bb 0.40+](https://img.shields.io/badge/bb-0.40%2B-88C0D0?style=flat-square)
![macOS · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux-3FA266?style=flat-square)
![work in progress](https://img.shields.io/badge/status-work%20in%20progress-E5484D?style=flat-square)

</div>

> [!WARNING]
> **Work in progress. Not published, not supported, expect it to break.**
>
> This plugin is unfinished and is never tagged — there is no release to install
> from, and it is deliberately excluded from the release run. Install it from a
> source checkout with the steps below if you want to try it.
>
> Behaviour, commands, and the generated output all still change without notice.

A large pull request arrives as an alphabetical list of files. PR Walkthrough has an
agent read the change, split its files into a few semantic review groups ordered as an
implementation story, write an explanation for each, and compile the result next to real
diff hunks. bb renders that guide in a thread side panel.

Two ways to read the same change:

- **Normal** — complete changed files, in the authored order.
- **Guide** — exact diff excerpts, reordered into teaching phases with more rationale.

The panel tracks your reading progress and nothing else. No findings, no severities, no
approval verdicts. "Reviewed" means you read it.

## Requirements

|                    |                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| bb                 | 0.40+                                                                                                                            |
| Bun                | builds the plugin, and scaffolds, compiles, and validates the static site                                                        |
| Node.js            | 20.9+                                                                                                                            |
| git                | on `PATH`                                                                                                                        |
| `gh`               | optional. The only path to pull-request metadata and review comments. Without it the run falls back to the remote default branch |
| Browser automation | optional. Without it the run reports rendering as unverified                                                                     |

## Install

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-pr-walkthrough' build
bb plugin install ./plugins/pr-walkthrough
```

## Usage

Open a bb thread on the workspace that holds the change, then ask the agent:

> generate a PR walkthrough

The agent runs the bundled `pr-walkthrough` skill. When the build succeeds it emits a
`::pr-walkthrough` directive, which bb renders inline as an **Open walkthrough** card.
Open the card, or the **PR Walkthrough** tab in the thread side panel.

In the panel you can:

- Switch between **Normal** and **Guide** with the mode toggle.
- Switch each diff between **Unified** and **Split**.
- Open the changed-file tree and click a row to scroll to that file's diff.
- Show or hide generated files (lockfiles, snapshots, minified output, source maps).
- Mark files or excerpts as read. Progress is saved per browser, keyed by pull-request
  URL and head SHA, so a new commit starts a fresh pass.

The static site the skill also builds is optional. The panel does not need it: it reads
the compiled data over the bb SDK, so the panel works when the workspace is on a remote
host.

## Configuration

The plugin has no settings.

|                          |                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data directory           | Defaults to `.pr-walkthrough/site` in the workspace. The directive's `path` attribute can point somewhere else, but it must stay a relative path inside the workspace                                                                                                         |
| `--include-full-context` | Optional generation flag. It embeds the exact old and new file contents in the static site so the site can expand omitted hunks. That artifact is localhost-only: bind previews to loopback, never `0.0.0.0`, and regenerate without the flag before you host it on a network |

Do not hand-edit the compiled walkthrough JSON. The validator fails when the file is
older than its inputs.

## Troubleshooting

| Message or symptom                                                                              | What to do                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `No compiled walkthrough at ...`                                                                | The skill did not finish, or it wrote to a different directory. Ask the agent to run the pr-walkthrough skill again, then retry                 |
| `The compiled walkthrough data does not match the expected shape.`                              | Regenerate the walkthrough with the skill's scaffold step. Do not edit the JSON by hand                                                         |
| `The compiled walkthrough data is not valid JSON.`                                              | Same: regenerate it                                                                                                                             |
| `This thread has no workspace environment.` / `The thread's environment has no workspace path.` | Open the walkthrough from a thread that has a workspace                                                                                         |
| `The walkthrough path must be a workspace-relative directory.`                                  | The directive path is absolute or contains `..`. Regenerate the walkthrough                                                                     |
| No **Open walkthrough** card appears                                                            | The run reported rendering as unverified, usually because browser automation was unavailable. Open the **PR Walkthrough** panel tab directly    |
| Progress does not persist                                                                       | The panel shows a status line and a **Retry** / **Reset saved progress** row. Browser storage that cannot be read is never overwritten silently |
| The panel does not load                                                                         | `bb plugin logs pr-walkthrough`, then `bb plugin reload pr-walkthrough`                                                                         |
