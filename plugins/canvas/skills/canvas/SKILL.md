---
name: canvas
description: Write a .canvas.mdx file that bb renders in its own split pane as a durable standalone artifact. Use when the agent produces new analytical output the user will revisit, such as quantitative analyses and metric breakdowns, billing or account investigations, security audits or architecture reviews with categorized findings, cross-system data analyses, structured data from MCP tools where the artifact is the deliverable, financial analyses and usage trend reports, large tables the user wants to refine, or a pull request or issue preview that mirrors the GitHub page. Do not use it for work inside a specific tool, for a specific deliverable like a draft or a code fix, for edits to an existing artifact, for targeted debugging, or for short factual answers.
---

# Canvas

A canvas is one `.canvas.mdx` file. bb opens it in its own split pane beside the chat and renders markdown plus a fixed set of components. Nothing in the file runs. The server parses it, validates every component, and the app draws the result. Follow the workflow below in order.

## Workflow

### 1. Decide whether to use a canvas

The trigger is **user intent**, not response shape. Ask: would the user benefit from viewing this output as its **own durable standalone artifact outside the transcript**, separate from the chat? If the output is a means to an end (a drafted message, a code fix, a dashboard in another tool), skip the canvas.

**Use a canvas when the agent produces new standalone analytical output:**

- Quantitative analyses and metrics breakdowns (e.g. "send 500 requests and tell me how many fail")
- Billing or account investigations that surface structured findings from database queries
- Security audits or architecture reviews with categorized findings
- Cross-system data analyses and overlap reports
- Structured data from MCP tools (Databricks, Datadog, etc.) where a durable standalone artifact is the deliverable
- Financial analyses, margin decompositions, usage trend reports
- Large tables the user wants to revisit or refine
- Pull request or issue previews that mirror the GitHub page, built from the templates in step 2

**Do NOT use a canvas when:**

- The user asks for work in a **specific tool**. "create a Datadog dashboard" means give them a Datadog dashboard, not a canvas
- The user has a **specific deliverable**. "draft a support response", "fix this code", "make this PR"
- The user is **working within an existing artifact**. improving an HTML dashboard, editing an existing file
- The user is doing **targeted debugging** or active development, even if structured findings emerge along the way
- An immutable visual output belongs inside the transcript rather than in a durable standalone artifact
- Short factual answers, one-off file edits, or quick clarifying questions
- MCP tools are queried as an **intermediate step** for a different deliverable (e.g. querying Stripe to draft a support reply)

### 2. Write the canvas

**Location.** Write the file to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx`. That directory belongs to the current thread and bb can open files inside it. Write the canvas into the repo worktree only when the user wants it committed. The `.canvas.mdx` suffix is required. Any other suffix opens as a plain file. Use a descriptive kebab-case filename. Preserve acronym capitalization and lowercase the rest. Create the file with the write tool. Do not stop after showing the source in chat.

**File rules:**

- Exactly one `.canvas.mdx` file per canvas. No helper files, no imports, no exports.
- Use only the components listed in `reference.md` next to this file. Every prop value is a literal. Strings, numbers, booleans, null, arrays, and objects are allowed. Identifiers, calls, and expressions are rejected.
- Embed all data inline. There is no fetch and no network.

**Styles.** A canvas declares its style with frontmatter at the very top of the file. Leave the frontmatter out for `default`.

```mdx
---
style: github
---
```

Two styles exist:

- `default`. Compact prose, toned surfaces, and bb's own palette.
- `github`. GitHub's light markdown body, white on every bb theme, with ruled headings and bordered tables.

Pick `github` when the artifact mirrors a GitHub surface: a pull request, an issue, a release note, or a README draft. Stay on `default` for analytical canvases.

**Templates.** Two ready templates sit in `templates/` next to this file. They are read-only reference files. Never edit them in place.

- `templates/pull-request.canvas.mdx` applies when the user wants to preview a pull request before the agent opens it.
- `templates/issue.canvas.mdx` applies when the user wants to preview an issue before the agent files it.

To use one:

1. Read the template.
2. Write a new file to `$BB_THREAD_STORAGE/canvases/<name>.canvas.mdx` with the same section order.
3. Replace every sample value with real content.
4. Drop a section that has no real content. Never leave sample text in place.
5. Run `bb canvas check` on the new file.

**Check the file.** Run `bb canvas check <absolute path>` after every write. Fix every reported line and check again until the output starts with `ok`. Add `--json` to get the report as JSON.

**Link the file.** Whenever you mention the canvas, link it with a markdown link that uses the absolute path, for example `[flaky-test-triage](/Users/me/.bb/thread-storage/t1/canvases/flaky-test-triage.canvas.mdx)`. bb opens the link in its own split pane.

**Layout.** Every component sits alone at the block level with a blank line before and after. Inline JSX inside a paragraph, list, or quote is rejected. Prose between components is markdown. bb renders it with GFM, so tables and task lists work. Fenced `diff` and code blocks feed `DiffView` and `Source`. See `reference.md` for the props of every component and one example each.

**Never render empty states.** A canvas exists to show real content. If a section, chart, table, or component has no data to display, omit it. Do not render it with placeholder text, a "No data" message, an empty array, zeroed rows, or an empty chart frame. If the entire canvas would be empty because you do not have the underlying data, do not produce a canvas. Tell the user what is missing and ask for it instead.

**Label every plot.** Charts and tables must be self-describing. A reader looking at the canvas alone should know exactly what they are seeing. For every plot include:

- A `title` naming the **specific metric** (not "Metrics" but "API error rate by service").
- **Axis labels with units** on both axes through `xAxisLabel` and `yAxisLabel` (e.g. "Date", "Latency (ms)").
- A **legend** when more than one series is shown. The chart draws one from the exact series names, so name them after the source data.
- The **source and time range** in `caption` (e.g. "Source: Datadog, last 7 days"). If a value is a transformation (mean, p95, normalized, smoothed), say so in the label.

Apply the Design guidance below as you write, and complete its Pre-delivery self-check before returning the canvas.

## Design guidance

Be creative. The component set is small but it composes. Use it in whatever combination best serves the content. Avoid slop. bb canvases are flat, minimal, and purposeful.

### Visual hierarchy

Not everything deserves equal treatment. Primary content gets more space, a headline `Stat`, and a tone. Supporting content stays compact. Squint test: blur your eyes. Can you tell what matters?

**Color.** Tones are the only color control. `neutral`, `info`, `success`, `warning`, and `danger` map to the host theme. Use a tone deliberately, not on everything.

### Slop patterns

These patterns produce low-quality output. If two or more are present, redesign.

- **Emojis.** No emoji as icons, status indicators, bullets, or section markers. Use `Pill` or `Todos` for status.
- **Wall of identical cards.** Every section wrapped in the same `Card` with no variation. Mix open `Section` blocks, plain markdown, and cards.
- **Rainbow coloring.** A different tone on every element. Most elements are neutral. Tone is used sparingly with purpose.
- **Giant text.** Headings above `#`, or a `Stat` used for a value that is not the headline number.
- **Toned borders everywhere.** `Callout` is for one note that needs attention, not for every paragraph.

### Pre-delivery self-check

Before returning the canvas, verify:

1. Does the layout have visual hierarchy? One thing should stand out.
2. Is there variety in the composition? Not just a single column of uniform blocks.
3. Slop check. Scan for the patterns above.
4. `bb canvas check` prints `ok`.

## Introducing the canvas

Whenever you mention a canvas to the user, one you created, updated, or want them to open, **always** include a markdown link to that `.canvas.mdx` file using its full absolute path. Use a short descriptive label as the link text. Do not refer to a canvas by name or path alone without the link.

When you create a canvas, add a short note in your chat response telling the user they can open it in its own pane, with that link:

- **First canvas.** If no other `.canvas.mdx` files exist in the thread's `canvases/` directory, include one sentence explaining what a canvas is.
- **Unsolicited canvas.** If the user did not ask for a canvas, include one sentence explaining why you chose it over plain text.

Both can apply at once. One or two sentences total is enough. Skip the intro for subsequent canvases unless you are mentioning that canvas again (still link it).

## Troubleshooting

- The canvas opens as plain text. The file name does not end in `.canvas.mdx`. Rename it. The opener also offers an "Open as canvas" button for any `.mdx` file.
- The canvas shows an unreadable message. The path is wrong, the file is larger than 2 MB, the file is not UTF-8, or the host that owns it is offline. Fix the path or host. The open canvas retries automatically.
- The canvas shows the last good render with a banner. The latest write does not parse. Run `bb canvas check` and fix the reported line. The banner names it too.
- A component shows a red problem card in place. The name, a prop, or a child is wrong. The card names the fix and links to the line. The rest of the document still renders.
- To see the raw source, choose `Open with` on the file and pick the default viewer.
