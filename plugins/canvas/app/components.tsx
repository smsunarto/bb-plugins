import type { ReactElement, ReactNode } from "react";
import {
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  experimental_SourceCode as SourceCode,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { CanvasNode, JsonValue } from "../shared/document.ts";
import type { ComponentName, Tone, TodoStatus } from "../shared/registry.ts";
import { BarChart, LineChart, PieChart, UsageBar } from "./charts.tsx";
import type { CartesianProps, PieSlice } from "./charts.tsx";
import { keyed } from "./keys.ts";
import { useCanvas, useCanvasState } from "./state.tsx";

export interface CanvasComponentProps {
  readonly props: Readonly<Record<string, JsonValue>>;
  readonly nodes: readonly CanvasNode[];
  readonly renderNodes: (nodes: readonly CanvasNode[]) => ReactNode;
}

export type CanvasComponent = (props: CanvasComponentProps) => ReactElement | null;

// Props were validated against the registry schema on the server, so each
// component reads them through one cast instead of re-validating in the browser.
function typed<T>(props: Readonly<Record<string, JsonValue>>): T {
  return props as unknown as T;
}

const gapClass = { sm: "gap-2", md: "gap-4", lg: "gap-6" } as const;

const columnsClass = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
} as const;

export const toneText: Readonly<Record<Tone, string>> = {
  neutral: "text-muted-foreground",
  info: "text-sky-600 dark:text-sky-400",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

/* Table rows carry a tone across a whole line of body text, so they use a
 * quieter tint than a Pill or Callout title. A saturated accent that reads as
 * emphasis on a short label reads as a rainbow across four table rows. */
const toneRowText: Readonly<Record<Tone, string>> = {
  neutral: "",
  info: "text-sky-900 dark:text-sky-200/80",
  success: "text-emerald-900 dark:text-emerald-200/80",
  warning: "text-amber-900 dark:text-amber-200/80",
  danger: "text-red-900 dark:text-red-200/80",
};

const toneSurface: Readonly<Record<Tone, string>> = {
  neutral: "border-border bg-muted/40",
  info: "border-sky-500/40 bg-sky-500/10",
  success: "border-emerald-500/40 bg-emerald-500/10",
  warning: "border-amber-500/40 bg-amber-500/10",
  danger: "border-red-500/40 bg-red-500/10",
};

export const buttonClass =
  "rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50";

function Row(props: CanvasComponentProps): ReactElement {
  const {
    gap = "md",
    align = "stretch",
    wrap = true,
  } = typed<{
    gap?: "sm" | "md" | "lg";
    align?: "start" | "center" | "end" | "stretch";
    wrap?: boolean;
  }>(props.props);
  const alignClass = {
    start: "items-start",
    center: "items-center",
    end: "items-end",
    stretch: "items-stretch",
  }[align];
  return (
    <div
      className={`canvas-block flex ${wrap ? "flex-wrap" : ""} ${gapClass[gap]} ${alignClass} [&>*]:min-w-32 [&>*]:flex-1 [&>*]:[overflow-wrap:anywhere]`}
    >
      {props.renderNodes(props.nodes)}
    </div>
  );
}

function Grid(props: CanvasComponentProps): ReactElement {
  const { columns, gap = "md" } = typed<{
    columns: 1 | 2 | 3 | 4 | 5 | 6;
    gap?: "sm" | "md" | "lg";
  }>(props.props);
  return (
    <div className={`canvas-block grid ${columnsClass[columns]} ${gapClass[gap]}`}>
      {props.renderNodes(props.nodes)}
    </div>
  );
}

function Collapsible(props: {
  readonly title: string | undefined;
  readonly collapsible: boolean;
  readonly defaultOpen: boolean;
  readonly bordered: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const frame = props.bordered
    ? "canvas-card rounded-md border border-border bg-background"
    : "canvas-section";
  const headerClass = `text-[0.9em] font-medium text-foreground ${props.bordered ? "canvas-card-header border-b border-border px-3 py-2" : "py-1"}`;
  const bodyClass = props.bordered ? "canvas-card-body canvas-nested px-3 py-2" : "canvas-nested";
  if (props.collapsible) {
    return (
      <details className={`canvas-block ${frame}`} open={props.defaultOpen}>
        <summary className={`cursor-pointer select-none ${headerClass}`}>{props.title}</summary>
        <div className={bodyClass}>{props.children}</div>
      </details>
    );
  }
  return (
    <section className={`canvas-block ${frame}`}>
      {props.title !== undefined ? <h3 className={`m-0 ${headerClass}`}>{props.title}</h3> : null}
      <div className={bodyClass}>{props.children}</div>
    </section>
  );
}

function Card(props: CanvasComponentProps): ReactElement {
  const {
    title,
    collapsible = false,
    defaultOpen = true,
  } = typed<{
    title?: string;
    collapsible?: boolean;
    defaultOpen?: boolean;
  }>(props.props);
  return (
    <Collapsible
      title={title}
      collapsible={collapsible && title !== undefined}
      defaultOpen={defaultOpen}
      bordered
    >
      {props.renderNodes(props.nodes)}
    </Collapsible>
  );
}

function Section(props: CanvasComponentProps): ReactElement {
  const {
    title,
    collapsible = false,
    defaultOpen = true,
  } = typed<{
    title: string;
    collapsible?: boolean;
    defaultOpen?: boolean;
  }>(props.props);
  return (
    <Collapsible title={title} collapsible={collapsible} defaultOpen={defaultOpen} bordered={false}>
      {props.renderNodes(props.nodes)}
    </Collapsible>
  );
}

function Callout(props: CanvasComponentProps): ReactElement {
  const { tone = "neutral", title } = typed<{ tone?: Tone; title?: string }>(props.props);
  return (
    // The aside carries the tone as its color so a style can draw its rule with
    // currentColor; both children set their own color, so nothing visible changes.
    <aside
      className={`canvas-callout canvas-block rounded-md border px-3 py-2 ${toneSurface[tone]} ${toneText[tone]}`}
      role="note"
    >
      {title !== undefined ? (
        <p
          className={`canvas-callout-title m-0 mb-1 text-[0.875em] font-semibold ${toneText[tone]}`}
        >
          {title}
        </p>
      ) : null}
      <div className="canvas-nested text-[0.875em] text-foreground">
        {props.renderNodes(props.nodes)}
      </div>
    </aside>
  );
}

function Stat(props: CanvasComponentProps): ReactElement {
  const {
    label,
    value,
    caption,
    delta,
    tone = "neutral",
  } = typed<{
    label: string;
    value: string | number;
    caption?: string;
    delta?: string;
    tone?: Tone;
  }>(props.props);
  return (
    <div className="canvas-stat rounded-md border border-border bg-background px-3 py-2">
      <p className="m-0 text-[0.75em] text-muted-foreground">{label}</p>
      <p className="m-0 flex items-baseline gap-2">
        <span className="text-[1.5em] font-semibold leading-tight tracking-[-0.015em] text-foreground">
          {value}
        </span>
        {delta !== undefined ? (
          <span className={`text-[0.75em] ${toneText[tone]}`}>{delta}</span>
        ) : null}
      </p>
      {caption !== undefined ? (
        <p className="m-0 text-[0.75em] text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}

function Pill(props: CanvasComponentProps): ReactElement {
  const { label, tone = "neutral" } = typed<{ label: string; tone?: Tone }>(props.props);
  return (
    <span
      className={`canvas-pill my-1 inline-block rounded-full border px-2 py-0.5 text-[0.75em] ${toneSurface[tone]} ${toneText[tone]}`}
    >
      {label}
    </span>
  );
}

function Table(props: CanvasComponentProps): ReactElement {
  const {
    headers,
    rows,
    align = [],
    rowTone = [],
    caption,
    striped = false,
  } = typed<{
    headers: string[];
    rows: (string | number | null)[][];
    align?: ("left" | "center" | "right")[];
    rowTone?: (Tone | null)[];
    caption?: string;
    striped?: boolean;
  }>(props.props);
  const alignClass = (index: number) =>
    ({ left: "text-left", center: "text-center", right: "text-right" })[align[index] ?? "left"];
  const columns = keyed(headers, (header) => header);
  const keyedRows = keyed(rows, (row) => row.map((cell) => String(cell)).join("\u0000"));
  return (
    <div className="canvas-block overflow-x-auto">
      <table className="canvas-table w-full border-collapse text-[0.875em] leading-[1.3]">
        {caption !== undefined ? (
          <caption className="mb-1 text-left text-[0.75em] text-muted-foreground">
            {caption}
          </caption>
        ) : null}
        <thead>
          <tr className="border-b [border-color:var(--canvas-prose-rule)]">
            {columns.map((column, index) => (
              <th
                key={column.key}
                className={`py-[0.25em] pl-0 pr-[0.625em] font-semibold text-foreground ${alignClass(index)}`}
              >
                {column.item}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keyedRows.map((row, rowIndex) => {
            const tone = rowTone[rowIndex] ?? null;
            const stripe = striped && rowIndex % 2 === 1 ? "bg-muted/40" : "";
            return (
              <tr
                key={row.key}
                className={`border-b [border-color:var(--canvas-prose-rule)] ${stripe} ${tone === null ? "" : toneRowText[tone]}`}
              >
                {columns.map((column, cellIndex) => (
                  <td
                    key={column.key}
                    className={`py-[0.25em] pl-0 pr-[0.625em] ${alignClass(cellIndex)}`}
                  >
                    {row.item[cellIndex] ?? ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DiffView(props: CanvasComponentProps): ReactElement {
  const { path, patch, view } = typed<{ path: string; patch: string; view?: "unified" | "split" }>(
    props.props,
  );
  return (
    <div className="canvas-block overflow-hidden rounded-md border border-border">
      <Diff patch={patch} path={path} view={view} />
    </div>
  );
}

function Source(props: CanvasComponentProps): ReactElement {
  const { path, content } = typed<{ path: string; content: string; language?: string }>(
    props.props,
  );
  return (
    <div className="canvas-block overflow-hidden rounded-md border border-border">
      <SourceCode content={content} path={path} />
    </div>
  );
}

function resolveLinkPath(canvasPath: string, sourceKind: string, path: string): string {
  if (sourceKind !== "host" || path.startsWith("/")) return path;
  const directory = canvasPath.slice(0, canvasPath.lastIndexOf("/") + 1);
  return `${directory}${path}`;
}

function FileLinkComponent(props: CanvasComponentProps): ReactElement {
  const { path, line, label } = typed<{ path: string; line?: number; label?: string }>(props.props);
  const canvas = useCanvas();
  const text = label ?? (line === undefined ? path : `${path}:${line}`);
  if (canvas.target === null) {
    return <code className="text-muted-foreground">{text}</code>;
  }
  const target = { ...canvas.target, path: resolveLinkPath(canvas.path, canvas.source.kind, path) };
  return (
    <FileLink
      target={target}
      location={line === undefined ? null : { kind: "line", line, column: null }}
      className="text-primary underline [text-decoration-thickness:from-font] [text-underline-offset:0.12em]"
    >
      {text}
    </FileLink>
  );
}

function Ask(props: CanvasComponentProps): ReactElement {
  const { label, prompt } = typed<{ label: string; prompt: string }>(props.props);
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className={`my-2 ${buttonClass}`}
      onClick={() => navigate.toCompose({ initialPrompt: prompt, focusPrompt: true })}
    >
      {label}
    </button>
  );
}

function Toggle(props: CanvasComponentProps): ReactElement {
  const {
    id,
    label,
    default: fallback = false,
  } = typed<{ id: string; label: string; default?: boolean }>(props.props);
  const state = useCanvasState();
  const stored = state.values[id];
  const on = typeof stored === "boolean" ? stored : fallback;
  return (
    <div className="canvas-block">
      <label className="flex cursor-pointer items-center gap-2 text-[0.875em] text-foreground">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => state.set(id, event.target.checked)}
        />
        {label}
      </label>
      {on ? <div className="canvas-nested mt-2">{props.renderNodes(props.nodes)}</div> : null}
    </div>
  );
}

function Select(props: CanvasComponentProps): ReactElement {
  const {
    id,
    label,
    options,
    default: fallback,
  } = typed<{
    id: string;
    label: string;
    options: string[];
    default?: string;
  }>(props.props);
  const state = useCanvasState();
  const stored = state.values[id];
  const selected =
    typeof stored === "string" && options.includes(stored)
      ? stored
      : (fallback ?? options[0] ?? "");
  return (
    <label className="canvas-block flex items-center gap-2 text-[0.875em] text-foreground">
      {label}
      <select
        className="rounded-md border border-border bg-background px-2 py-1 text-[0.875em] text-foreground"
        value={selected}
        onChange={(event) => state.set(id, event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function tabLabel(node: CanvasNode, index: number): string {
  if (node.kind === "component" && typeof node.props["label"] === "string")
    return node.props["label"];
  return `Tab ${index + 1}`;
}

function Tabs(props: CanvasComponentProps): ReactElement {
  const { id } = typed<{ id: string }>(props.props);
  const state = useCanvasState();
  const tabs = props.nodes.filter((node) => node.kind === "component" && node.name === "Tab");
  const labels = tabs.map(tabLabel);
  const stored = state.values[id];
  const selected =
    typeof stored === "string" && labels.includes(stored) ? stored : (labels[0] ?? "");
  const active = tabs[labels.indexOf(selected)];
  const others = props.nodes.filter((node) => node.kind === "diagnostic");
  return (
    <div className="canvas-block">
      <div role="tablist" className="flex gap-1 border-b border-border">
        {labels.map((label) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={label === selected}
            className={`-mb-px border-b-2 px-3 py-1.5 text-[0.875em] ${
              label === selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => state.set(id, label)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="canvas-nested pt-2">
        {active !== undefined && active.kind === "component"
          ? props.renderNodes(active.children)
          : null}
        {props.renderNodes(others)}
      </div>
    </div>
  );
}

function Tab(props: CanvasComponentProps): ReactElement {
  return <div>{props.renderNodes(props.nodes)}</div>;
}

function Checklist(props: CanvasComponentProps): ReactElement {
  const { id, items } = typed<{ id: string; items: { id: string; label: string }[] }>(props.props);
  const state = useCanvasState();
  const stored = state.values[id];
  const checked: Readonly<Record<string, JsonValue>> =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Readonly<Record<string, JsonValue>>)
      : {};
  return (
    <ul className="canvas-block flex list-none flex-col gap-1 p-0">
      {items.map((item) => {
        const done = checked[item.id] === true;
        return (
          <li key={item.id}>
            <label className="flex cursor-pointer items-center gap-2 text-[0.875em] text-foreground">
              <input
                type="checkbox"
                checked={done}
                onChange={(event) => state.set(id, { ...checked, [item.id]: event.target.checked })}
              />
              <span className={done ? "line-through text-muted-foreground" : ""}>{item.label}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

const todoGlyph: Readonly<Record<TodoStatus, { glyph: string; className: string; title: string }>> =
  {
    pending: { glyph: "○", className: "text-muted-foreground", title: "Pending" },
    in_progress: { glyph: "◐", className: toneText.info, title: "In progress" },
    completed: { glyph: "●", className: toneText.success, title: "Completed" },
    cancelled: { glyph: "×", className: toneText.danger, title: "Cancelled" },
  };

function Todos(props: CanvasComponentProps): ReactElement {
  const { items } = typed<{ items: { id: string; label: string; status: TodoStatus }[] }>(
    props.props,
  );
  return (
    <ul className="canvas-block flex list-none flex-col gap-1 p-0">
      {items.map((item) => {
        const glyph = todoGlyph[item.status];
        return (
          <li key={item.id} className="flex items-center gap-2 text-[0.875em] text-foreground">
            <span
              aria-label={glyph.title}
              title={glyph.title}
              className={`w-4 text-center ${glyph.className}`}
            >
              {glyph.glyph}
            </span>
            <span
              className={
                item.status === "completed" || item.status === "cancelled"
                  ? "text-muted-foreground line-through"
                  : ""
              }
            >
              {item.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function BarChartComponent(props: CanvasComponentProps): ReactElement {
  return <BarChart {...typed<CartesianProps>(props.props)} />;
}

function LineChartComponent(props: CanvasComponentProps): ReactElement {
  return <LineChart {...typed<CartesianProps>(props.props)} />;
}

function PieChartComponent(props: CanvasComponentProps): ReactElement {
  return (
    <PieChart {...typed<{ data: PieSlice[]; title?: string; caption?: string }>(props.props)} />
  );
}

function UsageBarComponent(props: CanvasComponentProps): ReactElement {
  return (
    <UsageBar
      {...typed<{
        segments: PieSlice[];
        total: number;
        labels?: { left?: string; right?: string };
      }>(props.props)}
    />
  );
}

export const componentTable = {
  Row,
  Grid,
  Card,
  Section,
  Callout,
  Stat,
  Pill,
  Table,
  BarChart: BarChartComponent,
  LineChart: LineChartComponent,
  PieChart: PieChartComponent,
  UsageBar: UsageBarComponent,
  DiffView,
  Source,
  FileLink: FileLinkComponent,
  Ask,
  Toggle,
  Select,
  Tabs,
  Tab,
  Checklist,
  Todos,
} satisfies Record<ComponentName, CanvasComponent>;
