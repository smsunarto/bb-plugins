<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Kitchen Sink

**Scott's kitchen sink of personal bb surfaces: composer commands, mentions, and Smart Embeds.**

![bb 0.41+](https://img.shields.io/badge/bb-0.41%2B-88C0D0?style=flat-square)

</div>

## What it does

bb's `/` menu lists skills, so each composer command ships as a skill under `skills/`. Mention providers live in `src/server/mentions.ts` and register on load.

| Command    | What the agent does                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ship-it` | Finds the repository's CI gates, runs them locally, commits this session's changes, then lands on `origin/main` for a personal GitHub repository or opens a pull request. |
| `/sync`    | Rebases the workspace onto the latest target branch and resolves every conflict by reading the intent of both sides.                                                      |

Both commands detect GitButler with `but status` and route every write through the `gitbutler` skill when it succeeds. Plain Git repositories use `git` and `gh`.

## Smart Embeds

Two message directives render project evidence inside assistant messages with [Diffs](https://diffs.com):

- `::smart-diff{path="src/example.ts" start="40" end="72"}` renders only the hunks that touch those lines of the changed file, with nearby context. Deleted lines count at the position where they used to be. This is the form the agent instructions ask for by default.
- `::smart-diff{path="src/example.ts"}` renders the whole file's branch and working-tree changes. Meant for a new file, or one whose diff is short enough to read at a glance.
- `::smart-code{path="src/example.ts" start="12" end="28"}` renders an exact code citation with nearby context.

Both directives resolve from the message thread's current workspace. Clicking the header opens the file in bb's workspace viewer.

The instructions the plugin injects into agents live in `SMART_EMBED_INSTRUCTIONS` in `src/server/server.ts`. They are measured, not guessed. `eval/METRIC.md` defines the metric and `eval/RESULTS.md` records the climb: leading with the ranged form took embed-score from 66.5% to 79.6% on Sonnet and from 68.1% to 84.7% on Opus. Change that text through the harness, not by hand. `eval/prompts/baseline.md` must stay byte-identical to the shipped constant, and a test enforces it.

Rendered embeds are cached in the browser for the page session, so remounts and thread revisits render at once. The server publishes a `workspace-changed` realtime signal when a thread goes idle, fails, is archived, or is deleted. Idle and failed refresh that thread's embeds in place. Archived and deleted free them. A realtime reconnect refreshes everything, and the cache also drops least recently used entries past 128 entries or 4 MB of patches.

## Add a command

Create `skills/<name>/SKILL.md` with `name` and `description` frontmatter. The test suite checks that the directory name matches the frontmatter name.

## Add a mention

Append a `PluginMentionProviderRegistration` to `mentionProviders` in `src/server/mentions.ts`. Ids must be unique within the plugin and contain no `:`.
