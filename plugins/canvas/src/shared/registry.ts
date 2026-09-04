import { z } from "zod";
import { suggest } from "./suggest.ts";

export type ChildPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "blocks"; readonly only?: readonly string[] }
  | { readonly kind: "code"; readonly prop: string; readonly langProp?: string };

export interface ComponentSpec {
  readonly props: z.ZodObject;
  readonly children: ChildPolicy;
  readonly stateful?: true;
  readonly summary: string;
}

export const toneSchema = z.enum(["neutral", "info", "success", "warning", "danger"]);
export type Tone = z.infer<typeof toneSchema>;

export const gapSchema = z.enum(["sm", "md", "lg"]);

const seriesSchema = z.object({
  name: z.string().min(1),
  data: z.array(z.number()).min(1),
  tone: toneSchema.optional(),
});

const referenceLineSchema = z.object({
  value: z.number(),
  label: z.string().optional(),
  tone: toneSchema.optional(),
});

const cartesianChartProps = z.object({
  categories: z.array(z.string()).min(1),
  series: z.array(seriesSchema).min(1),
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  referenceLines: z.array(referenceLineSchema).optional(),
  title: z.string().optional(),
  caption: z.string().optional(),
  xAxisLabel: z.string().optional(),
  yAxisLabel: z.string().optional(),
  height: z.number().int().min(80).max(1200).optional(),
  beginAtZero: z.boolean().optional(),
  yMin: z.number().optional(),
  yMax: z.number().optional(),
});

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const registry = {
  Row: {
    props: z.object({
      gap: gapSchema.optional(),
      align: z.enum(["start", "center", "end", "stretch"]).optional(),
      wrap: z.boolean().optional(),
    }),
    children: { kind: "blocks" },
    summary: "Horizontal flex row. Children share the width equally and wrap on narrow panels.",
  },
  Grid: {
    props: z.object({
      columns: z.number().int().min(1).max(6),
      gap: gapSchema.optional(),
    }),
    children: { kind: "blocks" },
    summary: "Fixed column grid. Use for two to four equal panels.",
  },
  Card: {
    props: z.object({
      title: z.string().optional(),
      collapsible: z.boolean().optional(),
      defaultOpen: z.boolean().optional(),
    }),
    children: { kind: "blocks" },
    summary: "Bordered surface with an optional header. Set collapsible to fold the body.",
  },
  Section: {
    props: z.object({
      title: z.string().min(1),
      collapsible: z.boolean().optional(),
      defaultOpen: z.boolean().optional(),
    }),
    children: { kind: "blocks" },
    summary: "Titled open section without a border. Set collapsible to fold the body.",
  },
  Callout: {
    props: z.object({
      tone: toneSchema.optional(),
      title: z.string().optional(),
    }),
    children: { kind: "blocks" },
    summary: "Toned note with an optional title. The body is markdown.",
  },
  Stat: {
    props: z.object({
      label: z.string().min(1),
      value: z.union([z.string(), z.number()]),
      caption: z.string().optional(),
      delta: z.string().optional(),
      tone: toneSchema.optional(),
    }),
    children: { kind: "none" },
    summary: "One headline number with a label, an optional caption, and an optional delta.",
  },
  Pill: {
    props: z.object({
      label: z.string().min(1),
      tone: toneSchema.optional(),
    }),
    children: { kind: "none" },
    summary: "Small toned label for a status or a tag.",
  },
  Table: {
    props: z.object({
      headers: z.array(z.string()).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
      align: z.array(z.enum(["left", "center", "right"])).optional(),
      rowTone: z.array(toneSchema.nullable()).optional(),
      caption: z.string().optional(),
      striped: z.boolean().optional(),
    }),
    children: { kind: "none" },
    summary: "Data table with per column alignment and per row tone.",
  },
  BarChart: {
    props: cartesianChartProps,
    children: { kind: "none" },
    summary: "Grouped or stacked bars over categories. Inline SVG with a legend.",
  },
  LineChart: {
    props: cartesianChartProps,
    children: { kind: "none" },
    summary: "One line per series over categories. Inline SVG with a legend.",
  },
  PieChart: {
    props: z.object({
      data: z
        .array(
          z.object({
            label: z.string().min(1),
            value: z.number().nonnegative(),
            tone: toneSchema.optional(),
          }),
        )
        .min(1),
      title: z.string().optional(),
      caption: z.string().optional(),
    }),
    children: { kind: "none" },
    summary: "Share of a whole as a donut with a legend.",
  },
  UsageBar: {
    props: z.object({
      segments: z
        .array(
          z.object({
            label: z.string().min(1),
            value: z.number().nonnegative(),
            tone: toneSchema.optional(),
          }),
        )
        .min(1),
      total: z.number().positive(),
      labels: z
        .object({
          left: z.string().optional(),
          right: z.string().optional(),
        })
        .optional(),
    }),
    children: { kind: "none" },
    summary: "Segmented horizontal bar showing parts of a total.",
  },
  DiffView: {
    props: z.object({
      path: z.string().min(1),
      patch: z.string(),
      view: z.enum(["unified", "split"]).optional(),
      collapsed: z.boolean().optional(),
    }),
    children: { kind: "code", prop: "patch" },
    summary:
      "Unified patch from a fenced diff block, rendered by the Pierre file diff in Pierre's own theme with a collapsible header.",
  },
  Source: {
    props: z.object({
      path: z.string().min(1),
      language: z.string().optional(),
      content: z.string(),
    }),
    children: { kind: "code", prop: "content", langProp: "language" },
    summary: "Source excerpt from a fenced block, rendered by the bb code viewer.",
  },
  FileLink: {
    props: z.object({
      path: z.string().min(1),
      line: z.number().int().positive().optional(),
      label: z.string().optional(),
    }),
    children: { kind: "none" },
    summary: "Link that opens a file beside the chat, optionally at a line.",
  },
  Ask: {
    props: z.object({
      label: z.string().min(1),
      prompt: z.string().min(1),
    }),
    children: { kind: "none" },
    summary: "Button that opens a new chat with a prefilled prompt.",
  },
  Toggle: {
    props: z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      default: z.boolean().optional(),
    }),
    children: { kind: "blocks" },
    stateful: true,
    summary: "Persisted switch. Children render only while it is on.",
  },
  Select: {
    props: z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      options: z.array(z.string().min(1)).min(1),
      default: z.string().optional(),
    }),
    children: { kind: "none" },
    stateful: true,
    summary: "Persisted single choice from a fixed list of options.",
  },
  Tabs: {
    props: z.object({
      id: z.string().min(1),
    }),
    children: { kind: "blocks", only: ["Tab"] },
    stateful: true,
    summary: "Persisted tab strip. Children must be Tab components.",
  },
  Tab: {
    props: z.object({
      label: z.string().min(1),
    }),
    children: { kind: "blocks" },
    summary: "One tab panel inside Tabs.",
  },
  Checklist: {
    props: z.object({
      id: z.string().min(1),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
          }),
        )
        .min(1),
    }),
    children: { kind: "none" },
    stateful: true,
    summary: "Persisted checkboxes. Each item keeps its own checked state.",
  },
  Todos: {
    props: z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            status: todoStatusSchema,
          }),
        )
        .min(1),
    }),
    children: { kind: "none" },
    summary: "Read only task list with a status icon per item.",
  },
} as const satisfies Record<string, ComponentSpec>;

export type ComponentName = keyof typeof registry;

export const componentNames = Object.keys(registry) as readonly ComponentName[];

export const componentNameSchema = z.enum(componentNames as [ComponentName, ...ComponentName[]]);

export function isComponentName(name: string): name is ComponentName {
  return Object.hasOwn(registry, name);
}

export function specOf(name: ComponentName): ComponentSpec {
  return registry[name];
}

export function isStateful(name: ComponentName): boolean {
  return specOf(name).stateful === true;
}

export function suggestComponentName(typo: string): string | undefined {
  return suggest(typo, componentNames);
}
