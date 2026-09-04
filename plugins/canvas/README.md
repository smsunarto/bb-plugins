<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Canvas

**Render `.canvas.mdx` files beside the chat as durable analytical artifacts.**

![bb 0.40+](https://img.shields.io/badge/bb-0.40%2B-88C0D0?style=flat-square)

</div>

## What it does

An agent writes one `.canvas.mdx` file. bb opens it beside the chat and renders markdown plus a fixed set of components. Tables, charts, callouts, stats, diffs, source excerpts, file links, and a few persisted controls. Nothing in the file runs. The server parses it, validates every component against a registry, and the app draws the result with the host theme.

- **Live.** The opener polls the file. A new write renders in about two seconds. A write that no longer parses keeps the last good render and shows a banner that names the line.
- **Safe.** Every prop value is a literal. Identifiers, calls, and expressions are rejected with a positioned diagnostic. There is no fetch and no code execution.
- **Forgiving.** An unknown component, a bad prop, or a disallowed child becomes a red problem card in place. The rest of the document still renders. The problem bar and each problem card switch to the raw source, and "Back to canvas" returns.
- **Persisted controls.** `Toggle`, `Select`, `Tabs`, and `Checklist` keep their state per file and control id across reloads.
- **Skill included.** The bundled `canvas` skill tells the agent when to use a canvas, where to write it, and how to check it.

## The sample canvas

[`examples/flaky-test-triage.canvas.mdx`](examples/flaky-test-triage.canvas.mdx) is the reference document the tests use.

```mdx
# Flaky test triage for bb-plugins CI

<Row gap="md">
  <Stat label="Runs sampled" value="200" caption="main, last 9 days" />
  <Stat label="Flaky suites" value="14" delta="+3" tone="warning" />
</Row>

<Callout tone="warning" title="One root cause, three symptoms">
  Every top offender calls `dev:setup` without releasing port 4317.
</Callout>

<BarChart
  title="Failure count by suite"
  xAxisLabel="Suite"
  yAxisLabel="Failures per 200 runs"
  categories={["dev-instance", "screenshots", "gtd-sidebar"]}
  series={[
    { name: "timeout", data: [41, 33, 22] },
    { name: "assertion", data: [3, 2, 9] },
  ]}
  caption="Source: gh run list --branch main --limit 200"
/>
```

## Components

| Component                               | Summary                                                                                                              | Persisted |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
| `Row`, `Grid`                           | Horizontal row or fixed column grid for layout.                                                                      | no        |
| `Card`, `Section`                       | Bordered or open container with an optional collapsible body.                                                        | no        |
| `Callout`                               | Toned note with an optional title.                                                                                   | no        |
| `Stat`                                  | One headline number with a label, caption, and delta.                                                                | no        |
| `Pill`                                  | Small toned label.                                                                                                   | no        |
| `Table`                                 | Data table with per column alignment and per row tone.                                                               | no        |
| `BarChart`, `LineChart`, `PieChart`     | Inline SVG charts with legends, axis labels, and reference lines.                                                    | no        |
| `UsageBar`                              | Segmented bar showing parts of a total.                                                                              | no        |
| `DiffView`, `Source`                    | Fenced diff rendered by Pierre's collapsible file diff in Pierre's own theme, or a code block in the bb code viewer. | no        |
| `FileLink`                              | Link that opens a file beside the chat, optionally at a line.                                                        | no        |
| `Ask`                                   | Button that opens a new chat with a prefilled prompt.                                                                | no        |
| `Toggle`, `Select`, `Tabs`, `Checklist` | Controls whose state persists per file.                                                                              | yes       |
| `Todos`                                 | Read only task list with a status icon per item.                                                                     | no        |

[`skills/canvas/reference.md`](skills/canvas/reference.md) lists every prop and one example per component. It is generated from `src/shared/registry.ts` by `bun run reference`.

## Styles

A canvas declares its look with frontmatter at the very top of the file.

```mdx
---
style: github
---
```

Two styles exist. `default` is the canvas prose look, and `github` renders the body the way GitHub renders a markdown file. Leave the frontmatter out for `default`.

## Templates

[`skills/canvas/templates/`](skills/canvas/templates/) holds two read-only starting points in the `github` style: `pull-request.canvas.mdx` and `issue.canvas.mdx`. The skill tells the agent to write a copy to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx` and replace every sample value.

## How a canvas opens

A canvas link in the chat opens a file tab in the thread's side panel, and for a `.canvas.mdx` file that tab renders the canvas. Any other `.mdx` file shows the default preview with an `Open as canvas` button.

## Where canvases live

The skill writes to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx`. That directory belongs to the thread, so the file survives the conversation without touching the repo. A canvas goes into the worktree only when the user wants it committed. The `.canvas.mdx` suffix is required. Any `.mdx` file still shows an "Open as canvas" button.

## Comments

A reader can leave Google Docs style comments on a rendered canvas, and the agent reads and answers them from the CLI.

**In the pane.** Hover any block and a small comment button appears at its right edge. Select text inside a block and a floating "Comment" button appears next to the selection. Either one opens a composer directly under the block. A commented block gets a subtle tint and a count badge, and its threads sit under it as collapsed cards (author, relative time, first line, reply count). Click a card to read the replies, reply, or resolve. Resolved threads hide behind the toolbar's "Show resolved (n)" toggle. When an edit removes the block a thread pointed at, the thread moves to a "Detached comments" section at the end of the canvas with its saved quote.

**From the CLI.** The agent lists comments with where each one sits now, then replies or resolves as `agent`.

```
bb canvas comments /abs/path/report.canvas.mdx            # open threads, in block order
bb canvas comments /abs/path/report.canvas.mdx --all      # resolved ones too
bb canvas comments /abs/path/report.canvas.mdx --json     # {path, sidecarPath, parses, threads: [{thread, match, context}]}
bb canvas comment  /abs/path/report.canvas.mdx cmt_7f3k2a9x1p --reply "Verified 4m02s, table fixed." --resolve
bb canvas comment  /abs/path/report.canvas.mdx cmt_7f3k2a9x1p --reopen
```

`bb canvas comments` exits 0 whether or not comments exist. A thread line names the block (`block 4 Table "Top offenders"`), adds `edited since` when the block changed under the comment, and shows the exact `quote` or, for a detached thread, what the block `was`. For thread-storage canvases, the agent's thread instructions also gain an "Open canvas comments" line after the first comment write since the server started.

**The sidecar.** Comments live beside the canvas in `<name>.canvas.mdx.comments.json`, so they travel with the file, show up in git, and can be read with `cat`. The shape is a supported contract:

```json
{
  "version": 1,
  "threads": [
    {
      "id": "cmt_7f3k2a9x1p",
      "anchor": {
        "blockId": "3f9a1c0b7d2e",
        "index": 9,
        "quote": "dev-instance | 22% | 4m12s",
        "preview": "Table Suite | Fail rate ..."
      },
      "resolvedAtMs": null,
      "messages": [
        {
          "id": "msg_x2k9",
          "author": "user",
          "body": "This rerun time looks wrong.",
          "createdAtMs": 1756900000000
        }
      ]
    }
  ]
}
```

An anchor is a fingerprint of the block's text (`blockId`), its ordinal at write time (`index`), the exact selected text or `null` for a whole-block comment (`quote`), and a 240 character `preview` shown when the thread is detached. Anchors are never rewritten. On every render the plugin re-places each thread: an exact fingerprint match wins, then a block that still contains the quote, then a fuzzy text match, else the thread is detached. Both the pane and the CLI write through one compare-and-swap loop, and every op is idempotent by id, so a retried save or a rerun command cannot double post. A sidecar that does not validate reads as empty with a toolbar warning and refuses writes until it is fixed or deleted.

## `bb canvas check`

```
bb canvas check path/to/file.canvas.mdx
```

Parses the file and prints one line per diagnostic as `path:line:column: message`. Exit code 0 means clean. A non-zero exit code means diagnostics or an unreadable file, and the last line says which. `--json` prints `{ ok, diagnostics, stats }`.

## Development

```
bun run typecheck
bun run test
bun run lint
bun run check
bun run reference
```

`bun run reference` regenerates `skills/canvas/reference.md`. `test/reference-is-current.test.ts` fails when the committed file drifts from the registry.
