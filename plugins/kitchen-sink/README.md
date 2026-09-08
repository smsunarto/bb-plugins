<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Kitchen Sink

**Scott's kitchen sink of personal bb surfaces: composer commands, mentions, Smart Embeds, and inline HTML visualizations.**

![bb 0.41+](https://img.shields.io/badge/bb-0.41%2B-88C0D0?style=flat-square)

</div>

## What it does

bb's `/` menu lists skills, so each composer command ships as a skill under `skills/`. Mention providers live in `src/server/mentions.ts` and register on load.

| Command    | What the agent does                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ship-it` | Finds the repository's CI gates, runs them locally, commits this session's changes, then lands on `origin/main` for a personal GitHub repository or opens a pull request. |
| `/sync`    | Rebases the workspace onto the latest target branch and resolves every conflict by reading the intent of both sides.                                                      |

Both commands detect GitButler with `but status` and route every write through the `gitbutler` skill when it succeeds. Plain Git repositories use `git` and `gh`.

## Thread motion

Kitchen Sink fades thread switches and smooths automatic timeline scrolling. See
[thread switching and scrolling](src/app/timeline-motion/README.md) for behavior and limitations.

## Smart Embeds

Three message directives render project evidence inside assistant messages with [Diffs](https://diffs.com):

- `::smart-diff{path="src/example.ts" start="40" end="72"}` renders only the hunks that touch those lines of the changed file, with nearby context. Deleted lines count at the position where they used to be. This is the form the agent instructions ask for by default.
- `::smart-diff{path="src/example.ts"}` renders the whole file's branch and working-tree changes. Meant for a new file, or one whose diff is short enough to read at a glance.
- `::smart-code{path="src/example.ts" start="12" end="28"}` renders an exact code citation with nearby context.
- `::smart-patch{file="proposal.patch" path="src/example.ts"}` renders a diff the agent has not applied yet. The agent writes a unified diff to `$BB_THREAD_STORAGE/proposal.patch` first. `path` picks one file out of a multi-file patch and can be left off when the patch touches exactly one. `start` and `end` trim it the same way `::smart-diff` does.

In a workspace without Git, `::smart-diff` shows the requested current code with a “No Git history” note. Without a line range, it previews the first 40 lines plus context. This code preview refreshes with workspace changes and is not saved as a historical diff. Workspace access failures still show their reported error.

`::smart-diff` saves its first successful display in plugin storage, separately for each message, file, and line range. That snapshot survives shipping, later workspace changes, page reloads, and plugin reloads. Empty results and errors remain retryable. A diff that has never displayed has no snapshot. Its first display reads the thread's current workspace, so it cannot recover changes already shipped before that display. Deleting a thread removes its snapshots.

`::smart-code` resolves from the message thread's current workspace. `::smart-patch` reads from the thread's storage directory, so it survives the worktree being deleted and never touches the repository. Clicking the header opens the file in bb's workspace viewer.

The instructions the plugin injects into agents live in `SMART_EMBED_INSTRUCTIONS` in `src/server/server.ts`. They are measured, not guessed. `eval/METRIC.md` defines the metric and `eval/RESULTS.md` records the climb: leading with the ranged form took embed-score from 66.5% to 79.6% on Sonnet and from 68.1% to 84.7% on Opus. Change that text through the harness, not by hand. `eval/prompts/baseline.md` must stay byte-identical to the shipped constant, and a test enforces it.

Rendered embeds are cached in the browser for the page session, so remounts and thread revisits render at once. The server publishes a `workspace-changed` realtime signal when a thread goes idle, fails, is archived, or is deleted. Idle and failed refresh that thread's embeds in place, with saved diffs returning their original snapshot. Archived and deleted free the browser entries. A realtime reconnect refreshes everything, and the cache also drops least recently used entries past 128 entries or 4 MB of patches.

## Inline visualizations

`::inline-vis{file="demo.html"}` renders a workspace-relative HTML file directly in an assistant message. An optional `height="480"` sets a 120–1200 pixel viewport. The default is 224 pixels.

Disable the standalone `inline-vis` plugin before enabling this renderer. bb leaves a directive literal when two plugins claim the same `inline-vis` message directive.

The server accepts only `.html` and `.htm` files up to 5 MiB, verifies the file through bb's root-confined workspace API, and then loads it from the thread's worktree route. Scripts run in a sandboxed opaque-origin iframe with `allow-scripts`, without `allow-same-origin`. The header action opens the original file in bb's workspace viewer.

This capability is forked from [`get-bb/bb/plugins/inline-vis`](https://github.com/get-bb/bb/tree/06aeaa994942ae7527dc49d2268c1f801e8542a0/plugins/inline-vis). Kitchen Sink replaces the upstream plugin's private `@bb/shared-ui` imports with package-owned markup and CSS so the external plugin remains SDK-only.

## Add a command

Create `skills/<name>/SKILL.md` with `name` and `description` frontmatter. The test suite checks that the directory name matches the frontmatter name.

## Add a mention

Append a `PluginMentionProviderRegistration` to `mentionProviders` in `src/server/mentions.ts`. Ids must be unique within the plugin and contain no `:`.

## Turn completion sound

Kitchen Sink plays Cursor's completion sound when a thread becomes idle, using
macOS `afplay` on the Mac running BB. It also plays while the thread is focused.
This uses the same sound asset as the retired Notify plugin and requires Cursor
at `/Applications/Cursor.app`. Other operating systems skip playback. Missing
assets or audio failures are logged without interrupting the agent. Plugin reload
or shutdown stops any sound still playing.
