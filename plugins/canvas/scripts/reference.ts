import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  componentNames,
  isStateful,
  specOf,
  type ChildPolicy,
  type ComponentName,
} from "../shared/registry.ts";

// Renders skills/canvas/reference.md from the registry so the component table
// the agent reads can never drift from what the parser accepts.

export const referencePath = fileURLToPath(
  new URL("../skills/canvas/reference.md", import.meta.url),
);

interface ZodDef {
  readonly type: string;
  readonly innerType?: ZodLike;
  readonly element?: ZodLike;
  readonly options?: readonly ZodLike[];
  readonly entries?: Readonly<Record<string, string>>;
  readonly shape?: Readonly<Record<string, ZodLike>>;
  readonly checks?: readonly {
    readonly _zod?: { readonly def: ZodCheck };
    readonly def?: ZodCheck;
  }[];
  readonly value?: unknown;
}

interface ZodCheck {
  readonly check: string;
  readonly format?: string;
  readonly value?: number;
  readonly inclusive?: boolean;
  readonly minimum?: number;
}

interface ZodLike {
  readonly def: ZodDef;
}

function checksOf(def: ZodDef): readonly ZodCheck[] {
  return (def.checks ?? []).flatMap((check) => {
    const inner = check._zod?.def ?? check.def;
    return inner === undefined ? [] : [inner];
  });
}

function numberType(def: ZodDef): string {
  const checks = checksOf(def);
  const integer = checks.some(
    (check) => check.check === "number_format" && check.format?.includes("int") === true,
  );
  const min = checks.find(
    (check) => check.check === "greater_than" && check.inclusive === true,
  )?.value;
  const max = checks.find(
    (check) => check.check === "less_than" && check.inclusive === true,
  )?.value;
  const base = integer ? "integer" : "number";
  if (min !== undefined && max !== undefined) return `${base} ${min} to ${max}`;
  if (min !== undefined) return `${base} >= ${min}`;
  return base;
}

function stringType(def: ZodDef): string {
  const nonEmpty = checksOf(def).some(
    (check) => check.check === "min_length" && (check.minimum ?? 0) >= 1,
  );
  return nonEmpty ? "non-empty string" : "string";
}

function group(text: string): string {
  return text.includes(" | ") ? `(${text})` : text;
}

export function typeOf(schema: ZodLike): string {
  const def = schema.def;
  switch (def.type) {
    case "string":
      return stringType(def);
    case "number":
      return numberType(def);
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "literal":
      return JSON.stringify(def.value);
    case "enum":
      return Object.values(def.entries ?? {})
        .map((entry) => JSON.stringify(entry))
        .join(" | ");
    case "optional":
      return def.innerType === undefined ? "unknown" : typeOf(def.innerType);
    case "nullable":
      return def.innerType === undefined ? "unknown" : `${typeOf(def.innerType)} | null`;
    case "array": {
      const element = def.element === undefined ? "unknown" : typeOf(def.element);
      const nonEmpty = checksOf(def).some(
        (check) => check.check === "min_length" && (check.minimum ?? 0) >= 1,
      );
      return `${group(element)}[]${nonEmpty ? " (at least one)" : ""}`;
    }
    case "union":
      return (def.options ?? []).map(typeOf).join(" | ");
    case "object": {
      const entries = Object.entries(def.shape ?? {}).map(([key, value]) => {
        const optional = value.def.type === "optional";
        return `${key}${optional ? "?" : ""}: ${typeOf(value)}`;
      });
      return `{ ${entries.join(", ")} }`;
    }
    default:
      return def.type;
  }
}

function childrenText(policy: ChildPolicy): string {
  switch (policy.kind) {
    case "none":
      return "none";
    case "blocks":
      return policy.only === undefined ? "blocks" : `only ${policy.only.join(", ")}`;
    case "code":
      return `one fenced code block, stored as \`${policy.prop}\``;
  }
}

export const examples: Readonly<Record<ComponentName, string>> = {
  Row: `<Row gap="md">
  <Stat label="Runs" value="200" />
  <Stat label="Failures" value="14" tone="warning" />
</Row>`,
  Grid: `<Grid columns={2}>
  <Stat label="Before" value="41" />
  <Stat label="After" value="3" tone="success" />
</Grid>`,
  Card: `<Card title="Patch" collapsible defaultOpen={false}>
Body text is markdown.
</Card>`,
  Section: `<Section title="Findings">
- First finding
- Second finding
</Section>`,
  Callout: `<Callout tone="warning" title="One root cause">
Every top offender leaks port 4317.
</Callout>`,
  Stat: `<Stat label="CI hours lost" value="31.4" caption="rerun time only" delta="+3" tone="danger" />`,
  Pill: `<Pill label="flaky" tone="warning" />`,
  Table: `<Table
  caption="Top offenders"
  headers={["Suite", "Fail rate"]}
  align={["left", "right"]}
  rows={[["dev-instance", "22%"], ["screenshots", "17%"]]}
  rowTone={["danger", null]}
/>`,
  BarChart: `<BarChart
  title="Failure count by suite"
  xAxisLabel="Suite"
  yAxisLabel="Failures per 200 runs"
  categories={["dev-instance", "screenshots"]}
  series={[{ name: "timeout", data: [41, 33] }, { name: "assertion", data: [3, 2] }]}
  caption="Source: gh run list, last 200 runs"
/>`,
  LineChart: `<LineChart
  title="p95 latency by day"
  xAxisLabel="Day"
  yAxisLabel="Latency (ms)"
  categories={["Mon", "Tue", "Wed"]}
  series={[{ name: "p95", data: [120, 132, 118] }]}
  referenceLines={[{ value: 125, label: "SLO" }]}
/>`,
  PieChart: `<PieChart
  title="Failures by cause"
  data={[{ label: "timeout", value: 106 }, { label: "assertion", value: 32 }]}
/>`,
  UsageBar: `<UsageBar
  segments={[{ label: "used", value: 62, tone: "info" }, { label: "reserved", value: 10 }]}
  total={100}
  labels={{ left: "72 GB", right: "100 GB" }}
/>`,
  DiffView: `<DiffView path="scripts/bb-dev-cli">
\`\`\`diff
@@ -84,3 +84,5 @@
   const port = await claimPort();
-  await bootstrap(port);
+  try {
+    await bootstrap(port);
+  } finally {
+    release(port);
+  }
\`\`\`
</DiffView>`,
  Source: `<Source path="src/claim.ts">
\`\`\`ts
export function claimPort(): Promise<number> {
  return reserve(4317);
}
\`\`\`
</Source>`,
  FileLink: `<FileLink path="scripts/bb-dev-cli" line={87} label="scripts/bb-dev-cli:87" />`,
  Ask: `<Ask label="Draft the fix" prompt="Write the try/finally patch for scripts/bb-dev-cli." />`,
  Toggle: `<Toggle id="show-patch" label="Show the patch" default={true}>
Content that renders only while the toggle is on.
</Toggle>`,
  Select: `<Select id="window" label="Window" options={["7d", "30d", "90d"]} default="30d" />`,
  Tabs: `<Tabs id="view">
<Tab label="Summary">
Summary body.
</Tab>
<Tab label="Raw">
Raw body.
</Tab>
</Tabs>`,
  Tab: `<Tab label="Summary">
Summary body.
</Tab>`,
  Checklist: `<Checklist id="rollout" items={[{ id: "patch", label: "Land the patch" }, { id: "rerun", label: "Rerun CI" }]} />`,
  Todos: `<Todos
  items={[
    { id: "1", label: "Land the patch", status: "completed" },
    { id: "2", label: "Rerun CI", status: "in_progress" }
  ]}
/>`,
};

// Pads columns the way oxfmt does, so formatting the output is a no-op and
// the freshness test compares like with like.
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const rule = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(header), rule, ...rows.map(line)].join("\n");
}

function fenceFor(example: string): string {
  return example.includes("```") ? "````" : "```";
}

function propsTable(name: ComponentName): string {
  const shape = specOf(name).props.shape as Readonly<Record<string, ZodLike>>;
  const rows = Object.entries(shape).map(([key, schema]) => [
    `\`${key}\``,
    `\`${typeOf(schema).replaceAll("|", "\\|")}\``,
    schema.def.type === "optional" ? "no" : "yes",
  ]);
  return table(["Prop", "Type", "Required"], rows);
}

export function renderReference(): string {
  const out: string[] = [
    "# Canvas component reference",
    "",
    "Generated from `shared/registry.ts` by `bun run reference`. Do not edit by hand.",
    "",
    "Every component is a block. Put it on its own line with a blank line before and after.",
    "Every prop value is a literal. Strings, numbers, booleans, null, arrays, and objects are allowed.",
    "Identifiers, calls, and expressions are rejected with a diagnostic.",
    "",
    "## Components",
    "",
    table(
      ["Component", "Summary", "Children", "Persisted"],
      componentNames.map((name) => {
        const spec = specOf(name);
        return [
          `\`${name}\``,
          spec.summary,
          childrenText(spec.children),
          isStateful(name) ? "yes" : "no",
        ];
      }),
    ),
  ];
  out.push(
    "",
    "## Tones",
    "",
    "`neutral`, `info`, `success`, `warning`, `danger`. Tones map to host theme colors.",
    "",
  );
  for (const name of componentNames) {
    const spec = specOf(name);
    out.push(`## ${name}`, "", spec.summary, "", `Children: ${childrenText(spec.children)}.`);
    if (isStateful(name)) {
      out.push("", "State persists under `id` across reloads. Reset state clears it.");
    }
    // oxfmt would reflow the MDX inside the fence, so the marker keeps the
    // example byte-identical to what the parser test checks.
    out.push(
      "",
      propsTable(name),
      "",
      "<!-- prettier-ignore -->",
      `${fenceFor(examples[name])}mdx`,
      examples[name],
      fenceFor(examples[name]),
      "",
    );
  }
  return out.join("\n");
}

if (import.meta.main) {
  await writeFile(referencePath, renderReference());
  console.log(`wrote ${referencePath}`);
}
