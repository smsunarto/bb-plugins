# Canvas component reference

Generated from `src/shared/registry.ts` by `bun run reference`. Do not edit by hand.

Every component is a block. Put it on its own line with a blank line before and after.
Every prop value is a literal. Strings, numbers, booleans, null, arrays, and objects are allowed.
Identifiers, calls, and expressions are rejected with a diagnostic.

## Components

| Component   | Summary                                                                                                                   | Children                                   | Persisted |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------- |
| `Row`       | Horizontal flex row. Children share the width equally and wrap on narrow panels.                                          | blocks                                     | no        |
| `Grid`      | Fixed column grid. Use for two to four equal panels.                                                                      | blocks                                     | no        |
| `Card`      | Bordered surface with an optional header. Set collapsible to fold the body.                                               | blocks                                     | no        |
| `Section`   | Titled open section without a border. Set collapsible to fold the body.                                                   | blocks                                     | no        |
| `Callout`   | Toned note with an optional title. The body is markdown.                                                                  | blocks                                     | no        |
| `Stat`      | One headline number with a label, an optional caption, and an optional delta.                                             | none                                       | no        |
| `Pill`      | Small toned label for a status or a tag.                                                                                  | none                                       | no        |
| `Table`     | Data table with per column alignment and per row tone.                                                                    | none                                       | no        |
| `BarChart`  | Grouped or stacked bars over categories. Inline SVG with a legend.                                                        | none                                       | no        |
| `LineChart` | One line per series over categories. Inline SVG with a legend.                                                            | none                                       | no        |
| `PieChart`  | Share of a whole as a donut with a legend.                                                                                | none                                       | no        |
| `UsageBar`  | Segmented horizontal bar showing parts of a total.                                                                        | none                                       | no        |
| `DiffView`  | Unified patch from a fenced diff block, rendered by the Pierre file diff in Pierre's own theme with a collapsible header. | one fenced code block, stored as `patch`   | no        |
| `Source`    | Source excerpt from a fenced block, rendered by the bb code viewer.                                                       | one fenced code block, stored as `content` | no        |
| `FileLink`  | Link that opens a file beside the chat, optionally at a line.                                                             | none                                       | no        |
| `Ask`       | Button that opens a new chat with a prefilled prompt.                                                                     | none                                       | no        |
| `Toggle`    | Persisted switch. Children render only while it is on.                                                                    | blocks                                     | yes       |
| `Select`    | Persisted single choice from a fixed list of options.                                                                     | none                                       | yes       |
| `Tabs`      | Persisted tab strip. Children must be Tab components.                                                                     | only Tab                                   | yes       |
| `Tab`       | One tab panel inside Tabs.                                                                                                | blocks                                     | no        |
| `Checklist` | Persisted checkboxes. Each item keeps its own checked state.                                                              | none                                       | yes       |
| `Todos`     | Read only task list with a status icon per item.                                                                          | none                                       | no        |

## Tones

`neutral`, `info`, `success`, `warning`, `danger`. Tones map to host theme colors.

## Styles

A canvas declares its style with frontmatter at the very top of the file.
Without frontmatter the style is `default`.

| Style     | Summary                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `default` | Compact prose, toned surfaces, and bb's own palette.                                            |
| `github`  | GitHub's light markdown body, white on every bb theme, with ruled headings and bordered tables. |

<!-- prettier-ignore -->
```mdx
---
style: github
---

# Release notes for 0.2.0
```

## Row

Horizontal flex row. Children share the width equally and wrap on narrow panels.

Children: blocks.

| Prop    | Type                                        | Required |
| ------- | ------------------------------------------- | -------- |
| `gap`   | `"sm" \| "md" \| "lg"`                      | no       |
| `align` | `"start" \| "center" \| "end" \| "stretch"` | no       |
| `wrap`  | `boolean`                                   | no       |

<!-- prettier-ignore -->
```mdx
<Row gap="md">
  <Stat label="Runs" value="200" />
  <Stat label="Failures" value="14" tone="warning" />
</Row>
```

## Grid

Fixed column grid. Use for two to four equal panels.

Children: blocks.

| Prop      | Type                   | Required |
| --------- | ---------------------- | -------- |
| `columns` | `integer 1 to 6`       | yes      |
| `gap`     | `"sm" \| "md" \| "lg"` | no       |

<!-- prettier-ignore -->
```mdx
<Grid columns={2}>
  <Stat label="Before" value="41" />
  <Stat label="After" value="3" tone="success" />
</Grid>
```

## Card

Bordered surface with an optional header. Set collapsible to fold the body.

Children: blocks.

| Prop          | Type      | Required |
| ------------- | --------- | -------- |
| `title`       | `string`  | no       |
| `collapsible` | `boolean` | no       |
| `defaultOpen` | `boolean` | no       |

<!-- prettier-ignore -->
```mdx
<Card title="Patch" collapsible defaultOpen={false}>
Body text is markdown.
</Card>
```

## Section

Titled open section without a border. Set collapsible to fold the body.

Children: blocks.

| Prop          | Type               | Required |
| ------------- | ------------------ | -------- |
| `title`       | `non-empty string` | yes      |
| `collapsible` | `boolean`          | no       |
| `defaultOpen` | `boolean`          | no       |

<!-- prettier-ignore -->
```mdx
<Section title="Findings">
- First finding
- Second finding
</Section>
```

## Callout

Toned note with an optional title. The body is markdown.

Children: blocks.

| Prop    | Type                                                        | Required |
| ------- | ----------------------------------------------------------- | -------- |
| `tone`  | `"neutral" \| "info" \| "success" \| "warning" \| "danger"` | no       |
| `title` | `string`                                                    | no       |

<!-- prettier-ignore -->
```mdx
<Callout tone="warning" title="One root cause">
Every top offender leaks port 4317.
</Callout>
```

## Stat

One headline number with a label, an optional caption, and an optional delta.

Children: none.

| Prop      | Type                                                        | Required |
| --------- | ----------------------------------------------------------- | -------- |
| `label`   | `non-empty string`                                          | yes      |
| `value`   | `string \| number`                                          | yes      |
| `caption` | `string`                                                    | no       |
| `delta`   | `string`                                                    | no       |
| `tone`    | `"neutral" \| "info" \| "success" \| "warning" \| "danger"` | no       |

<!-- prettier-ignore -->
```mdx
<Stat label="CI hours lost" value="31.4" caption="rerun time only" delta="+3" tone="danger" />
```

## Pill

Small toned label for a status or a tag.

Children: none.

| Prop    | Type                                                        | Required |
| ------- | ----------------------------------------------------------- | -------- |
| `label` | `non-empty string`                                          | yes      |
| `tone`  | `"neutral" \| "info" \| "success" \| "warning" \| "danger"` | no       |

<!-- prettier-ignore -->
```mdx
<Pill label="flaky" tone="warning" />
```

## Table

Data table with per column alignment and per row tone.

Children: none.

| Prop      | Type                                                                    | Required |
| --------- | ----------------------------------------------------------------------- | -------- |
| `headers` | `string[] (at least one)`                                               | yes      |
| `rows`    | `((string \| number \| null)[])[]`                                      | yes      |
| `align`   | `("left" \| "center" \| "right")[]`                                     | no       |
| `rowTone` | `("neutral" \| "info" \| "success" \| "warning" \| "danger" \| null)[]` | no       |
| `caption` | `string`                                                                | no       |
| `striped` | `boolean`                                                               | no       |

<!-- prettier-ignore -->
```mdx
<Table
  caption="Top offenders"
  headers={["Suite", "Fail rate"]}
  align={["left", "right"]}
  rows={[["dev-instance", "22%"], ["screenshots", "17%"]]}
  rowTone={["danger", null]}
/>
```

## BarChart

Grouped or stacked bars over categories. Inline SVG with a legend.

Children: none.

| Prop             | Type                                                                                                                                             | Required |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `categories`     | `string[] (at least one)`                                                                                                                        | yes      |
| `series`         | `({ name: non-empty string, data: number[] (at least one), tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" })[] (at least one)` | yes      |
| `stacked`        | `boolean`                                                                                                                                        | no       |
| `horizontal`     | `boolean`                                                                                                                                        | no       |
| `referenceLines` | `({ value: number, label?: string, tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" })[]`                                        | no       |
| `title`          | `string`                                                                                                                                         | no       |
| `caption`        | `string`                                                                                                                                         | no       |
| `xAxisLabel`     | `string`                                                                                                                                         | no       |
| `yAxisLabel`     | `string`                                                                                                                                         | no       |
| `height`         | `integer 80 to 1200`                                                                                                                             | no       |
| `beginAtZero`    | `boolean`                                                                                                                                        | no       |
| `yMin`           | `number`                                                                                                                                         | no       |
| `yMax`           | `number`                                                                                                                                         | no       |

<!-- prettier-ignore -->
```mdx
<BarChart
  title="Failure count by suite"
  xAxisLabel="Suite"
  yAxisLabel="Failures per 200 runs"
  categories={["dev-instance", "screenshots"]}
  series={[{ name: "timeout", data: [41, 33] }, { name: "assertion", data: [3, 2] }]}
  caption="Source: gh run list, last 200 runs"
/>
```

## LineChart

One line per series over categories. Inline SVG with a legend.

Children: none.

| Prop             | Type                                                                                                                                             | Required |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `categories`     | `string[] (at least one)`                                                                                                                        | yes      |
| `series`         | `({ name: non-empty string, data: number[] (at least one), tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" })[] (at least one)` | yes      |
| `stacked`        | `boolean`                                                                                                                                        | no       |
| `horizontal`     | `boolean`                                                                                                                                        | no       |
| `referenceLines` | `({ value: number, label?: string, tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" })[]`                                        | no       |
| `title`          | `string`                                                                                                                                         | no       |
| `caption`        | `string`                                                                                                                                         | no       |
| `xAxisLabel`     | `string`                                                                                                                                         | no       |
| `yAxisLabel`     | `string`                                                                                                                                         | no       |
| `height`         | `integer 80 to 1200`                                                                                                                             | no       |
| `beginAtZero`    | `boolean`                                                                                                                                        | no       |
| `yMin`           | `number`                                                                                                                                         | no       |
| `yMax`           | `number`                                                                                                                                         | no       |

<!-- prettier-ignore -->
```mdx
<LineChart
  title="p95 latency by day"
  xAxisLabel="Day"
  yAxisLabel="Latency (ms)"
  categories={["Mon", "Tue", "Wed"]}
  series={[{ name: "p95", data: [120, 132, 118] }]}
  referenceLines={[{ value: 125, label: "SLO" }]}
/>
```

## PieChart

Share of a whole as a donut with a legend.

Children: none.

| Prop      | Type                                                                                                                                   | Required |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `data`    | `({ label: non-empty string, value: number >= 0, tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" })[] (at least one)` | yes      |
| `title`   | `string`                                                                                                                               | no       |
| `caption` | `string`                                                                                                                               | no       |

<!-- prettier-ignore -->
```mdx
<PieChart
  title="Failures by cause"
  data={[{ label: "timeout", value: 106 }, { label: "assertion", value: 32 }]}
/>
```

## UsageBar

Segmented horizontal bar showing parts of a total.

Children: none.

| Prop       | Type                                                                                                                                   | Required |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `segments` | `({ label: non-empty string, value: number >= 0, tone?: "neutral" \| "info" \| "success" \| "warning" \| "danger" })[] (at least one)` | yes      |
| `total`    | `number`                                                                                                                               | yes      |
| `labels`   | `{ left?: string, right?: string }`                                                                                                    | no       |

<!-- prettier-ignore -->
```mdx
<UsageBar
  segments={[{ label: "used", value: 62, tone: "info" }, { label: "reserved", value: 10 }]}
  total={100}
  labels={{ left: "72 GB", right: "100 GB" }}
/>
```

## DiffView

Unified patch from a fenced diff block, rendered by the Pierre file diff in Pierre's own theme with a collapsible header.

Children: one fenced code block, stored as `patch`.

| Prop        | Type                   | Required |
| ----------- | ---------------------- | -------- |
| `path`      | `non-empty string`     | yes      |
| `patch`     | `string`               | yes      |
| `view`      | `"unified" \| "split"` | no       |
| `collapsed` | `boolean`              | no       |

<!-- prettier-ignore -->
````mdx
<DiffView path="scripts/bb-dev-cli">
```diff
@@ -84,3 +84,5 @@
   const port = await claimPort();
-  await bootstrap(port);
+  try {
+    await bootstrap(port);
+  } finally {
+    release(port);
+  }
```
</DiffView>
````

## Source

Source excerpt from a fenced block, rendered by the bb code viewer.

Children: one fenced code block, stored as `content`.

| Prop       | Type               | Required |
| ---------- | ------------------ | -------- |
| `path`     | `non-empty string` | yes      |
| `language` | `string`           | no       |
| `content`  | `string`           | yes      |

<!-- prettier-ignore -->
````mdx
<Source path="src/claim.ts">
```ts
export function claimPort(): Promise<number> {
  return reserve(4317);
}
```
</Source>
````

## FileLink

Link that opens a file beside the chat, optionally at a line.

Children: none.

| Prop    | Type               | Required |
| ------- | ------------------ | -------- |
| `path`  | `non-empty string` | yes      |
| `line`  | `integer`          | no       |
| `label` | `string`           | no       |

<!-- prettier-ignore -->
```mdx
<FileLink path="scripts/bb-dev-cli" line={87} label="scripts/bb-dev-cli:87" />
```

## Ask

Button that opens a new chat with a prefilled prompt.

Children: none.

| Prop     | Type               | Required |
| -------- | ------------------ | -------- |
| `label`  | `non-empty string` | yes      |
| `prompt` | `non-empty string` | yes      |

<!-- prettier-ignore -->
```mdx
<Ask label="Draft the fix" prompt="Write the try/finally patch for scripts/bb-dev-cli." />
```

## Toggle

Persisted switch. Children render only while it is on.

Children: blocks.

State persists under `id` across reloads.

| Prop      | Type               | Required |
| --------- | ------------------ | -------- |
| `id`      | `non-empty string` | yes      |
| `label`   | `non-empty string` | yes      |
| `default` | `boolean`          | no       |

<!-- prettier-ignore -->
```mdx
<Toggle id="show-patch" label="Show the patch" default={true}>
Content that renders only while the toggle is on.
</Toggle>
```

## Select

Persisted single choice from a fixed list of options.

Children: none.

State persists under `id` across reloads.

| Prop      | Type                                | Required |
| --------- | ----------------------------------- | -------- |
| `id`      | `non-empty string`                  | yes      |
| `label`   | `non-empty string`                  | yes      |
| `options` | `non-empty string[] (at least one)` | yes      |
| `default` | `string`                            | no       |

<!-- prettier-ignore -->
```mdx
<Select id="window" label="Window" options={["7d", "30d", "90d"]} default="30d" />
```

## Tabs

Persisted tab strip. Children must be Tab components.

Children: only Tab.

State persists under `id` across reloads.

| Prop | Type               | Required |
| ---- | ------------------ | -------- |
| `id` | `non-empty string` | yes      |

<!-- prettier-ignore -->
```mdx
<Tabs id="view">
<Tab label="Summary">
Summary body.
</Tab>
<Tab label="Raw">
Raw body.
</Tab>
</Tabs>
```

## Tab

One tab panel inside Tabs.

Children: blocks.

| Prop    | Type               | Required |
| ------- | ------------------ | -------- |
| `label` | `non-empty string` | yes      |

<!-- prettier-ignore -->
```mdx
<Tab label="Summary">
Summary body.
</Tab>
```

## Checklist

Persisted checkboxes. Each item keeps its own checked state.

Children: none.

State persists under `id` across reloads.

| Prop    | Type                                                                 | Required |
| ------- | -------------------------------------------------------------------- | -------- |
| `id`    | `non-empty string`                                                   | yes      |
| `items` | `{ id: non-empty string, label: non-empty string }[] (at least one)` | yes      |

<!-- prettier-ignore -->
```mdx
<Checklist id="rollout" items={[{ id: "patch", label: "Land the patch" }, { id: "rerun", label: "Rerun CI" }]} />
```

## Todos

Read only task list with a status icon per item.

Children: none.

| Prop    | Type                                                                                                                                     | Required |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `items` | `({ id: non-empty string, label: non-empty string, status: "pending" \| "in_progress" \| "completed" \| "cancelled" })[] (at least one)` | yes      |

<!-- prettier-ignore -->
```mdx
<Todos
  items={[
    { id: "1", label: "Land the patch", status: "completed" },
    { id: "2", label: "Rerun CI", status: "in_progress" }
  ]}
/>
```
