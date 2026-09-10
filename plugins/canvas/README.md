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

An agent writes one `.canvas.mdx` file. Docs opens it beside the chat in MDXEditor, with Canvas providing a fixed set of components. Tables, charts, callouts, stats, diffs, source excerpts, file links, and a few persisted controls. Nothing in the file runs. The shared parser validates components against a registry before the editor draws them with the host theme.

- **Live.** Docs polls open files. Clean documents refresh after external writes; pending edits retain conflict protection. Invalid MDX remains available in source mode.
- **Safe.** Every prop value is a literal. Identifiers, calls, and expressions are rejected with a positioned diagnostic. There is no fetch and no code execution.
- **Forgiving.** An unknown component, a bad prop, or a disallowed child becomes a red problem card in place. The rest of the document still renders. Problem cards switch to source mode. The rich-text toolbar control returns to the editor.
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

| Component                               | Summary                                                                                                                                  | Persisted |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `Row`, `Grid`                           | Horizontal row or fixed column grid for layout.                                                                                          | no        |
| `Card`, `Section`                       | Bordered or open container with an optional collapsible body.                                                                            | no        |
| `Callout`                               | Toned note with an optional title.                                                                                                       | no        |
| `Stat`                                  | One headline number with a label, caption, and delta.                                                                                    | no        |
| `Pill`                                  | Small toned label.                                                                                                                       | no        |
| `Table`                                 | Data table with per column alignment and per row tone.                                                                                   | no        |
| `BarChart`, `LineChart`, `PieChart`     | Inline SVG charts with legends, axis labels, and reference lines.                                                                        | no        |
| `UsageBar`                              | Segmented bar showing parts of a total.                                                                                                  | no        |
| `DiffView`, `Source`                    | Fenced diff rendered by BB's SDK diff viewer with a collapsible header and the active code theme, or a code block in the bb code viewer. | no        |
| `FileLink`                              | Link that opens a file beside the chat, optionally at a line.                                                                            | no        |
| `Ask`                                   | Button that opens a new chat with a prefilled prompt.                                                                                    | no        |
| `Toggle`, `Select`, `Tabs`, `Checklist` | Controls whose state persists per file.                                                                                                  | yes       |
| `Todos`                                 | Read only task list with a status icon per item.                                                                                         | no        |

[`skills/canvas/reference.md`](skills/canvas/reference.md) lists every prop and one example per component. It is generated from `src/shared/registry.ts` by `bun run reference`.

## Styles

A canvas declares its look with frontmatter at the very top of the file.

```mdx
---
style: github
---
```

Canvas widget styles are `default` and `github`. Docs controls the surrounding editable prose theme. Leave frontmatter out for `default`.

## Templates

[`skills/canvas/templates/`](skills/canvas/templates/) holds two read-only starting points in the `github` style: `pull-request.canvas.mdx` and `issue.canvas.mdx`. The skill tells the agent to write a copy to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx` and replace every sample value.

## How a canvas opens

A canvas link opens a Docs file tab beside the chat. Docs owns `.md`, `.mdx`, and `.canvas.mdx`; Canvas supplies widgets and persistence through its exported editor integration and SDK RPCs.

## Where canvases live

The skill writes to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx`. That directory belongs to the thread, so the file survives the conversation without touching the repo. A canvas goes into the worktree only when the user wants it committed. Use `.canvas.mdx` for Canvas artifacts. Docs also opens ordinary `.mdx` files directly.

## Comments

A reader can leave Google Docs style comments on a rendered canvas, and the agent reads and answers them from the CLI.

**In the pane.** Select text and choose **Comment**, or press Cmd/Ctrl+Shift+M.
The selected passage stays highlighted. Click a highlight to open its thread in
the review sidebar, reply, resolve, or reopen it. The **Suggested edits** tab shows
individual diffs with **Accept** and **Reject**. File changes refresh automatically.

**Direct file access.** Agents can read and edit sibling `.comments.json` and
`.suggestions.json` files. See the [review file contract](skills/canvas/review.md)
for complete examples, matching rules, and acceptance recovery.

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

New comments use an exact rendered-text `quote`, with optional `prefix` and `suffix` to distinguish repeated passages. Existing block anchors remain supported. A block anchor is a fingerprint of the block's text (`blockId`), its ordinal at write time (`index`), the exact selected text or `null` for a whole-block comment (`quote`), and a 240 character `preview` shown when the thread is detached. Anchors are never rewritten. On every render the plugin re-places each thread: an exact fingerprint match wins, then a block that still contains the quote, then a fuzzy text match, else the thread is detached. Both the pane and the CLI write through one compare-and-swap loop, and every op is idempotent by id, so a retried save or a rerun command cannot double post. A sidecar that does not validate reads as empty with a toolbar warning and refuses writes until it is fixed or deleted.

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
