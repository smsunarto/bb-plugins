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

| Component                               | Summary                                                             | Persisted |
| --------------------------------------- | ------------------------------------------------------------------- | --------- |
| `Row`, `Grid`                           | Horizontal row or fixed column grid for layout.                     | no        |
| `Card`, `Section`                       | Bordered or open container with an optional collapsible body.       | no        |
| `Callout`                               | Toned note with an optional title.                                  | no        |
| `Stat`                                  | One headline number with a label, caption, and delta.               | no        |
| `Pill`                                  | Small toned label.                                                  | no        |
| `Table`                                 | Data table with per column alignment and per row tone.              | no        |
| `BarChart`, `LineChart`, `PieChart`     | Inline SVG charts with legends, axis labels, and reference lines.   | no        |
| `UsageBar`                              | Segmented bar showing parts of a total.                             | no        |
| `DiffView`, `Source`                    | Fenced diff or code block rendered by the bb diff and code viewers. | no        |
| `FileLink`                              | Link that opens a file beside the chat, optionally at a line.       | no        |
| `Ask`                                   | Button that opens a new chat with a prefilled prompt.               | no        |
| `Toggle`, `Select`, `Tabs`, `Checklist` | Controls whose state persists per file.                             | yes       |
| `Todos`                                 | Read only task list with a status icon per item.                    | no        |

[`skills/canvas/reference.md`](skills/canvas/reference.md) lists every prop and one example per component. It is generated from `shared/registry.ts` by `bun run reference`.

## Where canvases live

The skill writes to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx`. That directory belongs to the thread, so the file survives the conversation without touching the repo. A canvas goes into the worktree only when the user wants it committed. The `.canvas.mdx` suffix is required. Any `.mdx` file still shows an "Open as canvas" button.

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
