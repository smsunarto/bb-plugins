// A static markdown rendering of an evaluated UI for clients that cannot run
// it (mobile app, notifications, CLI): readable on a phone, no HTML.
import type { LoadedData } from "./data";
import { acceptanceVerdict, cellsLine, checkLabel, isCellGap, isGap, needsPlaces, ownerContradiction, readAcceptance, type Check, type Evidence as AcceptanceEvidence } from "./acceptance";
import { conditionDifferences, conditionsWarning, readCompare, type CompareImage } from "./compare";
import { analyse, countsText, describeRegion, formatClock, formatWer, readTracks } from "./transcript";
import {
  formatConditions,
  formatRatio,
  groupRuns,
  readBenchmark,
  runStatusWord,
  unmeasuredCounts,
  type AllRunsReport,
  type Comparison,
  type Context,
  type Run,
} from "./benchmark";
import { formatAmount as perfAmount, formatBytes, formatDelta, formatMs, formatPercent as formatChange, formatShare } from "./perf-units";
import { readTreemap, type TreeNode } from "./treemap";
import { readWaterfall, type Span } from "./waterfall";
import { boxSummary, EDGES_ERROR, histogram, leftOutNote, readSample } from "./distribution";
import { groupByDay, readPlaces } from "./map";
import { coverageTone, formatPercent, headline, mostUncovered, percent, rangeLabel, readCoverage } from "./coverage";
import {
  countSeverities,
  readFindings,
  SEVERITIES,
  severityCount,
  severityLabel,
  sortFindings,
  statusCounts,
  statusSentence,
  verdictHeadline,
  type Severity,
} from "./findings";
import {
  GROUP_LABEL,
  groupOutdated,
  readDependencies,
  SEVERITIES as DEPENDENCY_SEVERITIES,
  splitChange,
  type OutdatedPackage,
  type Severity as DependencySeverity,
  type VulnerablePackage,
} from "./dependencies";
import { formatElapsed, jobCountsText, matrixPrefix, readPipeline, STATUS_LABEL, type PipelineJob, type PipelineStatus } from "./pipeline";
import { evaluate, initialState, isPlainObject } from "./evaluate";
import { compile } from "./index";
import {
  estimateTask,
  estimateTotals,
  estimateUnit,
  formatAmount,
  formatQuantity,
  formatWithUnit,
  initialChecks,
  joinAnd,
  leaderMargin,
  planTotal,
  rankOptions,
  readDecision,
  readEstimate,
  readPlan,
  round,
} from "./decisions";
import {
  ATTENTION_LABEL,
  CHANGE_LABEL,
  changeTotals,
  CHECKS_LABEL,
  checkCounts,
  MERGEABILITY_LABEL,
  parseChangesTarget,
  parseCommitLimit,
  parsePathFilter,
  parseThreadIds,
  PR_STATE_LABEL,
  projectRequestKey,
  relativeTime,
  REVIEW_LABEL,
  scopeLabel,
  threadStatusLabel,
  type ChangesView,
  type CommitsView,
  type Parsed,
  type ProjectRequest,
  type ProjectResult,
  type PullRequestView,
  type ThreadsView,
} from "./project";
import { previewText, threadActivityLabel } from "./thread-activity";
import { commonDirectory, displayPath, formatDuration, readTestRun, stripAnsi } from "./test-results";
import { firstError, foldRepeats, readLogs, LOG_LEVELS } from "./logs";
import { frameRows, memberPlaces, readTrace, relationLabel, type TraceFrame } from "./stack-trace";
import {
  aheadBehindLabel,
  defaultEnvironments,
  environmentTitle,
  kindLabel,
  LIFE_LABEL,
  liveThreads,
  threadSummary,
  uncommittedLabel,
  type EnvironmentInfo,
} from "./environments";
import {
  cardLate,
  formatDay,
  formatDays,
  formatRange,
  HEALTH_LABEL,
  healthSummary,
  itemDays,
  localDay,
  readBoard,
  readRoadmap,
  readStatus,
  relativeDue,
  ROADMAP_STATUS_LABEL,
  type BoardCard,
  type Health,
  type RoadmapStatus,
} from "./tracking";
import {
  chainSummary,
  readProvenance,
  RECEIPT_LABEL,
  shortValue,
  STAGE_STATUS_LABEL,
  type Evidence as ProvenanceEvidence,
  type Fact as ProvenanceFact,
} from "./provenance";
import { readScene, type Shape } from "./scene";
import { sameCaption, sourceCaption, sourceFileLabel, type SourceCaption } from "./source";
import type { UiNode, Value } from "./types";

const TONE_DOTS: Record<string, string> = { good: "🟢", warn: "🟠", bad: "🔴", info: "🔵", neutral: "⚪" };
const STEP_MARKERS: Record<string, string> = { done: "✅ ", current: "▶️ ", blocked: "⛔ " };

/** A readable, non-interactive markdown rendering of an evaluated UI, for clients that can't run it (mobile app, notifications, CLI). Uses the current state values. */
export function toMarkdown(roots: readonly UiNode[]): string {
  return paragraphs(blocks(roots, false));
}

/** compileStreaming/compile + initialState + evaluate + toMarkdown in one call; on compile failure returns the source in a ```ui fence so nothing is lost. */
export function specToMarkdown(source: string, data?: ReadonlyMap<string, LoadedData>): string {
  const { program } = compile(source);
  if (program === null) return fence(source, "ui");
  return toMarkdown(evaluate(program, initialState(program, data), data).roots);
}

function hasKind<K extends "node" | "action" | "binding">(
  value: Value | undefined,
  kind: K,
): value is Extract<Value, { readonly kind: K }> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind;
}

function list(value: Value | undefined): readonly Value[] {
  return Array.isArray(value) ? value : [];
}

function children(value: Value | undefined): UiNode[] {
  return list(value).filter((child) => hasKind(child, "node"));
}

/** A list item's fields by key; a non-object item stands for its `key` field (e.g. a bare string is a title). */
function fields(item: Value, key: string): { readonly [key: string]: Value } {
  // Narrowing keeps structurally compatible Action shapes; widen to read by key.
  return isPlainObject(item) ? item : { [key]: item };
}

/** A table lookup that ignores inherited keys, for free-form model text such as an item's `tone`. */
function lookup(table: Record<string, string>, key: string): string {
  return Object.hasOwn(table, key) ? table[key] : "";
}

function paragraphs(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n\n");
}

/** Lines under an optional `label:` line; just `label: —` when there are none. */
function labelledLines(label: string, lines: readonly string[]): string {
  if (lines.length === 0) return labelled(label, "—");
  return [...(label === "" ? [] : [`${label}:`]), ...lines].join("\n");
}

/**
 * One block per node. Consecutive Buttons share one `Options:` line; in a Row, so do consecutive Metrics.
 * A toned Icon is a dot prefixed to the next one-line block, or a block of its own when nothing follows.
 */
function blocks(nodes: readonly UiNode[], row: boolean): string[] {
  const out: string[] = [];
  let previous: UiNode["type"] | undefined;
  let icon = "";
  /** The run of Metrics the last line of a Row holds, rewritten as it grows so a shared source is named once. */
  let metrics: { readonly nodes: UiNode[]; readonly at: number; readonly prefix: string } | null = null;
  for (const node of nodes) {
    if (node.type === "Icon") {
      if (icon !== "") out.push(icon);
      icon = block(node);
    } else if (row && node.type === "Metric" && previous === "Metric" && metrics !== null) {
      metrics.nodes.push(node);
      out[metrics.at] = metrics.prefix + metricRun(metrics.nodes);
    } else if (node.type === previous && node.type === "Button") {
      out[out.length - 1] += ` · ${buttonLabel(node)}`;
    } else {
      const text = block(node);
      const prefixed = icon !== "" && text !== "" && !text.includes("\n") && !/^[|>#-]/.test(text);
      if (prefixed) {
        out.push(`${icon} ${text}`);
      } else {
        if (icon !== "") out.push(icon);
        out.push(text);
      }
      if (row && node.type === "Metric") metrics = { nodes: [node], at: out.length - 1, prefix: prefixed ? `${icon} ` : "" };
      icon = "";
    }
    previous = node.type;
  }
  if (icon !== "") out.push(icon);
  return out;
}

/** `Source: …` for a caption: the text as written, a URL as a link, loaded files by name. */
function sourceText(caption: SourceCaption): string {
  if (caption.kind === "text") return `Source: ${caption.text}`;
  if (caption.kind === "url") return `Source: ${link(caption.label, caption.url)}`;
  return `Source: ${caption.paths.map((path) => `\`${sourceFileLabel(path).replace(/`/g, "'")}\``).join(", ")}`;
}

/** Metrics side by side, `Label **value** — Source: …`; the source once at the end when they all share it. */
function metricRun(nodes: readonly UiNode[]): string {
  const captions = nodes.map((node) => sourceCaption(node.props));
  const after = (text: string, caption: SourceCaption | null) => (caption === null ? text : `${text} — ${sourceText(caption)}`);
  if (captions.every((caption) => sameCaption(caption, captions[0]))) return after(nodes.map(blockBody).join(" · "), captions[0]);
  return nodes.map((node, index) => after(blockBody(node), captions[index])).join(" · ");
}

/** A value as text on one logical line: components in block form, lists comma-separated. */
function inline(value: Value | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(inline).join(", ");
  // A component inside a table cell or a value has no source line of its own; the table's says it.
  if (hasKind(value, "node")) return value.type === "Button" ? buttonLabel(value) : blockBody(value);
  if (hasKind(value, "binding")) return inline(value.value);
  if (hasKind(value, "action")) return "";
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${inline(item)}`)
    .join(", ");
}

/** A Button as an option: its label, `⚠ `-marked when destructive; icons have no text form. */
function buttonLabel(node: UiNode): string {
  return `${node.props.variant === "destructive" ? "⚠ " : ""}${inline(node.props.label)}`;
}

/** A GFM table cell: one line, `|` escaped. */
function cell(value: Value): string {
  return inline(value).replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "\\|");
}

function table(columns: readonly Value[], rows: readonly Value[]): string {
  const header = columns.map(cell);
  const body = rows.map((row) => (Array.isArray(row) ? row : [row]).map(cell));
  const width = body.reduce((widest, cells) => Math.max(widest, cells.length), header.length);
  if (width === 0) return "";
  const line = (cells: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [line(header), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

/** A fenced block whose fence is longer than any backtick run inside. */
function fence(code: string, language: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

/** An input's label (its bound state's name when unlabeled) and current value. */
function field(node: UiNode): { readonly label: string; readonly value: Value } {
  const binding = node.props.value;
  const name = hasKind(binding, "binding") ? binding.name : "";
  const label = inline(node.props.label) || name.charAt(0).toUpperCase() + name.slice(1);
  return { label, value: hasKind(binding, "binding") ? binding.value : null };
}

function labelled(label: string, text: string): string {
  return label === "" ? text : `${label}: ${text}`;
}

function finite(value: Value | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A sum without float noise (0.1 + 0.2 → 0.3); null when nothing is a number. */
function total(values: readonly Value[]): number | null {
  const numbers = values.filter(finite);
  return numbers.length === 0 ? null : Number(numbers.reduce((sum, n) => sum + n, 0).toPrecision(12));
}

/** A Snippet's location: `path`, `path:12` or `path:12-20`. */
function location(path: Value | undefined, from: Value | undefined, to: Value | undefined): string {
  const start = finite(from) ? from : finite(to) ? 1 : null;
  const range = start === null ? "" : finite(to) && to !== start ? `:${start}-${to}` : `:${start}`;
  return `\`${inline(path)}${range}\``;
}

/** KeyValue pairs from an object, or from `[label, value]` / `{label, value}` list items. */
function pairs(value: Value | undefined): [Value, Value][] {
  if (value !== undefined && isPlainObject(value)) return Object.entries(value);
  return list(value).flatMap((item): [Value, Value][] => {
    if (Array.isArray(item)) return item.length >= 2 ? [[item[0], item[1]]] : [];
    const pair = fields(item, "");
    if (isPlainObject(item) && Object.hasOwn(pair, "label")) return [[pair.label, pair.value ?? null]];
    return [];
  });
}

interface TreeEntry {
  readonly label: string;
  note: string;
  folder: boolean;
  readonly children: TreeEntry[];
}

function treeEntry(level: TreeEntry[], label: string): TreeEntry {
  const existing = level.find((entry) => entry.label === label);
  if (existing !== undefined) return existing;
  const entry: TreeEntry = { label, note: "", folder: false, children: [] };
  level.push(entry);
  return entry;
}

/** Merges path strings ("src/a.ts", "docs/") and `{label, children?, note?}` objects into one tree, in first-seen order. */
function treeEntries(items: readonly Value[], into: TreeEntry[]): TreeEntry[] {
  for (const item of items) {
    if (typeof item === "string" || typeof item === "number") {
      const path = String(item).trim();
      const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
      let level = into;
      segments.forEach((segment, index) => {
        const entry = treeEntry(level, segment);
        if (index < segments.length - 1 || path.endsWith("/")) entry.folder = true;
        level = entry.children;
      });
    } else if (isPlainObject(item)) {
      const node = fields(item, "");
      const raw = inline(node.label).trim();
      const label = raw.replace(/\/+$/, "");
      if (label === "") continue;
      const entry = treeEntry(into, label);
      const note = inline(node.note);
      if (note !== "") entry.note = note;
      if (raw !== label || Array.isArray(node.children)) entry.folder = true;
      treeEntries(list(node.children), entry.children);
    }
  }
  return into;
}

function treeLines(entries: readonly TreeEntry[], depth: number): string[] {
  return entries.flatMap((entry) => [
    `${"  ".repeat(depth)}- ${entry.label}${entry.folder || entry.children.length > 0 ? "/" : ""}${entry.note === "" ? "" : ` — ${entry.note}`}`,
    ...treeLines(entry.children, depth + 1),
  ]);
}

/** `m:ss`, or `h:mm:ss` from an hour. */
function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** A part's whole-percent share of `sum`; a sliver reads `<1%`, never 0%. Empty without a total. */
function wholeShare(part: number, sum: number): string {
  if (!(sum > 0)) return "";
  const share = part / sum;
  return share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** Outliers a box row lists before it only counts the rest. */
const MAX_OUTLIERS = 8;

/** A stage-to-stage rate as on screen: whole from 10%, one decimal below, `<0.1%` for slivers. */
function conversion(ratio: number): string {
  const percent = ratio * 100;
  if (percent === 0) return "0%";
  if (Math.abs(percent) < 0.1) return "<0.1%";
  return `${Number(percent.toFixed(Math.abs(percent) < 10 ? 1 : 0))}%`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A CalendarHeatmap as text: its total and busiest day, then each day when
 * there are up to two weeks of them, else a row per month. Dates stay
 * strings throughout, so no time zone can move one.
 */
function calendarMarkdown(label: string, days: Value | undefined): string {
  const entries: [Value | undefined, Value | undefined][] =
    days !== undefined && isPlainObject(days)
      ? Object.entries(days)
      : list(days).map((item) => {
          if (Array.isArray(item)) return [item[0], item[1] ?? 1];
          const day = fields(item, "date");
          return [day.date, day.value === undefined ? 1 : day.value];
        });
  const sums = new Map<string, number>();
  for (const [date, value] of entries) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !finite(value)) continue;
    sums.set(date, (sums.get(date) ?? 0) + value);
  }
  const dates = [...sums.keys()].sort();
  if (dates.length === 0) return labelled(label, "—");
  const busiest = (within: readonly string[]) =>
    within.reduce((best, date) => (sums.get(date)! > sums.get(best)! ? date : best));
  const peak = busiest(dates);
  const summary = labelled(
    label,
    `**${total(dates.map((date) => sums.get(date)!))}** total, ${dates[0]} to ${dates[dates.length - 1]}; busiest ${peak} (${sums.get(peak)})`,
  );
  if (dates.length <= 14) {
    return paragraphs([summary, table(["Date", label || "Value"], dates.map((date) => [date, sums.get(date)!]))]);
  }
  const months = new Map<string, string[]>();
  for (const date of dates) months.set(date.slice(0, 7), [...(months.get(date.slice(0, 7)) ?? []), date]);
  return paragraphs([
    summary,
    table(
      ["Month", "Total", "Active days", "Busiest"],
      [...months].map(([month, within]) => {
        const top = busiest(within);
        return [
          `${MONTH_NAMES[Number(month.slice(5)) - 1] ?? month} ${month.slice(0, 4)}`,
          total(within.map((date) => sums.get(date)!)),
          within.filter((date) => sums.get(date)! > 0).length,
          `${top} (${sums.get(top)})`,
        ];
      }),
    ),
  ]);
}

/** A node's markdown; a Table, Chart or Metric says where its numbers come from. */
function block(node: UiNode): string {
  if (node.type === "Metric") return metricRun([node]);
  if (node.type !== "Table" && node.type !== "Chart") return blockBody(node);
  const caption = sourceCaption(node.props);
  return paragraphs([blockBody(node), caption === null ? "" : sourceText(caption)]);
}

function blockBody(node: UiNode): string {
  const props = node.props;
  switch (node.type) {
    case "Card": {
      const title = inline(props.title);
      return paragraphs([title === "" ? "" : `**${title}**`, ...blocks(children(props.children), false)]);
    }
    case "Details":
      return paragraphs([`**${inline(props.title)}**`, ...blocks(children(props.children), false)]);
    case "Row":
      return paragraphs(blocks(children(props.children), true));
    case "Stack":
    case "Grid":
      return paragraphs(blocks(children(props.children), false));
    case "Divider":
      return "---";
    case "Text":
      return inline(props.text);
    case "Callout": {
      const title = inline(props.title);
      const text = inline(props.text);
      const dot = lookup(TONE_DOTS, inline(props.tone) || "info");
      const content = title === "" ? `${dot} ${text}` : paragraphs([`${dot} **${title}**`, text]);
      // Every line quoted; blank lines stay inside the quote.
      return content
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    }
    case "Icon":
      return lookup(TONE_DOTS, inline(props.tone));
    case "Metric": {
      const note = inline(props.note);
      return `${inline(props.label)} **${inline(props.value)}**${note === "" ? "" : ` (${note})`}`;
    }
    case "Badge":
      return `${TONE_DOTS[inline(props.tone) || "neutral"]} ${inline(props.text)}`;
    case "KeyValue": {
      const entries = pairs(props.pairs);
      if (entries.length > 3) return table(["", ""], entries);
      // Two trailing spaces: a hard line break, so the pairs stay on separate lines.
      return entries.map(([key, value]) => `**${inline(key)}:** ${inline(value)}`).join("  \n");
    }
    case "Image": {
      const src = inline(props.src).trim();
      const alt = inline(props.alt).trim();
      if (/^https:\/\//i.test(src)) {
        const escapes: Record<string, string> = { " ": "%20", "(": "%28", ")": "%29" };
        return `![${alt.replace(/[[\]\\]/g, "\\$&")}](${src.replace(/[ ()]/g, (c) => escapes[c])})`;
      }
      // Text clients can't load workspace files: name the image and where it is.
      return `🖼 ${alt === "" ? src : `${alt} (${src})`}`;
    }
    case "Table":
      return table(list(props.columns), list(props.rows));
    case "Chart": {
      const unit = inline(props.unit).trim();
      const withUnit = (name: string) => (unit === "" ? name : `${name} (${unit})`);
      const series = props.series;
      const named: [string, readonly Value[]][] = Array.isArray(series)
        ? [["Value", series]]
        : isPlainObject(series)
          ? Object.entries(series).map(([name, values]) => [name, list(fields(values, "values").values)])
          : [];
      const labels = list(props.labels);
      if (props.type === "histogram" || props.type === "box") {
        const samples = named.map(([name, values]) => readSample(name, values));
        const dropped = samples.reduce((all, sample) => all + sample.dropped, 0);
        let shown: string;
        let note: string | null;
        if (props.type === "box") {
          // One row per group: its five-number summary and what lies beyond the whiskers.
          const rows = samples.map((sample) => {
            const name = Array.isArray(series) ? inline(labels[0]) || sample.name : sample.name;
            const box = boxSummary(sample.values);
            if (box === null) return [name, 0];
            const outliers = box.outliers.slice(0, MAX_OUTLIERS).join(", ");
            const more = box.outliers.length - MAX_OUTLIERS;
            return [name, box.n, box.min, box.q1, box.median, box.q3, box.max, more > 0 ? `${outliers} and ${more} more` : outliers];
          });
          // The group column's header carries the unit every value column is in.
          shown = table([unit === "" ? "" : `(${unit})`, "n", "min", "Q1", "median", "Q3", "max", "outliers"], rows);
          note = leftOutNote(dropped, 0);
        } else {
          const bins = histogram(labels, samples.map((sample) => sample.values));
          if (bins === null) return `_${EDGES_ERROR}_`;
          shown = table(
            [withUnit("Range"), ...(Array.isArray(series) ? ["Count"] : samples.map((sample) => sample.name))],
            bins.edges.slice(1).map((to, index) => [`${bins.edges[index]}–${to}`, ...bins.counts.map((counts) => counts[index]!)]),
          );
          note = leftOutNote(dropped, bins.outside);
        }
        return paragraphs([shown, note === null ? "" : `_${note}_`]);
      }
      if (props.type === "pie") {
        // A pie has one series; its slices are shares of the positive total.
        const [name, values] = named[0] ?? ["Value", []];
        const slices = labels.map((_, index) => {
          const value = values[index];
          return finite(value) && value > 0 ? value : 0;
        });
        const sum = slices.reduce((all, slice) => all + slice, 0);
        return table(
          ["", withUnit(name), "%"],
          labels.map((label, index) => [label, values[index] ?? null, wholeShare(slices[index], sum)]),
        );
      }
      if (props.type === "funnel") {
        // A funnel has one series too: each stage against the first and the one before.
        const [name, values] = named[0] ?? ["Value", []];
        const first = values[0];
        return table(
          ["", withUnit(name), "% of first", "% of previous"],
          labels.map((label, index) => {
            const value = values[index];
            const previous = values[index - 1];
            return [
              label,
              value ?? null,
              index > 0 && finite(value) && finite(first) && first > 0 ? conversion(value / first) : "",
              finite(value) && finite(previous) && previous > 0 ? conversion(value / previous) : "",
            ];
          }),
        );
      }
      if (props.type === "heatmap") {
        // Laid out as on screen: labels across, one row per series.
        return table([unit, ...labels], named.map(([name, values]) => [name, ...labels.map((_, index) => values[index] ?? null)]));
      }
      const stacked = props.stacked === true && named.length > 1 && (props.type === "bar" || props.type === "area");
      return table(
        [props.type === "scatter" ? "x" : "", ...named.map(([name]) => withUnit(name)), ...(stacked ? [withUnit("Total")] : [])],
        labels.map((label, index) => {
          const values = named.map(([, values]) => values[index] ?? null);
          return [label, ...values, ...(stacked ? [total(values)] : [])];
        }),
      );
    }
    case "Sparkline": {
      const values = list(props.values).filter(finite);
      if (values.length < 2) return values.map(String).join("");
      return `${values[0]} → ${values[values.length - 1]} (min ${Math.min(...values)}, max ${Math.max(...values)})`;
    }
    case "Progress": {
      const value = Number(props.value);
      const max = props.max;
      const amount =
        typeof max !== "number" ? `${value}%` : `${value}/${max}${max === 0 ? "" : ` (${Math.round((value / max) * 100)}%)`}`;
      return labelled(inline(props.label), amount);
    }
    case "Steps":
      return list(props.items)
        .map((item, index) => {
          const step = fields(item, "title");
          const detail = inline(step.detail);
          const marker = lookup(STEP_MARKERS, inline(step.status));
          return `${index + 1}. ${marker}${inline(step.title)}${detail === "" ? "" : ` — ${detail}`}`;
        })
        .join("\n");
    case "Timeline":
      return list(props.items)
        .map((item) => {
          const event = fields(item, "title");
          const dot = lookup(TONE_DOTS, inline(event.tone));
          const head = [inline(event.time), inline(event.title)].filter((part) => part !== "").join(" · ");
          const detail = inline(event.detail);
          return `- ${dot === "" ? "" : `${dot} `}${head}${detail === "" ? "" : ` — ${detail}`}`;
        })
        .join("\n");
    case "Tree":
      return treeLines(treeEntries(list(props.items), []), 0).join("\n");
    case "Tabs": {
      const labels = list(props.labels);
      return paragraphs(
        children(props.children).map((child, index) => {
          const label = inline(labels[index]);
          return paragraphs([label === "" ? "" : `**${label}**`, block(child)]);
        }),
      );
    }
    case "Code":
      return fence(inline(props.code), inline(props.language));
    case "Snippet": {
      const where = location(props.path, props.from, props.to);
      const error = inline(props.error);
      if (error !== "") return `${where} _(error: ${error})_`;
      return typeof props.code === "string" ? `${where}\n${fence(props.code, inline(props.language))}` : where;
    }
    case "Diff":
      return fence(inline(props.patch), "diff");
    case "Diagram":
      return diagramMarkdown(inline(props.mermaid), props.details);
    case "File": {
      const line = inline(props.line);
      return `\`${inline(props.path)}${line === "" ? "" : `:${line}`}\``;
    }
    case "Slider": {
      const { label, value } = field(node);
      return labelled(label, `${inline(value) || "—"} (${inline(props.min)}–${inline(props.max)})`);
    }
    case "Toggle": {
      const { label, value } = field(node);
      return labelled(label, value === true ? "on" : "off");
    }
    case "Choice":
    case "Select": {
      const { label, value } = field(node);
      return labelled(label, `${inline(value) || "—"} (${list(props.options).map(inline).join(", ")})`);
    }
    case "Radio": {
      const { label, value } = field(node);
      const options = list(props.options).map((item) => {
        const option = fields(item, "value");
        const picked = value !== null && option.value === value;
        const detail = inline(option.detail);
        return `- ${picked ? "◉" : "○"} ${inline(option.label ?? option.value)}${detail === "" ? "" : ` — ${detail}`}`;
      });
      return labelledLines(label, options);
    }
    case "Checklist": {
      const { label, value } = field(node);
      const picked = list(value);
      const items = list(props.options).map((option) => `- [${picked.includes(option) ? "x" : " "}] ${inline(option)}`);
      return [label === "" ? "" : `${label}:`, ...items].filter((line) => line !== "").join("\n");
    }
    case "ListEditor": {
      const { label, value } = field(node);
      return labelledLines(
        label,
        list(value).map((item) => `- ${inline(item)}`),
      );
    }
    case "Stepper":
    case "Input":
    case "TextArea":
    case "DateInput": {
      const { label, value } = field(node);
      return labelled(label, inline(value) || "—");
    }
    case "Rating": {
      const { label, value } = field(node);
      const max = finite(props.max) ? Math.min(10, Math.max(1, Math.round(props.max))) : 5;
      const stars = finite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;
      return labelled(label, `${"★".repeat(stars)}${"☆".repeat(max - stars)} (${stars}/${max})`);
    }
    case "Button":
      return `Options: ${buttonLabel(node)}`;
    case "Form":
      return paragraphs(blocks(children(props.children), false));
    case "Timer": {
      const seconds = props.seconds;
      return `⏱ ${labelled(inline(props.label), finite(seconds) && seconds > 0 ? `${clock(seconds)} countdown` : "stopwatch")}`;
    }
    case "Quiz":
      return paragraphs(
        list(props.questions).map((item, index) => {
          const question = fields(item, "q");
          const marker = `${index + 1}. `;
          const indent = " ".repeat(marker.length);
          const options = list(question.options);
          const answer = question.answer;
          const correct =
            typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < options.length
              ? `${String.fromCharCode(65 + answer)}. ${inline(options[answer])}`
              : "";
          const why = inline(question.why);
          const verdict = [correct, why].filter((part) => part !== "").join(" — ");
          return [
            `${marker}${inline(question.q ?? question.question)}`,
            ...options.map((option, at) => `${indent}- ${String.fromCharCode(65 + at)}. ${inline(option)}`),
            // A paragraph of its own after the options, so it reads as the reveal rather than another option.
            ...(verdict === "" ? [] : ["", `${indent}**Answer:** ${verdict}`]),
          ].join("\n");
        }),
      );
    case "Flashcards":
      return list(props.cards)
        .map((item) => {
          const card = fields(item, "front");
          const back = inline(card.back);
          return `- ${inline(card.front)}${back === "" ? "" : ` → ${back}`}`;
        })
        .join("\n");
    case "Carousel":
      return paragraphs(blocks(children(props.children), false));
    case "OptionCards": {
      const { label, value } = field(node);
      const multiple = Array.isArray(value);
      const options = list(props.options).flatMap((item) => {
        const option = fields(item, "value");
        const chosen = option.value ?? option.title;
        if (chosen === undefined || chosen === null) return [];
        const picked = multiple ? list(value).includes(chosen) : chosen === value;
        const marker = multiple ? `[${picked ? "x" : " "}]` : picked ? "◉" : "○";
        const detail = inline(option.detail);
        return [`- ${marker} ${inline(option.title ?? chosen)}${detail === "" ? "" : ` — ${detail}`}`];
      });
      return labelledLines(label, options);
    }
    case "Swatches": {
      // Unbound it is a palette: no value, no picked marker.
      const bound = hasKind(props.value, "binding");
      const { label, value } = field(node);
      const colors = list(props.colors).flatMap((item) => {
        const color = fields(item, "value");
        const css = inline(color.value).trim();
        if (css === "") return [];
        const name = inline(color.name).trim();
        // Colours compare without case or surrounding space.
        const picked = typeof value === "string" && value.trim().toLowerCase() === css.toLowerCase();
        const marker = !bound ? "" : picked ? "◉ " : "○ ";
        return [`- ${marker}${name === "" ? "" : `${name} `}\`${css}\``];
      });
      return labelledLines(label, colors);
    }
    case "EditableTable": {
      const { label, value } = field(node);
      const columns = editableColumns(props.columns);
      const rows = list(value).map((item) => {
        const row = fields(item, "");
        return columns.map(({ key }) => {
          const cell = Object.hasOwn(row, key) ? row[key] : null;
          return typeof cell === "boolean" ? (cell ? "✓" : "✗") : cell;
        });
      });
      return paragraphs([
        label === "" ? "" : `${label}:`,
        rows.length === 0 ? "—" : table(columns.map((column) => column.label), rows),
      ]);
    }
    case "FollowUps": {
      const prompts = list(props.prompts)
        .map((prompt) => inline(prompt).trim())
        .filter((prompt) => prompt !== "");
      return prompts.length === 0 ? "" : ["Follow-ups:", ...prompts.map((prompt) => `- ${prompt}`)].join("\n");
    }
    case "Entity": {
      const name = inline(props.name).trim();
      const kind = inline(props.kind);
      const url = webUrl(inline(props.url), ["http:", "https:"]);
      // A file image is decoration text clients can't load; an https one shows.
      const image = remoteImage(inline(props.image), name);
      return paragraphs([
        image ?? "",
        `**${name}**${Object.hasOwn(ENTITY_KINDS, kind) ? ` · ${ENTITY_KINDS[kind]}` : ""}`,
        inline(props.note).trim(),
        pairs(props.facts)
          .map(([key, value]) => `**${inline(key)}:** ${inline(value)}`)
          .join("  \n"),
        url === null ? "" : `🔗 ${link(url.host.replace(/^www\./i, ""), url)}`,
      ]);
    }
    case "Sources": {
      const lines = list(props.links).flatMap((item, index) => {
        const source = fields(item, "url");
        const raw = inline(source.url).trim();
        // A streaming `{title: …` has not reached its url yet.
        if (raw === "" && index === list(props.links).length - 1) return [];
        const marker = `${index + 1}. `;
        const url = webUrl(raw, ["https:"]);
        if (url === null) return [`${marker}${raw || "—"} _(not an https link)_`];
        const domain = url.host.replace(/^www\./i, "");
        const title = inline(source.title).trim();
        const note = inline(source.note).trim();
        const about = [title === "" ? "" : domain, note].filter((part) => part !== "").join(" · ");
        return [`${marker}${link(title || domain, url)}${about === "" ? "" : ` — ${about}`}`];
      });
      return lines.length === 0 ? "" : ["Sources:", ...lines].join("\n");
    }
    case "Hotspots": {
      const src = inline(props.image).trim();
      const points = list(props.points).flatMap((item, index) => {
        const point = fields(item, "title");
        const title = inline(point.title).trim() || `Point ${index + 1}`;
        const body = inline(point.text).trim();
        const marker = `${index + 1}. `;
        // Continuation lines indented under the item, so a multi-paragraph text stays in it.
        const text = body.replace(/\n(?=[^\n])/g, `\n${" ".repeat(marker.length)}`);
        return [`${marker}**${title}**${body === "" ? "" : ` — ${text}`}`];
      });
      return paragraphs([remoteImage(src, "") ?? (src === "" ? "" : `🖼 ${src}`), points.join("\n")]);
    }
    case "ImageSearch": {
      const query = inline(props.query).trim();
      return searchedImage(query, inline(props.alt).trim() || query);
    }
    case "Gallery":
      return paragraphs(list(props.images).map(galleryImage));
    case "Map":
      return placeList(list(props.places), props.route === true);
    case "Gauge": {
      const min = finite(props.min) ? props.min : 0;
      const max = finite(props.max) ? props.max : 100;
      return labelled(inline(props.label), `**${inline(props.value)}** (${min}–${max})`);
    }
    case "CalendarHeatmap":
      return calendarMarkdown(inline(props.label), props.days);
    case "SegmentedBar": {
      const unit = inline(props.unit).trim();
      const parts = list(props.parts)
        .map((part) => fields(part, "label"))
        .filter((part) => finite(part.value) && part.value >= 0);
      const sum = parts.reduce((all, part) => all + (part.value as number), 0);
      return table(
        ["", unit === "" ? "Value" : `Value (${unit})`, "%"],
        parts.map((part) => {
          const dot = lookup(TONE_DOTS, inline(part.tone));
          return [`${dot === "" ? "" : `${dot} `}${inline(part.label)}`, part.value, wholeShare(part.value as number, sum)];
        }),
      );
    }
    case "Walkthrough":
      return paragraphs(
        list(props.steps).map((item, index) => {
          const step = fields(item, "body");
          const title = inline(step.title).trim();
          const code = inline(step.code);
          return paragraphs([
            `**${index + 1}.${title === "" ? "" : ` ${title}`}**`,
            inline(step.body).trim(),
            code.trim() === "" ? "" : fence(code, inline(step.language).trim()),
          ]);
        }),
      );
    case "List":
      return list(props.items)
        .flatMap((item) => {
          const row = fields(item, "title");
          const title = inline(row.title).trim();
          if (title === "") return [];
          const dot = lookup(TONE_DOTS, inline(row.tone));
          // A row that opens a link reads as that link; other actions have no text form.
          const actions: readonly (Value | undefined)[] = Array.isArray(row.action) ? row.action : [row.action];
          const url =
            actions.flatMap((action) =>
              hasKind(action, "action") && action.type === "openUrl" ? [webUrl(action.url, ["http:", "https:"])] : [],
            )[0] ?? null;
          const tail = [inline(row.detail).trim(), inline(row.value).trim()].filter((part) => part !== "").join(" · ");
          return [`- ${dot === "" ? "" : `${dot} `}${url === null ? `**${title}**` : link(title, url)}${tail === "" ? "" : ` — ${tail}`}`];
        })
        .join("\n");
    case "Calendar":
      return eventCalendarMarkdown(list(props.events), inline(props.month));
    case "Changes":
    case "Commits":
    case "PullRequest":
    case "Threads":
      return projectMarkdown(node);
    case "Tests":
      return testsMarkdown(props.results, inline(props.title));
    case "Json":
      return jsonMarkdown(props.value ?? null, inline(props.label));
    case "Plan":
      return planMarkdown(props.steps);
    case "Decision":
      return decisionMarkdown(props.options, props.criteria);
    case "Estimate":
      return estimateMarkdown(props.tasks, props.unit);
    case "Environments":
      return environmentsMarkdown();
    case "Findings":
      return findingsMarkdown(props.items, inline(props.title));
    case "Coverage":
      return coverageMarkdown(props.report);
    case "Board":
      return boardMarkdown(props.items, props.columns, localDay(new Date()));
    case "Roadmap":
      return roadmapMarkdown(props.items, localDay(new Date()));
    case "Status":
      return statusMarkdown(props.items, localDay(new Date()));
    case "Benchmark":
      return benchmarkMarkdown(props.results, inline(props.unit).trim() || null);
    case "Waterfall":
      return waterfallMarkdown(props.spans, inline(props.unit).trim() || null);
    case "Treemap":
      return treemapMarkdown(props.items, inline(props.unit).trim() || null);
    case "Logs":
      return logsMarkdown(props.output, inline(props.command).trim(), props.exit);
    case "StackTrace":
      return stackTraceMarkdown(props.trace, inline(props.title).trim());
    case "Pipeline":
      return pipelineMarkdown(props.run);
    case "Dependencies":
      return dependenciesMarkdown(props.report);
    case "Compare":
      return compareMarkdown(props.images);
    case "Provenance":
      return provenanceMarkdown(props.stages, props.expected);
    case "Acceptance":
      return acceptanceMarkdown(props.criteria, props.columns);
    case "Transcript":
      return transcriptMarkdown(props.tracks, inline(props.audio).trim());
    case "Scene":
      return sceneMarkdown(props.objects);
    case "Shader": {
      const passes = 1 + list(props.buffers).length;
      return `_GPU shader (${passes} pass${passes === 1 ? "" : "es"}). Open this reply in BB to see it._`;
    }
    case "Error":
      return `_(error: ${inline(props.message)})_`;
    case "Loading":
      return `_(loading ${inline(props.path)})_`;
  }
}

const SHAPE_PLURALS: Record<Shape, string> = {
  box: "boxes", sphere: "spheres", cylinder: "cylinders", surface: "surfaces", mesh: "meshes", line: "lines", path: "paths",
  point: "points", label: "labels", grid: "grids", axes: "axes", model: "models", environment: "environments", sprite: "sprites",
};

/** "_3D scene: 3 spheres, 1 surface. …_": what the scene holds at t = 0, by shape in first-seen order. */
function sceneMarkdown(objects: Value | undefined): string {
  const counts = new Map<Shape, number>();
  for (const object of readScene(objects ?? null, 0).objects) {
    // Lighting and the floor aren't things a reader would count.
    if (object.shape === "environment" || object.shape === "grid" || object.shape === "axes") continue;
    counts.set(object.shape, (counts.get(object.shape) ?? 0) + 1);
  }
  const parts = [...counts].map(([shape, count]) => `${count} ${count === 1 ? shape : SHAPE_PLURALS[shape]}`);
  return `_3D scene${parts.length === 0 ? "" : `: ${parts.join(", ")}`}. Open this reply in BB to turn it._`;
}

/** EditableTable columns: keys or `{key, label?}`; a bare key is its own label, capitalized. */
function editableColumns(value: Value | undefined): { readonly key: string; readonly label: string }[] {
  return list(value).flatMap((item) => {
    const column = fields(item, "key");
    const key = inline(column.key).trim();
    if (key === "") return [];
    return [{ key, label: inline(column.label).trim() || key.charAt(0).toUpperCase() + key.slice(1) }];
  });
}

const ENTITY_KINDS: Record<string, string> = {
  product: "Product",
  place: "Place",
  person: "Person",
  org: "Organisation",
  link: "Link",
};

/** An absolute URL with one of `protocols` (`"https:"`) and a host, or null. */
function webUrl(raw: string, protocols: readonly string[]): URL | null {
  try {
    const url = new URL(raw.trim());
    return protocols.includes(url.protocol) && url.hostname !== "" ? url : null;
  } catch {
    return null;
  }
}

/** `[label](url)` with the label's brackets escaped and the URL safe inside the parentheses. */
function link(label: string, url: URL): string {
  return `[${label.replace(/[[\]\\]/g, "\\$&")}](${url.href.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))})`;
}

/** An https image as markdown (text clients can fetch it); null for files and anything else. */
function remoteImage(src: string, alt: string): string | null {
  const url = webUrl(src, ["https:"]);
  return url === null ? null : `!${link(alt, url)}`;
}

/** A photo an image search found, with its credit (web/commons.ts `FoundImage`). */
export interface SearchedImage {
  readonly url: string;
  readonly creator: string;
  readonly license: string;
  readonly sourceUrl: string;
}

/**
 * The image searches and Wikipedia photos of the rendering in progress, by
 * query and by article title. block() is synchronous, so toMarkdownWithImages
 * can hold them here for one call.
 */
let searched: ReadonlyMap<string, SearchedImage | null> = new Map();
let wikiFound: ReadonlyMap<string, SearchedImage | null> = new Map();

/**
 * toMarkdown with ImageSearch and Gallery `{query}` items shown as the photos
 * `images` found for them (see imageSearches), and Map places as the photos
 * `photos` found for their Wikipedia articles (see wikiPhotos).
 */
export function toMarkdownWithImages(
  roots: readonly UiNode[],
  images: ReadonlyMap<string, SearchedImage | null>,
  photos: ReadonlyMap<string, SearchedImage | null> = new Map(),
): string {
  searched = images;
  wikiFound = photos;
  try {
    return toMarkdown(roots);
  } finally {
    searched = new Map();
    wikiFound = new Map();
  }
}

/** Calls `found` for every node in evaluated `roots`, children and nodes inside props included. */
function eachNode(roots: readonly UiNode[], found: (node: UiNode) => void): void {
  const visit = (value: Value | undefined): void => {
    if (value === undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (hasKind(value, "node")) {
      found(value);
      Object.values(value.props).forEach(visit);
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(visit);
    }
  };
  roots.forEach(visit);
}

/** The image searches in evaluated nodes (ImageSearch queries, Gallery `{query}` items), in order, without repeats. */
export function imageSearches(roots: readonly UiNode[]): string[] {
  const queries = new Set<string>();
  eachNode(roots, (node) => {
    if (node.type === "ImageSearch") queries.add(inline(node.props.query).trim());
    if (node.type === "Gallery") {
      for (const item of list(node.props.images)) {
        const image = fields(item, "src");
        if (inline(image.src).trim() === "") queries.add(inline(image.query).trim());
      }
    }
  });
  queries.delete("");
  return [...queries];
}

/** The Wikipedia articles Map places name for their photos, in order, without repeats. */
export function wikiPhotos(roots: readonly UiNode[]): string[] {
  const titles = new Set<string>();
  eachNode(roots, (node) => {
    if (node.type !== "Map") return;
    for (const place of readPlaces(list(node.props.places))) if (place?.wiki) titles.add(place.wiki);
  });
  return [...titles];
}

/** A found photo as markdown, and its credit line; null when it can't be shown (no https image or source page). */
function creditedPhoto(found: SearchedImage | null | undefined, alt: string): { readonly image: string; readonly credit: string } | null {
  const image = found ? remoteImage(found.url, alt) : null;
  const source = found ? webUrl(found.sourceUrl, ["https:"]) : null;
  if (!found || image === null || source === null) return null;
  const credit = `${found.creator}, ${found.license}`.replace(/[*_`[\]\\]/g, "\\$&");
  return { image, credit: `_Photo: ${credit}, ${link("Wikimedia Commons", source)}_` };
}

/**
 * A searched photo, then its caption and credit on lines of their own (two
 * trailing spaces break the line). Without a result (none found, lookups off,
 * plain toMarkdown) it is named instead.
 */
function searchedImage(query: string, alt: string, caption = ""): string {
  const photo = creditedPhoto(searched.get(query), alt);
  if (photo === null) return `🖼 ${caption || alt}`;
  return [photo.image, caption, photo.credit].filter((line) => line !== "").join("  \n");
}

/** One Gallery item: a path, an https URL, or `{src|query, caption?}`. */
function galleryImage(item: Value): string {
  const image = fields(item, "src");
  const caption = inline(image.caption).trim();
  const src = inline(image.src).trim();
  const query = inline(image.query).trim();
  const alt = inline(image.alt).trim() || caption || query;
  if (src === "") return query === "" ? "" : searchedImage(query, alt, caption);
  const remote = remoteImage(src, alt);
  if (remote === null) return `🖼 ${caption === "" ? src : `${caption} (${src})`}`;
  return caption === "" ? remote : `${remote}  \n${caption}`;
}

/**
 * A Map as a numbered list, each place linked on OpenStreetMap (its pin, or a
 * search for its name), under a heading per day when places have days, with
 * the place's Wikipedia photo and its credit when one was found. Numbered and
 * joined in the order the map numbers them (groupByDay).
 */
function placeList(items: readonly Value[], route: boolean): string {
  const places = readPlaces(items);
  let number = 0;
  return paragraphs(
    groupByDay(places).map(({ label, places: indexes }) => {
      const day = indexes.flatMap((index) => places[index] ?? []);
      const lines = day.map(({ name, note, given, wiki }) => {
        number += 1;
        const url =
          given === null
            ? new URL(`https://www.openstreetmap.org/search?query=${encodeURIComponent(name)}`)
            : new URL(`https://www.openstreetmap.org/?mlat=${given.lat}&mlon=${given.lng}#map=15/${given.lat}/${given.lng}`);
        const marker = `${number}. `;
        const head = `${marker}**${name}**${note === null ? "" : ` — ${note}`} · ${link("OpenStreetMap", url)}`;
        const photo = wiki === null ? null : creditedPhoto(wikiFound.get(wiki), name);
        // Hard breaks keep the photo and its credit inside the list item, under its text.
        const indent = " ".repeat(marker.length);
        return photo === null ? head : `${head}  \n${indent}${photo.image}  \n${indent}${photo.credit}`;
      });
      const order = route && day.length > 1 ? `Route: ${day.map((place) => place.name).join(" → ")}` : "";
      const heading = [label === null ? "" : `**${label}**`, order].filter((part) => part !== "").join(" · ");
      return paragraphs([heading, lines.join("\n")]);
    }),
  );
}

/**
 * The label a mermaid source gives node `id` (`crank[Crankset]`, `a((Hub))`,
 * `b{"Ok?"}`), or the id itself.
 */
function mermaidLabel(source: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[\\s;&>-])${escaped}\\s*[[({>]+\\s*"?([^"\\])}\\n]+?)"?\\s*[\\])}]`, "m").exec(source);
  return match?.[1]?.trim() || id;
}

/** The mermaid fence, then each node's detail under the node's label. */
function diagramMarkdown(source: string, details: Value | undefined): string {
  const entries = details !== undefined && isPlainObject(details) ? Object.entries(details) : [];
  return paragraphs([
    fence(source, "mermaid"),
    ...entries.map(([id, detail]) => {
      const parts = (Array.isArray(detail) ? detail : [detail]).map((part) =>
        hasKind(part, "node") ? block(part) : inline(part).trim(),
      );
      const [first = "", ...rest] = parts.filter((part) => part !== "");
      if (first === "") return "";
      const label = `**${mermaidLabel(source, id)}**`;
      // Text joins the label on one line; a component goes under it.
      const firstIsText = !hasKind(Array.isArray(detail) ? detail[0] : detail, "node");
      return paragraphs(firstIsText ? [`${label} — ${first}`, ...rest] : [label, first, ...rest]);
    }),
  ]);
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LONG = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** `yyyy-mm-dd` as a UTC midnight, so no timezone moves the day; null for anything else. */
function calendarDate(value: Value | undefined): Date | null {
  const match = typeof value === "string" ? /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(value) : null;
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/** A Calendar as its events by month: `**October 2026**` then `- Fri 9 — RC 1` lines. */
function eventCalendarMarkdown(items: readonly Value[], month: string): string {
  const events = items
    .flatMap((item) => {
      if (!isPlainObject(item)) return [];
      const event = fields(item, "date");
      const date = calendarDate(event.date);
      return date === null ? [] : [{ date, title: inline(event.title).trim(), dot: lookup(TONE_DOTS, inline(event.tone)) }];
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (events.length === 0) {
    const shown = calendarDate(`${month.trim()}-01`);
    return shown === null ? "" : `**${MONTH_LONG.format(shown)}**: no events`;
  }
  const months: string[] = [];
  let current = "";
  for (const { date, title, dot } of events) {
    const heading = MONTH_LONG.format(date);
    if (heading !== current) {
      months.push(`**${heading}**`);
      current = heading;
    }
    const line = `- ${WEEKDAY_SHORT[date.getUTCDay()]} ${date.getUTCDate()} — ${dot === "" ? "" : `${dot} `}${title || "Event"}`;
    months[months.length - 1] += `\n${line}`;
  }
  return paragraphs(months);
}

// ── Project components that read BB (Changes, Commits, PullRequest, Threads) ──

/**
 * What BB answered for the rendering in progress, by request key. block() is
 * synchronous, so toMarkdownWithProject holds them here for one call.
 */
let projectAnswers: ReadonlyMap<string, ProjectResult> = new Map();

/** The BB read a Project node needs, or why its props can't be read; null for other nodes. */
function projectRequest(node: UiNode): Parsed<ProjectRequest> | null {
  const props = node.props;
  switch (node.type) {
    case "Changes": {
      const target = parseChangesTarget(props.target);
      if (!target.ok) return target;
      const paths = parsePathFilter(props.paths);
      if (!paths.ok) return paths;
      return { ok: true, value: { kind: "changes", target: target.value, paths: paths.value } };
    }
    case "Commits":
      return { ok: true, value: { kind: "commits" } };
    case "PullRequest":
      return { ok: true, value: { kind: "pullRequest" } };
    case "Threads": {
      const ids = parseThreadIds(props.ids);
      return ids.ok ? { ok: true, value: { kind: "threads", ids: ids.value } } : ids;
    }
    case "Environments":
      return { ok: true, value: { kind: "environments" } };
    default:
      return null;
  }
}

/** The BB reads the evaluated nodes need (Changes, Commits, PullRequest, Threads), in order, without repeats. */
export function projectRequests(roots: readonly UiNode[]): ProjectRequest[] {
  const requests = new Map<string, ProjectRequest>();
  const visit = (value: Value | undefined): void => {
    if (value === undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (hasKind(value, "node")) {
      const request = projectRequest(value);
      if (request?.ok) requests.set(projectRequestKey(request.value), request.value);
      Object.values(value.props).forEach(visit);
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(visit);
    }
  };
  roots.forEach(visit);
  return [...requests.values()];
}

/** toMarkdownWithImages with Changes, Commits, PullRequest and Threads shown as what BB answered (`answers`, by `projectRequestKey`). */
export function toMarkdownWithProject(
  roots: readonly UiNode[],
  images: ReadonlyMap<string, SearchedImage | null>,
  answers: ReadonlyMap<string, ProjectResult>,
  photos: ReadonlyMap<string, SearchedImage | null> = new Map(),
): string {
  projectAnswers = answers;
  try {
    return toMarkdownWithImages(roots, images, photos);
  } finally {
    projectAnswers = new Map();
  }
}

/** Each Project component's name, and what it says without an answer from BB (plain toMarkdown, no thread). */
const PROJECT_TEXT: Record<string, { readonly title: string; readonly unanswered: string }> = {
  Changes: { title: "Changes", unanswered: "_The changes in this thread's checkout: open the reply in BB to see them._" },
  Commits: { title: "Commits", unanswered: "_This branch's commits: open the reply in BB to see them._" },
  PullRequest: { title: "Pull request", unanswered: "_This branch's pull request: open the reply in BB to see it._" },
  Threads: { title: "Threads", unanswered: "_Thread status: open the reply in BB to see it._" },
};

/** Rows a markdown list or table shows before saying how many more there are. */
const MARKDOWN_ROWS = 50;

/** "_… and 3 more files_" when rows were left out; `noun` is singular. */
function moreLine(shown: number, total: number, noun: string): string {
  const more = total - shown;
  return more > 0 ? `_… and ${more} more ${noun}${more === 1 ? "" : "s"}_` : "";
}

function projectMarkdown(node: UiNode): string {
  const text = PROJECT_TEXT[node.type];
  if (text === undefined) return "";
  const request = projectRequest(node);
  if (request === null) return "";
  if (!request.ok) return `_(error: ${request.error})_`;
  const answer = projectAnswers.get(projectRequestKey(request.value));
  if (answer === undefined) return text.unanswered;
  if (!answer.ok) return `**${text.title}** · _${answer.message}_`;
  if ("scope" in answer) return changesMarkdown(answer);
  if ("commits" in answer) {
    const limit = parseCommitLimit(node.props.limit);
    return commitsMarkdown(answer, limit.ok ? limit.value : null);
  }
  if ("pullRequest" in answer) return pullRequestMarkdown(answer);
  // Environments renders through its own case in block().
  if ("environments" in answer) return "";
  return threadsMarkdown(answer);
}

function changesMarkdown(view: ChangesView): string {
  const totals = changeTotals(view.files);
  const filter = view.filter === null ? "" : ` · paths: ${view.filter.join(", ")} (${totals.files} of ${view.totalFiles} files)`;
  const summary =
    totals.files === 0 ? "no changes" : `${totals.files} file${totals.files === 1 ? "" : "s"}, +${totals.additions} −${totals.deletions}`;
  const header = `**Changes** · ${scopeLabel(view.scope)} · ${summary}${filter}`;
  if (totals.files === 0) return header;
  const rows = view.files.slice(0, MARKDOWN_ROWS).map((file) => {
    const counted = file.diff !== "binary";
    const kind = `${CHANGE_LABEL[file.kind]}${file.untracked ? ", untracked" : ""}${counted ? "" : ", binary"}`;
    const from = file.previousPath === null ? "" : ` (from \`${file.previousPath}\`)`;
    return [`\`${file.path}\`${from}`, kind, counted ? `+${file.additions}` : "—", counted ? `−${file.deletions}` : "—"];
  });
  return paragraphs([
    header,
    table(["File", "Change", "+", "−"], rows),
    moreLine(rows.length, view.files.length, "file"),
    view.listTruncated ? "_BB listed only part of the changed files._" : "",
  ]);
}

function commitsMarkdown(view: CommitsView, limit: number | null): string {
  const where =
    view.onBase || view.ahead === null
      ? (view.branch ?? "detached HEAD")
      : `${view.branch ?? "detached HEAD"} · ${view.ahead} ahead, ${view.behind} behind ${view.base}`;
  const header = `**Commits** · ${where}`;
  if (view.onBase) return `${header} · _this is the default branch: no branch commits_`;
  if (view.commits.length === 0) return `${header} · no commits since ${view.base}`;
  const shown = view.commits.slice(0, limit ?? MARKDOWN_ROWS);
  const lines = shown.map(
    (commit) => `- \`${commit.shortSha}\` ${commit.subject} — ${commit.author}, ${relativeTime(commit.authoredAt, view.takenAt)}`,
  );
  return paragraphs([header, lines.join("\n"), moreLine(shown.length, view.commits.length, "commit")]);
}

function pullRequestMarkdown(view: PullRequestView): string {
  const pr = view.pullRequest;
  if (pr === null) return `**Pull request** · ${view.branch === null ? "none" : `none for ${view.branch}`}`;
  const url = webUrl(pr.url, ["https:"]);
  const label = `#${pr.number} ${pr.title}`;
  const counts = checkCounts(pr.checks);
  const attention = ATTENTION_LABEL[pr.attention];
  return [
    `**Pull request** ${url === null ? `**${label}**` : link(label, url)}`,
    PR_STATE_LABEL[pr.state],
    `${pr.baseRef} ← ${pr.headRef}`,
    `${CHECKS_LABEL[pr.checks.state]}${counts === "" ? "" : ` (${counts})`}`,
    REVIEW_LABEL[pr.review.state],
    MERGEABILITY_LABEL[pr.mergeability],
    attention === null ? "" : `needs: ${attention}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

function threadsMarkdown(view: ThreadsView): string {
  const header = view.mode === "subthreads" ? `**Subthreads** (${view.threads.length}${view.truncated ? "+" : ""})` : "**Threads**";
  if (view.threads.length === 0) return `${header} · none`;
  const shown = view.threads.slice(0, MARKDOWN_ROWS);
  const lines = shown.map((thread) => {
    if (!thread.found) return `- \`${thread.id}\` — not found in this project`;
    const agent = [thread.provider.name ?? thread.provider.id, thread.model, thread.reasoning === null ? null : `${thread.reasoning} reasoning`]
      .filter((part) => part !== null)
      .join(", ");
    const row = [`- **${thread.title}** — ${threadActivityLabel(thread)} · ${agent} · ${relativeTime(thread.updatedAt, view.fetchedAt)}`];
    const pending = thread.pending;
    if (pending !== null) {
      const asked = pending.text === null ? "" : pending.code && !pending.text.includes("`") ? `: \`${pending.text}\`` : `: ${plainMarkdown(pending.text)}`;
      const options = pending.options.length === 0 ? "" : ` (${pending.options.map(plainMarkdown).join(" / ")})`;
      row.push(`  - Needs you: ${pending.action}${asked}${options}${pending.more > 0 ? ` · ${pending.more} more waiting` : ""}`);
    }
    if (thread.lastMessage !== null) row.push(`  - Latest message: ${plainMarkdown(previewText(thread.lastMessage.text))}`);
    return row.join("\n");
  });
  return paragraphs([header, lines.join("\n"), moreLine(shown.length, view.threads.length, "thread")]);
}

/** Failures a Tests rendering lists, and the lines and characters of each message it keeps. */
const TEST_FAILURES = 20;
const TEST_MESSAGE_LINES = 12;
const TEST_MESSAGE_CHARS = 1_500;

/** A test run: a summary line, then each failure with where it is and its message (ANSI codes stripped), first lines only. */
function testsMarkdown(results: Value | undefined, title: string): string {
  const read = readTestRun(results);
  if (!read.ok) return `_(${read.error})_`;
  const { tests, counts, ms } = read.run;
  const dots = [
    counts.failed > 0 ? `🔴 ${counts.failed} failed` : "",
    counts.passed > 0 ? `🟢 ${counts.passed} passed` : "",
    counts.skipped > 0 ? `⚪ ${counts.skipped} skipped` : "",
  ].filter((part) => part !== "");
  const summary = tests.length === 0 ? "No tests ran." : [...dots, ms === null ? "" : formatDuration(ms)].filter((part) => part !== "").join(" · ");
  const failures = tests.filter((test) => test.status === "failed");
  const common = commonDirectory(tests.flatMap((test) => (test.file === null ? [] : [test.file])));
  const items = failures.slice(0, TEST_FAILURES).map((test, index) => {
    const where = test.file === null ? "" : ` — \`${displayPath(test.file, null, common)}${test.line === null ? "" : `:${test.line}`}\``;
    const head = `${index + 1}. **${test.name.replace(/[*_`[\]\\]/g, "\\$&")}**${test.detail === null ? "" : ` (${test.detail})`}${where}`;
    if (test.message === null) return head;
    const lines = stripAnsi(test.message).replace(/\s+$/, "").split("\n");
    let kept = lines.slice(0, TEST_MESSAGE_LINES).join("\n");
    if (kept.length > TEST_MESSAGE_CHARS) kept = `${kept.slice(0, TEST_MESSAGE_CHARS)}…`;
    else if (lines.length > TEST_MESSAGE_LINES) kept += "\n…";
    return `${head}\n${fence(kept, "").replace(/^/gm, "   ")}`;
  });
  const rest = failures.length - items.length;
  return paragraphs([
    title === "" ? summary : `**${title}** — ${summary}`,
    items.length === 0 ? "" : `Failures:\n${items.join("\n")}`,
    rest > 0 ? `…and ${rest} more ${rest === 1 ? "failure" : "failures"}` : "",
  ]);
}

/** Lines of pretty-printed JSON a Json rendering keeps. */
const JSON_LINES = 60;

/** A value as a pretty-printed json fence, cut at JSON_LINES with a note of how much was left out. */
function jsonMarkdown(value: Value, label: string): string {
  const lines = (JSON.stringify(value, null, 2) ?? "null").split("\n");
  const kept = lines.length > JSON_LINES ? [...lines.slice(0, JSON_LINES), "…"] : lines;
  return paragraphs([
    label === "" ? "" : `**${label}**`,
    fence(kept.join("\n"), "json"),
    lines.length > JSON_LINES ? `_(first ${JSON_LINES} of ${lines.length} lines)_` : "",
  ]);
}

const RISK_TEXT: Record<string, string> = { low: "low risk", medium: "medium risk", high: "**high risk**" };

/** A Plan as a numbered list: each step with its risk and estimate, detail and files below; the total and the Approve choice. */
function planMarkdown(value: Value | undefined): string {
  const { steps, error } = readPlan(value);
  if (error !== null) return `_(${error})_`;
  if (steps.length === 0) return "**Plan** · no steps";
  const { total, unparsed, mixed } = planTotal(steps, initialChecks(steps));
  const size = total === null ? "" : ` · ${formatQuantity(total)}${unparsed > 0 ? ` + ${unparsed} unsized` : ""}${steps.some((step) => step.optional) ? " without optional steps" : ""}`;
  const lines = steps.slice(0, MARKDOWN_ROWS).flatMap((step, index) => {
    const meta = [step.risk === null ? "" : RISK_TEXT[step.risk], step.estimate === null ? "" : step.amount === null ? step.estimate : formatQuantity(step.amount)]
      .filter((part) => part !== "")
      .join(" · ");
    return [
      `${index + 1}. ${step.optional ? "_(optional)_ " : ""}${step.title}${meta === "" ? "" : ` · ${meta}`}`,
      ...(step.detail === null ? [] : [`   ${step.detail.replace(/\s*\r?\n\s*/g, " ")}`]),
      ...(step.files.length === 0 ? [] : [`   ${step.files.map((file) => `\`${file.path}${file.line === null ? "" : `:${file.line}`}\``).join(" ")}`]),
    ];
  });
  return paragraphs([
    `**Plan** · ${steps.length} ${steps.length === 1 ? "step" : "steps"}${size}${mixed ? " · estimates mix points and time" : ""}`,
    lines.join("\n"),
    moreLine(Math.min(steps.length, MARKDOWN_ROWS), steps.length, "step"),
    "Options: Approve",
  ]);
}

/** A Decision as its verdict, the score matrix with weights and weighted scores (spec weights), pros and cons, and the options to send. */
function decisionMarkdown(options: Value | undefined, criteria: Value | undefined): string {
  const read = readDecision(options, criteria);
  if (!read.ok) return `_(${read.error})_`;
  const model = read.model;
  if (model.options.length === 0) return "**Decision** · no options";
  const weights = model.criteria.map((criterion) => criterion.weight);
  const ranked = rankOptions(model, weights);
  const lead = leaderMargin(ranked);
  const score = (total: number) => String(round(total, 2));
  const top = ranked[0];
  const leader = model.options[top.index].name;
  const verdict =
    lead !== null && lead.tied.length > 0
      ? `${joinAnd([leader, ...lead.tied.map((index) => model.options[index].name)])} are tied at ${score(top.total)} of ${model.scale}`
      : `${leader} leads with ${score(top.total)} of ${model.scale}${ranked.length > 1 ? `, ${score(lead?.margin ?? 0)} ahead of ${model.options[ranked[1].index].name}` : ""}`;
  const rows: Value[] = [
    ...model.criteria.map((criterion, index): Value => [
      criterion.name,
      formatAmount(criterion.weight),
      ...model.options.map((option) => (option.scores[index] === null ? "—" : formatAmount(option.scores[index] ?? 0))),
    ]),
    ["**Weighted score**", "", ...model.options.map((_, index) => {
      const entry = ranked.find((candidate) => candidate.index === index);
      return entry === undefined ? "" : index === top.index ? `**${score(entry.total)}**` : score(entry.total);
    })],
  ];
  const notes = model.options.flatMap((option) => {
    const parts = [...option.pros.map((pro) => `+ ${pro}`), ...option.cons.map((con) => `− ${con}`), ...(option.note === null ? [] : [option.note])];
    return parts.length === 0 ? [] : [`- **${option.name}**: ${parts.join("; ")}`];
  });
  return paragraphs([
    `**Decision** · ${verdict}`,
    table(["Criterion", "Weight", ...model.options.map((option) => option.name)], rows),
    notes.join("\n"),
    model.issues.map((issue) => `_${issue}_`).join("\n"),
    `Options: ${ranked.map((entry) => `Go with ${model.options[entry.index].name}`).join(" · ")}`,
  ]);
}

/** An Estimate as its totals line (PERT mean, P50/P80/P90, range) and a table of the tasks; invalid rows say why. */
function estimateMarkdown(value: Value | undefined, unitValue: Value | undefined): string {
  const read = readEstimate(value);
  if (read.error !== null) return `_(${read.error})_`;
  if (read.tasks.length === 0) return "**Estimate** · no tasks";
  const unit = estimateUnit(unitValue);
  const estimates = read.tasks.map(estimateTask);
  const totals = estimateTotals(estimates);
  const amount = (number: number | null) => (number === null ? "—" : formatAmount(number));
  const summary =
    totals.count === 0
      ? "no task has a usable low and high"
      : [
          `expected **${formatWithUnit(totals.mean, unit)}**`,
          `P50 ${formatWithUnit(totals.p50, unit)}`,
          `P80 ${formatWithUnit(totals.p80, unit)}`,
          `P90 ${formatWithUnit(totals.p90, unit)}`,
          `range ${formatAmount(totals.low)}–${formatWithUnit(totals.high, unit)}`,
        ].join(" · ");
  const shown = estimates.slice(0, MARKDOWN_ROWS);
  return paragraphs([
    `**Estimate** · ${read.tasks.length} ${read.tasks.length === 1 ? "task" : "tasks"} · ${summary}`,
    table(
      ["Task", `Low (${unit})`, "Likely", "High", "PERT mean"],
      shown.map((estimate): Value => [
        estimate.task.title,
        amount(estimate.task.low),
        estimate.task.likely === null && estimate.error === null ? `(${amount(estimate.likely)})` : amount(estimate.task.likely),
        amount(estimate.task.high),
        estimate.error === null ? formatAmount(estimate.mean) : `⚠ not counted: ${estimate.error}`,
      ]),
    ),
    moreLine(shown.length, estimates.length, "task"),
  ]);
}

// ── Environments ────────────────────────────────────────────────────────────

/** Thread lines an environment lists under it in markdown. */
const ENVIRONMENT_THREAD_LINES = 3;

/** The project's environments as BB answered (the default view: those with live threads), each with its git line and threads. */
function environmentsMarkdown(): string {
  const answer = projectAnswers.get(projectRequestKey({ kind: "environments" }));
  if (answer === undefined) return "_This project's environments, their threads and changes: open the reply in BB to see them._";
  if (!answer.ok) return `**Environments** · _${answer.message}_`;
  if (!("environments" in answer)) return "";
  const all = answer.environments;
  if (all.length === 0) return "**Environments** · none in this project";
  const { shown, filtered } = defaultEnvironments(all);
  const running = all.reduce((sum, environment) => sum + environment.threadCounts.running, 0);
  const header = [
    "**Environments**",
    filtered ? `${shown.length} with live threads of ${all.length}` : `${all.length}`,
    running > 0 ? `${running} running` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const rows = shown.slice(0, MARKDOWN_ROWS);
  const items = rows.map((environment) => environmentItem(environment, answer.fetchedAt));
  const left = all.length - rows.length;
  return paragraphs([
    header,
    items.join("\n"),
    left > 0 ? `_… and ${left} more environment${left === 1 ? "" : "s"}${filtered ? " without live threads" : ""}_` : "",
  ]);
}

function environmentItem(environment: EnvironmentInfo, now: number): string {
  const title = environmentTitle(environment);
  const life = LIFE_LABEL[environment.life];
  const kind = [kindLabel(environment), environment.current ? "this thread" : "", life ?? ""].filter((part) => part !== "").join(", ");
  const parts = [
    `**${title.replace(/[*_`[\]\\]/g, "\\$&")}** (${kind})`,
    ...environmentGit(environment),
    threadSummary(environment),
    environment.activeAt === null ? "" : relativeTime(environment.activeAt, now),
  ];
  const live = liveThreads(environment).slice(0, ENVIRONMENT_THREAD_LINES);
  const threads = live.map((thread) => `  - ${thread.subthread ? "↳ " : ""}${thread.title.replace(/[*_`[\]\\]/g, "\\$&")} — ${threadStatusLabel(thread)}`);
  return [`- ${parts.filter((part) => part !== "").join(" · ")}`, ...threads].join("\n");
}

/** The git facts of an environment's detail: changes, position, pull request; or why they couldn't be read. */
function environmentGit(environment: EnvironmentInfo): string[] {
  const detail = environment.detail;
  if (detail === null) return [];
  const checkout = detail.checkout;
  if (!checkout.ok) return [`_${checkout.message}_${checkout.path === null ? "" : ` (\`${checkout.path}\`)`}`];
  const position =
    checkout.checkout === "detached"
      ? `detached ${checkout.head ?? ""}`.trim()
      : checkout.onBase
        ? checkout.base === checkout.defaultBranch
          ? "default branch"
          : `on base ${checkout.base}`
        : aheadBehindLabel(checkout);
  const pull = detail.pull;
  let pr = "";
  if (pull !== null && !pull.ok) pr = "pull request unknown";
  else if (pull !== null && pull.pullRequest === null) pr = "no pull request";
  else if (pull !== null && pull.pullRequest !== null) {
    const request = pull.pullRequest;
    const url = webUrl(request.url, ["https:"]);
    const label = `#${request.number}`;
    const checks = request.state === "open" || request.state === "draft" ? `, ${CHECKS_LABEL[request.checks.state].toLowerCase()}` : "";
    pr = `PR ${url === null ? label : link(label, url)} ${PR_STATE_LABEL[request.state]}${checks}`;
  }
  return [uncommittedLabel(checkout), position, pr];
}

// ---------------------------------------------------------------------------
// Findings and Coverage

const SEVERITY_DOTS: Record<Severity, string> = { critical: "🔴", high: "🔴", medium: "🟠", low: "🔵", info: "⚪" };

/** Markdown emphasis characters escaped outside `code spans`, so tool messages read as written. */
function escapeProse(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[*_[\]\\<>]/g, "\\$&")))
    .join("");
}

/**
 * Findings as `file:line severity title (rule)` lines, most severe first, under a count per severity; a review leads
 * with its verdict and what is open, counts per status, and says where each finding stands.
 */
function findingsMarkdown(items: Value | undefined, title: string): string {
  const read = readFindings(items);
  if (!read.ok) return `_(${read.error})_`;
  const { findings, scale, tool, review } = read.report;
  const counts = countSeverities(findings);
  const summary =
    findings.length === 0
      ? "No findings."
      : SEVERITIES.filter((severity) => counts[severity] > 0)
          .map((severity) => `${SEVERITY_DOTS[severity]} ${severityCount(severity, scale, counts[severity])}`)
          .join(" · ");
  const subject = review?.subject == null ? null : `${review.subject} review`;
  const heading = title !== "" ? title : (subject ?? (findings.length === 1 ? "1 finding" : `${findings.length} findings`));
  const header = [`**${heading}**`, summary, tool ?? ""].filter((part) => part !== "").join(" — ");
  const verdict = verdictHeadline(read.report);
  const verdictLine = verdict === null ? "" : `${{ good: "🟢", warn: "🟠", bad: "🔴" }[verdict.tone]} **${verdict.text}**`;
  const statuses = statusCounts(findings)
    .map((entry) => entry.text)
    .join(" · ");
  const common = commonDirectory(findings.flatMap((item) => (item.file === null ? [] : [item.file])));
  const sorted = sortFindings(findings);
  const lines = sorted.slice(0, MARKDOWN_ROWS).map((item) => {
    const where = item.file === null ? "" : `\`${displayPath(item.file, null, common)}${item.line === null ? "" : `:${item.line}${item.column === null ? "" : `:${item.column}`}`}\` `;
    const url = item.url === null ? null : webUrl(item.url, ["https:", "http:"]);
    const rule = item.rule === null ? "" : ` (${url === null ? `\`${item.rule}\`` : link(item.rule, url)})`;
    const status = item.status === null ? "" : ` — _${escapeProse(statusSentence(item))}_`;
    return `- ${where}${severityLabel(item.severity, scale)}: ${escapeProse(item.title)}${rule}${status}`;
  });
  return paragraphs([header, verdictLine, statuses, lines.join("\n"), moreLine(lines.length, sorted.length, "finding")]);
}

/** Uncovered ranges a Coverage row lists before "…". */
const COVERAGE_RANGES = 8;

/** The headline percentage with its tone, the other metrics, then the files with uncovered lines, most first. */
function coverageMarkdown(report: Value | undefined): string {
  const read = readCoverage(report);
  if (!read.ok) return `_(${read.error})_`;
  const { total, unit, files } = read.report;
  const main = headline(total, unit);
  const value = percent(main);
  const tones: Record<string, string> = { good: "🟢", warn: "🟠", bad: "🔴" };
  const lead =
    value === null || main === null
      ? `**Coverage** — nothing to cover`
      : `**Coverage** — ${tones[coverageTone(value)]} **${formatPercent(value)}** of ${unit} (${main.covered.toLocaleString("en-US")} of ${main.total.toLocaleString("en-US")})`;
  const others = (["statements", "branches", "functions"] as const)
    .filter((metric) => !(metric === "statements" && unit === "statements"))
    .flatMap((metric) => {
      const share = percent(total[metric]);
      return share === null ? [] : [`${metric} ${formatPercent(share)}`];
    });
  const common = commonDirectory(files.map((file) => file.path));
  const missing = mostUncovered(files, unit).filter((file) => file.missed > 0);
  const shown = missing.slice(0, MARKDOWN_ROWS);
  const rows = shown.map((file) => {
    const share = percent(headline(file, unit));
    const ranges =
      file.uncovered === null
        ? ""
        : `: ${file.uncovered.slice(0, COVERAGE_RANGES).map(rangeLabel).join(", ")}${file.uncovered.length > COVERAGE_RANGES ? ", …" : ""}`;
    return [`\`${displayPath(file.path, null, common)}\``, share === null ? "—" : formatPercent(share), `${file.missed.toLocaleString("en-US")}${ranges}`];
  });
  const covered = files.length - missing.length;
  return paragraphs([
    [lead, ...others].join(" · "),
    rows.length === 0 ? "" : table(["File", unit === "lines" ? "Lines" : "Statements", `Uncovered ${unit}`], rows),
    moreLine(shown.length, missing.length, "file"),
    covered > 0 && missing.length > 0 ? `_${covered} more ${covered === 1 ? "file" : "files"} fully covered_` : "",
  ]);
}

/** Cards listed per Board column before "… and N more". */
const BOARD_COLUMN_ROWS = 20;

const BOARD_TITLE: Record<string, [string, string, string]> = {
  list: ["Board", "item", "items"],
  tasks: ["Tasks", "task", "tasks"],
  issues: ["Issues", "issue", "issues"],
  pulls: ["Pull requests", "pull request", "pull requests"],
};

/** One card: `` `KEY` title `` (linked when it has a URL), then priority, owners, labels, due and live agents. */
function boardCardLine(card: BoardCard, today: number): string {
  const url = card.url === null ? null : webUrl(card.url, ["http:", "https:"]);
  const parts: string[] = [];
  if (card.priority !== null && card.priority !== "none") parts.push(card.priority === "urgent" ? "‼️ urgent" : card.priority);
  if (card.owners.length > 0) parts.push(card.owners.join(", "));
  if (card.labels.length > 0) parts.push(card.labels.map((label) => label.name).join(", "));
  if (card.due !== null) {
    parts.push(cardLate(card, today) ? `**due ${formatDay(card.due, today)} (${relativeDue(card.due, today).text})**` : `due ${formatDay(card.due, today)}`);
  }
  if (card.parent !== null) parts.push(`sub-task of ${card.parent}`);
  if (card.agents > 0) parts.push(`🟢 ${card.agents} ${card.agents === 1 ? "agent" : "agents"} working`);
  const title = url === null ? card.title : link(card.title, url);
  return `- ${card.key === null ? "" : `\`${card.key}\` `}${title}${parts.length === 0 ? "" : ` · ${parts.join(" · ")}`}`;
}

/** A Board as a list per column, in the board's column order, with counts. */
function boardMarkdown(items: Value | undefined, columns: Value | undefined, today: number): string {
  const read = readBoard(items, columns);
  if (!read.ok) return `_(${read.error})_`;
  const board = read.value;
  const [title, one, many] = BOARD_TITLE[board.source]!;
  const notes = [
    `${board.total}${board.truncated ? "+" : ""} ${board.total === 1 ? one : many}`,
    board.hidden > 0 ? `${board.hidden} in other columns not shown` : "",
    board.skipped > 0 ? `${board.skipped} without a title left out` : "",
  ].filter((note) => note !== "");
  return paragraphs([
    `**${title}** · ${notes.join(" · ")}`,
    ...board.columns.map((column) => {
      const shown = column.cards.slice(0, BOARD_COLUMN_ROWS);
      return [
        `**${column.label}** (${column.cards.length})`,
        ...(shown.length === 0 ? ["_none_"] : shown.map((card) => boardCardLine(card, today))),
        ...(shown.length < column.cards.length ? [moreLine(shown.length, column.cards.length, one)] : []),
      ].join("\n");
    }),
  ]);
}

const ROADMAP_MARKS: Record<RoadmapStatus, string> = { done: "✅", active: "🔵", planned: "⚪", blocked: "⛔", "at-risk": "🟠" };

/** A Roadmap as its lanes, each item with its dates, status, progress, owner and what it comes after; late items marked. */
function roadmapMarkdown(items: Value | undefined, today: number): string {
  const read = readRoadmap(items, today);
  if (!read.ok) return `_(${read.error})_`;
  const roadmap = read.value;
  if (roadmap.items.length === 0) return "**Roadmap** · no items";
  const first = Math.min(...roadmap.items.map((item) => item.start));
  const last = Math.max(...roadmap.items.map((item) => item.end));
  const late = roadmap.items.filter((item) => item.late).length;
  const header = [
    `**Roadmap** · ${formatRange(first, last, today)}`,
    `${roadmap.items.length} ${roadmap.items.length === 1 ? "item" : "items"}`,
    late > 0 ? `${late} late` : "",
  ].filter((part) => part !== "");
  const byIndex = new Map(roadmap.items.map((item) => [item.index, item]));
  const lanes = roadmap.lanes.map((lane) => {
    const lines = lane.items.map((item) => {
      const when = item.milestone
        ? `${formatDay(item.start, today)} (milestone)`
        : `${formatRange(item.start, item.end, today)} (${formatDays(itemDays(item))})`;
      const parts = [when];
      if (!item.milestone) parts.push(ROADMAP_STATUS_LABEL[item.status].toLowerCase());
      if (item.progress !== null && !item.milestone && item.status !== "done") parts.push(`${Math.round(item.progress)}%`);
      if (item.owner !== null) parts.push(item.owner);
      if (item.after !== null) {
        const before = item.afterIndex === null ? undefined : byIndex.get(item.afterIndex);
        parts.push(before === undefined ? `after ${item.after}` : `after ${before.title}${item.overlap ? " (overlaps it)" : ""}`);
      }
      if (item.late) parts.push(`**late: ${item.milestone ? "was due" : "ended"} ${formatDay(item.end, today)}**`);
      return `- ${item.milestone ? "◆" : ROADMAP_MARKS[item.status]} ${item.title} — ${parts.join(" · ")}`;
    });
    return [...(lane.name === "" ? [] : [`**${lane.name}**`]), ...lines].join("\n");
  });
  const skipped =
    roadmap.skipped.length === 0 ? "" : `_Left out (no usable dates): ${roadmap.skipped.map((skip) => `${skip.title} (${skip.reason})`).join(", ")}_`;
  return paragraphs([header.join(" · "), ...lanes, skipped]);
}

const HEALTH_MARKS: Record<Health, string> = {
  "off-track": "🔴",
  blocked: "⛔",
  "at-risk": "🟠",
  "on-track": "🟢",
  "not-started": "⚪",
  done: "✅",
};

/** A Status report: the summary, then one line per item worst first, its note indented under it. */
function statusMarkdown(items: Value | undefined, today: number): string {
  const read = readStatus(items, today);
  if (!read.ok) return `_(${read.error})_`;
  const report = read.value;
  if (report.items.length === 0) return "**Status** · nothing to report";
  const lines = report.items.slice(0, MARKDOWN_ROWS).map((item) => {
    const parts = [item.status === null ? (item.given ?? "no status") : HEALTH_LABEL[item.status]];
    if (item.progress !== null) parts.push(`${Math.round(item.progress)}%`);
    if (item.owner !== null) parts.push(item.owner);
    if (item.due !== null) {
      const due = relativeDue(item.due, today);
      parts.push(item.status === "done" ? formatDay(item.due, today) : item.late ? `**${due.text}**` : `${due.text} (${formatDay(item.due, today)})`);
    }
    const mark = item.status === null ? "⚪" : HEALTH_MARKS[item.status];
    const note = item.note === null ? [] : item.note.split(/\r?\n/).map((line) => `  ${line}`);
    return [`- ${mark} **${item.name}** — ${parts.join(" · ")}`, ...note].join("\n");
  });
  return paragraphs([`**Status** · ${healthSummary(report)}`, lines.join("\n"), moreLine(Math.min(report.items.length, MARKDOWN_ROWS), report.items.length, "item")]);
}

const VERDICT_DOTS: Record<string, string> = { better: "🟢", worse: "🔴", same: "⚪" };

/** One ranked run: `1. \`cmd\` — 7.8 ms ± 0.75 ms (min … max) · 3.92 ± 0.44 × slower`. */
function runLine(run: Run, rank: number, unit: string): string {
  const spread = run.stddev === null ? "" : ` ± ${perfAmount(run.stddev, unit, 2, run.mean)}`;
  const range = run.min === run.max ? "" : ` (${perfAmount(run.min, unit)} … ${perfAmount(run.max, unit)})`;
  const relative = rank === 1 ? "fastest" : `${formatRatio(run.ratio, run.ratioStddev)} × slower`;
  return `${rank}. \`${run.name}\` — ${perfAmount(run.mean, unit)}${spread}${range} · ${relative}${run.failed ? " · exited non-zero" : ""}`;
}

/** Before/after rows as a table with each change and its verdict (rows measured under different conditions say so instead); ranked runs (hyperfine, vitest bench) as numbered lists per group; every run of an experiment as a table per group. */
function benchmarkMarkdown(results: Value | undefined, unit: string | null): string {
  const read = readBenchmark(results, unit);
  if (!read.ok) return `_(${read.error})_`;
  const report = read.report;
  if (report.kind === "all-runs") return allRunsMarkdown(report);
  if (report.kind === "compare") {
    if (report.rows.length === 0) return "**Benchmark** · no results to compare";
    const { better, worse, same } = report.counts;
    const counts = [
      better > 0 ? `${better} ${report.words.better}` : "",
      worse > 0 ? `${worse} ${report.words.worse}` : "",
      same > 0 ? `${same} within noise` : "",
      report.incomparable > 0 ? `${report.incomparable} not comparable (conditions differ)` : "",
      report.geomean === null || Math.abs(1 - report.geomean) < 0.0005
        ? ""
        : `${Math.abs((1 - report.geomean) * 100).toFixed(1)}% ${report.geomean < 1 ? report.words.better : report.words.worse} overall (geometric mean)`,
    ].filter((part) => part !== "");
    const shown = report.rows.slice(0, MARKDOWN_ROWS);
    const withConditions = report.rows.some((row) => row.comparability !== null);
    const amount = (value: number, samples: readonly number[], rowUnit: string | null) =>
      `${perfAmount(value, rowUnit)}${samples.length > 1 ? ` (mean of ${samples.length})` : ""}`;
    const rows = shown.map((row) => {
      const change = row.percent === null ? formatDelta(row.delta, row.unit) : `${formatChange(row.percent)} (${formatDelta(row.delta, row.unit)})`;
      return [
        row.better === "higher" ? `${row.name} (higher is better)` : row.name,
        amount(row.before, row.beforeSamples, row.unit),
        amount(row.after, row.afterSamples, row.unit),
        row.comparable ? `${VERDICT_DOTS[row.verdict]} ${change}` : `⚠️ not comparable · measured ${change}`,
        ...(withConditions ? [comparisonConditions(row, report.shared)] : []),
      ];
    });
    const shared = formatConditions(report.shared);
    return paragraphs([
      `**Benchmark** · ${counts.join(" · ")}`,
      shared === "" ? "" : `Same conditions for every row: ${shared}`,
      table(["", "Before", "After", "Change", ...(withConditions ? ["Conditions"] : [])], rows),
      moreLine(shown.length, report.rows.length, "row"),
    ]);
  }
  const groups = report.groups.filter((group) => group.runs.length > 0);
  if (groups.length === 0) return "**Benchmark** · no results";
  return paragraphs(
    groups.map((group) => {
      const [fastest, ...slower] = group.runs;
      const lead = slower.slice(0, 3).map((run) => `${formatRatio(run.ratio, run.ratioStddev)} × faster than \`${run.name}\``);
      const title = `**${group.name ?? "Benchmark"}** · \`${fastest.name}\` is fastest${lead.length === 0 ? "" : `: ${lead.join(", ")}`}`;
      const shown = group.runs.slice(0, MARKDOWN_ROWS);
      return paragraphs([title, shown.map((run, index) => runLine(run, index + 1, report.unit)).join("\n"), moreLine(shown.length, group.runs.length, "run")]);
    }),
  );
}

/** One span: indented by depth, its name, status and size for requests, start → end and duration; ◆ on the critical path. */
function spanLine(span: Span, critical: boolean): string {
  const request = span.request;
  const status = request === null ? "" : request.status > 0 ? ` ${request.status}` : ` ${request.failure ?? "failed"}`;
  const size = request === null ? null : (request.transfer ?? request.size);
  const parts = [`${formatMs(span.start)} → ${formatMs(span.end)} (${formatMs(span.end - span.start)})`, size === null ? "" : formatBytes(size), span.detail ?? ""].filter((part) => part !== "");
  return `${"  ".repeat(span.depth)}- ${span.failed ? "🔴 " : ""}\`${span.name}\`${status} · ${parts.join(" · ")}${critical ? " ◆" : ""}`;
}

/** A waterfall as text: the total, failures and critical path, then each span (nested) with its times. */
function waterfallMarkdown(spans: Value | undefined, unit: string | null): string {
  const read = readWaterfall(spans, unit);
  if (!read.ok) return `_(${read.error})_`;
  const data = read.waterfall;
  const counted = data.spans.filter((span) => !span.track);
  const noun = data.source === "har" ? "request" : data.source === "trace" ? "event" : "span";
  if (counted.length === 0) return `**Waterfall** · no ${noun}s`;
  const failed = counted.filter((span) => span.failed).length;
  const header = [
    `**Waterfall** · ${counted.length} ${noun}${counted.length === 1 ? "" : "s"} · ${formatMs(data.total)}`,
    failed > 0 ? `${failed} failed` : "",
    data.critical.length > 0 ? `critical path ${formatMs(data.criticalMs)} (◆)` : "",
    ...data.markers.map((marker) => `${marker.label} ${formatMs(marker.at)}`),
  ].filter((part) => part !== "");
  const onPath = new Set(data.critical);
  const shown = data.spans.slice(0, MARKDOWN_ROWS);
  // Thread rows of a trace count among the rows left out, so the note says rows.
  return paragraphs([header.join(" · "), shown.map((span) => spanLine(span, onPath.has(span.index))).join("\n"), moreLine(shown.length, data.spans.length, "row")]);
}

/** Children a Treemap rendering lists per level. */
const TREEMAP_TOP = 15;
const TREEMAP_INNER = 5;

/** A treemap as a nested list: the largest groups with size and share, and the largest items inside each. */
function treemapMarkdown(items: Value | undefined, unit: string | null): string {
  const read = readTreemap(items, unit);
  if (!read.ok) return `_(${read.error})_`;
  const { root, unit: shownUnit } = read.treemap;
  if (root.value <= 0) return "**Treemap** · nothing to show";
  const line = (node: TreeNode, depth: number) => `${"  ".repeat(depth)}- ${node.name} — ${perfAmount(node.value, shownUnit)} (${formatShare(node.value, root.value)})`;
  const lines = root.children.slice(0, TREEMAP_TOP).flatMap((node) => [
    line(node, 0),
    ...node.children.slice(0, TREEMAP_INNER).map((child) => line(child, 1)),
    ...(node.children.length > TREEMAP_INNER ? [`  - _… and ${node.children.length - TREEMAP_INNER} more_`] : []),
  ]);
  const name = root.name === "" ? "" : ` · ${root.name}`;
  return paragraphs([
    `**Treemap**${name} · ${perfAmount(root.value, shownUnit)} · ${root.children.length} ${root.children.length === 1 ? "item" : "items"}`,
    lines.join("\n"),
    moreLine(Math.min(root.children.length, TREEMAP_TOP), root.children.length, "item"),
  ]);
}

/** Errors (an error and its causes) a StackTrace's markdown lists, and frames per error. */
const TRACE_SECTIONS = 6;
const TRACE_FRAMES = 12;
/** Lines from the end of a Logs output its markdown shows. */
const LOG_TAIL = 30;
const LOG_LINE_CHARS = 300;

/** `fn (path:line:col)`, paths relative to what the app's frames share; a runtime frame as printed (`Array.map (<anonymous>)`). */
function traceFrameLine(frame: TraceFrame, common: string): string {
  const location = frame.location;
  if (location === null) return frame.text.replace(/^at\s+/, "");
  const where = `${displayPath(location.path, null, common)}:${location.line}${location.column === null ? "" : `:${location.column}`}`;
  return frame.fn === null ? where : `${frame.fn} (${where})`;
}

/**
 * An error and its causes: per error a line with its type and message, then a
 * block with the rest of the message and its frames (innermost first, the
 * first frame of the app's own code marked `→`, dependency runs folded).
 */
function stackTraceMarkdown(value: Value | undefined, title: string): string {
  const read = readTrace(value);
  if (!read.ok) return `_(${read.error})_`;
  const { sections } = read.trace;
  const common = commonDirectory(
    sections.flatMap((s) => s.frames.flatMap((f) => (f.app && f.location?.linkable ? [f.location.path.replace(/^file:\/\//, "")] : []))),
  );
  const places = memberPlaces(sections);
  const parts = sections.slice(0, TRACE_SECTIONS).map((section, index) => {
    const label = relationLabel(section.relation, places[index]);
    const [first, ...rest] = section.message.split("\n");
    const type = section.type === "" ? "" : `**${section.type}**`;
    const head = `${label === "" ? "" : `${label}: `}${type}${first === "" ? "" : `${type === "" ? "" : ": "}${first}`}` || "**Error**";
    const marked = section.frames.findIndex((f) => f.app);
    const rows = frameRows(section.frames, new Set());
    const lines = rows
      .slice(0, TRACE_FRAMES)
      .map((row) =>
        row.type === "fold"
          ? `  … ${row.count} library frames`
          : `${row.index === marked ? "→" : " "} ${traceFrameLine(section.frames[row.index], common)}`,
      );
    if (rows.length > TRACE_FRAMES) lines.push(`  … ${rows.length - TRACE_FRAMES} more`);
    if (section.omitted > 0) lines.push(`  … ${section.omitted} more as in ${read.trace.language === "java" ? "the error above" : "the cause"}`);
    const body = [...rest, ...(rest.length > 0 && lines.length > 0 ? [""] : []), ...lines];
    const fields = section.fields.map(([key, text]) => `${key} ${text}`).join(" · ");
    return paragraphs([fields === "" ? head : `${head}  \n${fields}`, body.length === 0 ? "" : fence(body.join("\n"), "")]);
  });
  return paragraphs([title === "" ? "" : `**${title}**`, ...parts, moreLine(Math.min(sections.length, TRACE_SECTIONS), sections.length, "error")]);
}

/** A command's output: the command, exit code and counts, the last lines (where a failure usually is, repeats folded), and the first error when it is earlier. */
function logsMarkdown(value: Value | undefined, command: string, exit: Value | undefined): string {
  const read = readLogs(value);
  if (!read.ok) return `_(${read.error})_`;
  const { lines, counts, context, utc } = read.output;
  const clip = (text: string) => (text.length > LOG_LINE_CHARS ? `${text.slice(0, LOG_LINE_CHARS - 1)}…` : text);
  const nouns: Record<string, string> = { fatal: "fatal", error: "error", warn: "warning" };
  const facts = [
    command === "" ? "**Output**" : command.includes("`") ? `\`\` $ ${command} \`\`` : `\`$ ${command}\``,
    finite(exit) ? `${exit === 0 ? TONE_DOTS.good : TONE_DOTS.bad} exit ${exit}` : "",
    `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
    ...LOG_LEVELS.filter((level) => Object.hasOwn(nouns, level) && counts[level] > 0).map(
      (level) => `${counts[level]} ${nouns[level]}${counts[level] === 1 || level === "fatal" ? "" : "s"}`,
    ),
    ...context.map(([key, text]) => `${key} ${text}`),
    utc ? "times UTC" : "",
  ].filter((fact) => fact !== "");
  if (lines.length === 0) return paragraphs([facts.join(" · "), "_No output._"]);
  const earlier = Math.max(0, lines.length - LOG_TAIL);
  const tail = foldRepeats(lines, lines.slice(earlier).map((_, offset) => earlier + offset)).map(
    (row) => `${clip(lines[row.index].text)}${row.count > 1 ? `  (× ${row.count})` : ""}`,
  );
  const error = firstError(lines);
  return paragraphs([
    facts.join(" · "),
    earlier > 0 ? `_… ${earlier} earlier ${earlier === 1 ? "line" : "lines"}_` : "",
    fence(tail.join("\n"), "text"),
    error !== -1 && error < earlier ? `First error, line ${lines[error].number}: \`${clip(lines[error].text).replace(/`/g, "'")}\`` : "",
  ]);
}

// ---------------------------------------------------------------------------
// Pipeline and Dependencies

const PIPELINE_DOTS: Record<PipelineStatus, string> = {
  failure: "🔴",
  in_progress: "🟡",
  queued: "⏳",
  cancelled: "⚫",
  success: "🟢",
  neutral: "⚪",
  skipped: "⚪",
};

/** Jobs a stage lists before "… and N more"; failed and running jobs are always listed. */
const PIPELINE_STAGE_JOBS = 15;

/** `label` linked to `url` where it is a web link, else as text. */
function maybeLink(label: string, url: string | null): string {
  const parsed = url === null ? null : webUrl(url, ["https:", "http:"]);
  return parsed === null ? escapeProse(label) : link(label, parsed);
}

/** `- 🔴 [job](url) — 5m 53s — failed at step 14 "Test build" (1m 25s)`, its message below. */
function pipelineJobLine(job: PipelineJob, label: string): string {
  const time = job.status === "in_progress" ? (job.ms === null ? "running" : `running ${formatElapsed(job.ms)}`) : job.ms === null ? "" : formatElapsed(job.ms);
  const step = job.failedStep < 0 ? null : job.steps[job.failedStep];
  const running = job.steps.find((candidate) => candidate.status === "in_progress");
  const where =
    step !== null
      ? `failed at ${step.number === null ? "" : `step ${step.number} `}"${step.name}"${step.ms === null ? "" : ` (${formatElapsed(step.ms)})`}`
      : running !== undefined
        ? `at "${running.name}"`
        : "";
  const parts = [`- ${PIPELINE_DOTS[job.status]} ${maybeLink(label, job.url)}`, job.detail ?? "", time, where].filter((part) => part !== "");
  const message = job.message ?? step?.message ?? null;
  return `${parts.join(" — ")}${message === null ? "" : `\n  ${escapeProse(message.split("\n")[0])}`}`;
}

/** A CI run: its state, branch, commit and time, then its jobs by stage (or a PR's checks by workflow) with the failing step. */
function pipelineMarkdown(value: Value | undefined): string {
  const read = readPipeline(value);
  if (!read.ok) return `_(${read.error})_`;
  const run = read.run;
  const title = run.title ?? run.name ?? (run.source === "checks" ? "Checks" : "Pipeline");
  const sha = run.sha === null ? "" : `\`${run.sha.slice(0, 7)}\``;
  const facts = [
    `${PIPELINE_DOTS[run.status]} ${STATUS_LABEL[run.status]}${run.detail === null ? "" : ` (${run.detail})`}`,
    run.title !== null && run.name !== null ? escapeProse(run.name) : "",
    run.branch === null ? sha : `\`${run.branch}\`${sha === "" ? "" : ` @ ${sha}`}`,
    run.event?.replace(/_/g, " ") ?? "",
    run.ms === null ? "" : formatElapsed(run.ms),
  ].filter((part) => part !== "");
  const noun = run.source === "checks" ? "check" : "job";
  const header = `**${maybeLink(title, run.url)}** — ${facts.join(" · ")}`;
  if (run.jobCount === 0) return `${header}\n\nNo ${noun}s.`;
  const counts = `${run.jobCount} ${noun}${run.jobCount === 1 ? "" : "s"}: ${jobCountsText(run.counts, " · ")}`;
  const many = run.stages.length > 1;
  const stages = run.stages.map((stage, index) => {
    const self = stage.jobs.length === 1 && stage.jobs[0].name === stage.name;
    const matrix = stage.name === null ? matrixPrefix(stage.jobs.map((job) => job.name)) : null;
    const label = self ? null : (stage.name ?? matrix?.label ?? (many ? `Stage ${index + 1}` : null));
    // Jobs arrive failures first; the rest are cut past the page.
    const pressing = stage.jobs.filter((job) => job.status === "failure" || job.status === "in_progress").length;
    const shown = stage.jobs.slice(0, Math.max(PIPELINE_STAGE_JOBS, pressing));
    const lines = shown.map((job) => pipelineJobLine(job, job.name.slice(matrix?.length ?? 0)));
    const rest = stage.jobs.length - shown.length;
    if (rest > 0) lines.push(`- … and ${rest} more ${noun}${rest === 1 ? "" : "s"}`);
    const meta = [`${stage.jobs.length} ${noun}${stage.jobs.length === 1 ? "" : "s"}`, stage.ms === null || stage.ms === 0 ? "" : formatElapsed(stage.ms)].filter((part) => part !== "");
    return label === null ? lines.join("\n") : `${PIPELINE_DOTS[stage.status]} **${escapeProse(label)}** (${meta.join(" · ")}):\n${lines.join("\n")}`;
  });
  return paragraphs([`${header}\n${counts}`, ...stages]);
}

const DEPENDENCY_DOTS: Record<DependencySeverity, string> = { critical: "🔴", high: "🔴", moderate: "🟠", low: "⚪", info: "⚪" };

/** Vulnerable packages, and outdated packages per group, a Dependencies rendering lists. */
const DEPENDENCY_ROWS = 25;

const DEPENDENCY_SOURCE: Record<string, string> = { npm: "npm outdated", pnpm: "pnpm outdated", pip: "pip list --outdated" };

/** `to` with the part that changed from `from` in bold: 4.**18.1**. */
function changedVersion(from: string, to: string): string {
  const [same, changed] = splitChange(from, to);
  return changed === "" ? same : `${same}**${changed}**`;
}

function vulnerableLine(item: VulnerablePackage): string {
  const reach =
    item.direct === true ? "direct" : item.pulledInBy.length > 0 ? `via ${item.pulledInBy.join(", ")}` : item.direct === false ? "transitive" : "";
  const first = item.advisories[0];
  const advisory =
    first === undefined
      ? item.through.length > 0
        ? `through ${item.through.join(", ")}`
        : ""
      : `${maybeLink(first.title, first.url)}${item.advisories.length > 1 ? ` (+${item.advisories.length - 1} more)` : ""}`;
  const target = item.fix === null || item.fix.name === null ? "" : ` ${item.fix.name}${item.fix.version === null ? "" : ` ${item.fix.version}`}`;
  const fix = item.fix === null ? "no fix yet" : `fix:${target === "" ? " available" : target}${item.fix.major ? " (semver-major)" : ""}`;
  const head = `- ${DEPENDENCY_DOTS[item.severity]} **${item.severity}** \`${item.name}\`${item.range === null ? "" : ` ${item.range}`}`;
  return [head, reach, advisory, fix].filter((part) => part !== "").join(" — ");
}

function outdatedLine(item: OutdatedPackage): string {
  const tags = [
    item.type === "dev" || item.type === "optional" || item.type === "peer" ? item.type : "",
    item.deprecated ? "deprecated" : "",
    item.breaking ? "0.x: may break" : "",
    item.severity ?? "",
  ].filter((tag) => tag !== "");
  const suffix = `${tags.length === 0 ? "" : ` (${tags.join(", ")})`}${item.note === null ? "" : ` — ${escapeProse(item.note)}`}`;
  if (item.current === null) {
    const versions = [item.wanted === null ? "" : `wants ${item.wanted}`, item.latest === null || item.latest === item.wanted ? "" : `latest ${item.latest}`].filter((part) => part !== "");
    return `- \`${item.name}\` — not installed${versions.length === 0 ? "" : ` (${versions.join(", ")})`}${suffix}`;
  }
  const wanted = item.wanted !== null && item.wanted !== item.current && item.wanted !== item.latest ? item.wanted : null;
  const steps = [item.current];
  if (wanted !== null) steps.push(`${changedVersion(item.current, wanted)} (wanted)`);
  if (item.latest !== null) steps.push(`${changedVersion(wanted ?? item.current, item.latest)}${item.ahead ? " (older than installed)" : ""}`);
  return `- \`${item.name}\` ${steps.join(" → ")}${suffix}`;
}

/** A dependency report: vulnerabilities by severity with their fixes, then outdated packages by semver bump. */
function dependenciesMarkdown(value: Value | undefined): string {
  const read = readDependencies(value);
  if (!read.ok) return `_(${read.error})_`;
  const report = read.report;
  const vulnerable = DEPENDENCY_SEVERITIES.some((severity) => report.severities[severity] > 0);
  const parts: string[] = [];
  if (vulnerable) {
    const strip = DEPENDENCY_SEVERITIES.filter((severity) => report.severities[severity] > 0)
      .map((severity) => `${DEPENDENCY_DOTS[severity]} ${report.severities[severity]} ${severity}`)
      .join(" · ");
    const scanned = report.scanned === null ? "" : ` (${report.scanned} dependencies scanned)`;
    parts.push(`**Vulnerabilities**${report.auditSource === null ? "" : ` — ${report.auditSource}`}: ${strip}${scanned}`);
    const more = moreLine(Math.min(report.vulnerable.length, DEPENDENCY_ROWS), report.vulnerable.length, "package");
    parts.push([...report.vulnerable.slice(0, DEPENDENCY_ROWS).map(vulnerableLine), ...(more === "" ? [] : [more])].join("\n"));
  } else if (report.auditSource !== null) {
    parts.push(`**Vulnerabilities** — ${report.auditSource}: none found${report.scanned === null ? "" : ` in ${report.scanned} dependencies`}.`);
  }
  if (report.outdated.length > 0) {
    const groups = groupOutdated(report.outdated);
    const source = report.source === null ? "" : (DEPENDENCY_SOURCE[report.source] ?? "");
    const summary = groups.map((group) => `${group.packages.length} ${GROUP_LABEL[group.key].toLowerCase()}`).join(" · ");
    parts.push(`**Outdated**${source === "" ? "" : ` — ${source}`}: ${report.outdated.length} ${report.outdated.length === 1 ? "package" : "packages"} (${summary})`);
    for (const group of groups) {
      const lines = group.packages.slice(0, DEPENDENCY_ROWS).map(outdatedLine);
      const more = moreLine(lines.length, group.packages.length, "package");
      parts.push([`${GROUP_LABEL[group.key]} (${group.packages.length}):`, ...lines, ...(more === "" ? [] : [more])].join("\n"));
    }
  } else if (report.source !== null || !vulnerable) {
    parts.push(report.auditSource === null ? "**Dependencies** — every dependency is on its latest version." : "Every dependency is on its latest version.");
  }
  return paragraphs(parts);
}

/** Plain text with the characters markdown would read as emphasis, code or links escaped. */
function plainMarkdown(text: string): string {
  return text.replace(/[*_`[\]\\<>]/g, "\\$&");
}

/** A before/after row's conditions: what differs, what it varies on purpose, what one side leaves out, then what both share beyond the report's shared conditions. */
function comparisonConditions(row: Comparison, shared: Context): string {
  const comparability = row.comparability;
  if (comparability === null) return "";
  return [
    ...comparability.differing.map((item) => `${item.key} differs: ${item.before} before, ${item.after} after`),
    ...comparability.varied.map((item) => `${item.key} ${item.before ?? "not recorded"} → ${item.after ?? "not recorded"} (varied on purpose)`),
    ...comparability.oneSided.map((item) => `${item.key} ${item.before ?? item.after} (${item.before === null ? "after" : "before"} only)`),
    ...Object.entries(comparability.same)
      .filter(([key]) => !Object.hasOwn(shared, key))
      .map(([key, value]) => `${key} ${value}`),
  ].join(" · ");
}

/** Every run of an experiment: a summary line, the conditions all runs share, then a table per group with ★ on each metric's best and failed runs kept. */
function allRunsMarkdown(report: AllRunsReport): string {
  if (report.runs.length === 0) return "**Benchmark** · no runs";
  const total = report.runs.length;
  const summary = [
    `**Benchmark** · ${total} ${total === 1 ? "run" : "runs"}`,
    report.counts.ok < total ? `${report.counts.ok} measured` : "",
    ...unmeasuredCounts(report.runs).map((entry) => `${entry.count} ${entry.word}`),
    report.varying.length > 0 ? `conditions differ: ${report.varying.join(", ")}` : "",
  ].filter((part) => part !== "");
  const shared = formatConditions(report.shared);
  const metricHeads = report.metrics.map((metric) => `${metric.label} ${metric.better === "higher" ? "↑" : "↓"}`);
  const cohorts = groupRuns(report, report.groupBy);
  let budget = MARKDOWN_ROWS;
  const sections = cohorts.map((cohort) => {
    const conditions = cohort.varying;
    const notes = cohort.runs.some((run) => run.note !== null);
    const shown = cohort.runs.slice(0, Math.max(0, budget));
    budget -= shown.length;
    const rows = shown.map((run) => [
      run.name,
      ...report.metrics.map((metric) => {
        if (run.status !== "ok") return runStatusWord(run);
        if (!Object.hasOwn(run.values, metric.key)) return "—";
        const value = run.values[metric.key];
        const text = perfAmount(value, metric.unit, 4);
        return cohort.best[metric.key] === value ? `**${text}** ★` : text;
      }),
      ...(conditions.length === 0 ? [] : [conditions.flatMap((key) => (Object.hasOwn(run.context, key) ? [`${key} ${run.context[key]}`] : [])).join(" · ")]),
      ...(notes ? [run.note ?? ""] : []),
    ]);
    const title =
      cohort.key === null ? "" : `**${cohort.value === null ? `${cohort.key} not recorded` : `${cohort.key}: ${cohort.value}`}** · ${cohort.runs.length} ${cohort.runs.length === 1 ? "run" : "runs"}`;
    return paragraphs([
      title,
      table(["Run", ...metricHeads, ...(conditions.length === 0 ? [] : ["Conditions"]), ...(notes ? ["Note"] : [])], rows),
      moreLine(shown.length, cohort.runs.length, "run"),
    ]);
  });
  const unlike = cohorts.some((cohort) => cohort.varying.length > 0 && Object.keys(cohort.best).length > 0);
  return paragraphs([
    summary.join(" · "),
    shared === "" ? "" : `Same conditions for every run: ${shared}`,
    ...sections,
    `↑ higher is better · ↓ lower is better · ★ best of the measured runs${report.groupBy === null ? "" : ` per ${report.groupBy}`}${unlike ? ", among runs whose conditions differ" : ""}`,
  ]);
}

/** One compared image: its label, where it is (an https image inline), its capture facts and note. */
function compareImageLine(image: CompareImage, position: number): string {
  const remote = remoteImage(image.src, image.label);
  const facts = image.meta.map(([key, value]) => `${key} ${value}`).join(" · ");
  const parts = [remote ?? `\`${image.src}\``, facts, image.note === null ? "" : escapeProse(image.note)].filter((part) => part !== "");
  return `${position + 1}. **${escapeProse(image.label)}**${position === 0 ? " (reference)" : ""} — ${parts.join(" — ")}`;
}

/** Compare as its images (the reference first) and each condition mismatch against the reference; the pixel views need BB. */
function compareMarkdown(value: Value | undefined): string {
  const read = readCompare(value);
  if (!read.ok) return `_(${read.error})_`;
  const [reference, ...others] = read.images;
  if (reference === undefined) return "**Image comparison** · no images";
  const warnings = others.flatMap((other) => {
    const warning = conditionsWarning(conditionDifferences(reference, other), reference.label, other.label);
    return warning === null ? [] : [`⚠️ ${others.length > 1 ? `${escapeProse(other.label)}: ` : ""}${escapeProse(warning)}`];
  });
  const title =
    others.length === 0
      ? `**Image comparison** · only the reference so far`
      : `**Image comparison** · ${escapeProse(reference.label)} vs ${others.map((other) => escapeProse(other.label)).join(", ")}`;
  return paragraphs([
    title,
    read.images.map(compareImageLine).join("\n"),
    warnings.join("\n"),
    read.ignored > 0 ? `_${read.ignored} ${read.ignored === 1 ? "entry" : "entries"} without a src left out_` : "",
    others.length === 0 ? "" : "_Side by side, wipe, overlay and the pixel difference with its changed regions show in BB._",
  ]);
}

/** A value as a code span, its fence longer than any backtick run inside. */
function provenanceCode(value: string): string {
  const longest = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(longest + 1);
  return longest === 0 ? `${ticks}${value}${ticks}` : `${ticks} ${value} ${ticks}`;
}

const PROVENANCE_MARKS: Readonly<Record<string, string>> = { done: "✅", failed: "❌", running: "🔄", none: "❔", waiting: "⏳", "not-reached": "⚪", skipped: "⏭️" };

/** `branch `main` ✗ expected `feat/399``, a URL as a link. */
function provenanceFact(fact: ProvenanceFact, requested: boolean): string {
  const url = fact.key === "url" ? webUrl(fact.value, ["https:", "http:"]) : null;
  const value = url === null ? provenanceCode(fact.short) : link(fact.short, url);
  if (fact.check === null) return `${escapeProse(fact.label)} ${value}${requested && fact.confirmed ? " ✓" : ""}`;
  const other = fact.check.kind === "expected" ? `expected ${provenanceCode(shortValue(fact.key, fact.check.expected))}` : `was ${provenanceCode(shortValue(fact.key, fact.check.previous))}`;
  return `${escapeProse(fact.label)} ${value} ✗ ${other}`;
}

function provenanceEvidence(evidence: ProvenanceEvidence): string {
  const label = evidence.label === null ? "" : `${escapeProse(evidence.label)}: `;
  switch (evidence.kind) {
    case "url": {
      const url = webUrl(evidence.url, ["https:", "http:"]);
      return url === null ? `${label}${provenanceCode(evidence.url)}` : link(evidence.label ?? evidence.url.replace(/^https?:\/\//, ""), url);
    }
    case "image":
      return `${label === "" ? "image: " : label}${provenanceCode(evidence.src)}`;
    case "file":
      return `${label}${provenanceCode(evidence.line === null ? evidence.path : `${evidence.path}:${evidence.line}`)}`;
    case "text":
      return `${label}${provenanceCode(evidence.text.replace(/\s*\n\s*/g, " "))}`;
  }
}

/** A provenance chain: the verdict and what is wrong first, then each stage with its outcome, facts (wrong ones with both values) and evidence. */
function provenanceMarkdown(stages: Value | undefined, expected: Value | undefined): string {
  const read = readProvenance(stages, expected);
  if (!read.ok) return `_(${read.error})_`;
  const chain = read.provenance;
  if (chain.stages.length === 0) return "**Provenance** · no stages yet";
  const { verdict } = chain;
  const requested = new Set(chain.expected.map((fact) => fact.key));
  const head = [`${TONE_DOTS[verdict.tone]} **${escapeProse(verdict.title)}**`, ...verdict.lines.map((line) => `- ${escapeProse(line.text)}`)].join("\n");
  const wanted =
    chain.expected.length === 0
      ? ""
      : ` · requested: ${chain.expected
          .map((fact) => {
            const wrong = chain.mismatches.some((mismatch) => mismatch.key === fact.key && mismatch.check.kind === "expected");
            return `${escapeProse(fact.label)} ${provenanceCode(fact.short)} ${wrong ? "✗" : fact.confirmed ? "✓" : "(not confirmed)"}`;
          })
          .join(", ")}`;
  const lines = chain.stages.map((stage, index) => {
    const wrong = stage.facts.some((fact) => fact.check !== null);
    const mark = stage.receipt === "receipt" ? (stage.status === "done" && wrong ? "⚠️" : PROVENANCE_MARKS[stage.status]) : PROVENANCE_MARKS[stage.receipt];
    const state = stage.receipt === "receipt" ? (stage.status === "done" ? "" : STAGE_STATUS_LABEL[stage.status].toLowerCase()) : RECEIPT_LABEL[stage.receipt];
    const meta = [state, stage.note ?? "", stage.ms === null ? "" : formatElapsed(stage.ms), stage.last ? "last receipt" : ""].filter((part) => part !== "");
    const out = [`${index + 1}. ${mark} **${escapeProse(stage.name)}**${meta.length === 0 ? "" : ` — ${meta.map(escapeProse).join(" · ")}`}`];
    if (stage.facts.length > 0) out.push(`   ${stage.facts.map((fact) => provenanceFact(fact, requested.has(fact.key))).join(" · ")}`);
    if (stage.detail !== null) out.push(`   ${escapeProse(stage.detail.replace(/\s*\n\s*/g, " "))}`);
    if (stage.evidence.length > 0) out.push(`   Evidence: ${stage.evidence.map(provenanceEvidence).join(" · ")}`);
    return out.join("\n");
  });
  return paragraphs([head, `${escapeProse(chainSummary(chain))}${wanted}`, lines.join("\n")]);
}

/** A check as one glyph: checked results filled, a claim 💬, nothing run ⚪, n/a ➖. */
function acceptanceMark(check: Check): string {
  if (check.notApplicable) return "➖";
  return { passed: "✅", failed: "❌", blocked: "⛔", untested: "⚪", claimed: "💬", skipped: "⏭️" }[check.status];
}

/** Evidence inline: a file as `path:line`, a web link, an image by its path, the first line of a tool's text. */
function acceptanceEvidence(item: AcceptanceEvidence): string {
  const label = item.label === null ? "" : `${escapeProse(item.label)}: `;
  if (item.kind === "file") return `${label}\`${item.path}${item.line === null ? "" : `:${item.line}${item.endLine === null ? "" : `-${item.endLine}`}`}\``;
  if (item.kind === "text") {
    const first = item.text.split("\n")[0]!.trim();
    return `${label}“${escapeProse(first.length > 120 ? `${first.slice(0, 119)}…` : first)}”`;
  }
  const href = item.kind === "url" ? item.url : item.src;
  const url = webUrl(href, ["https:", "http:"]);
  return url === null ? `${label}\`${href}\`` : link(item.label ?? (item.kind === "image" ? "image" : url.host + url.pathname.replace(/\/$/, "")), url);
}

/** A check's detail lines under its list item: the note, method, run and time, and its evidence. */
function acceptanceDetail(check: Check): string[] {
  const facts = [check.method, check.run, check.at].filter((part) => part !== null);
  return [
    check.note === null ? "" : `  ${escapeProse(check.note.replace(/\s*\n\s*/g, " "))}`,
    facts.length === 0 ? "" : `  _${facts.map(escapeProse).join(" · ")}_`,
    check.evidence.length === 0 ? "" : `  Evidence: ${check.evidence.map(acceptanceEvidence).join(" · ")}`,
  ].filter((part) => part !== "");
}

/**
 * Acceptance as text: the verdict first, what needs the user, the owner's
 * limitations, then a matrix as a table of marks with every gap listed under
 * it, or one line per criterion with its note and evidence.
 */
function acceptanceMarkdown(criteria: Value | undefined, columns: Value | undefined): string {
  const read = readAcceptance(criteria, columns);
  if (!read.ok) return `_(${read.error})_`;
  const report = read.report;
  const verdict = acceptanceVerdict(report);
  const title = `**${escapeProse(report.title ?? "Acceptance")}**`;
  if (report.criteria.length === 0) return `${title} · no criteria yet`;
  const more = report.criteria.length > MARKDOWN_ROWS ? `_… and ${report.criteria.length - MARKDOWN_ROWS} more criteria_` : "";
  const contradiction = ownerContradiction(report, verdict);
  const cells = cellsLine(verdict);
  const head = [
    [
      title,
      `${report.criteria.length} ${report.criteria.length === 1 ? "criterion" : "criteria"}`,
      verdict.optional.total > 0 ? `${verdict.optional.total} optional` : "",
      report.columns.length > 0 ? `${report.columns.length} conditions` : "",
      report.hiddenColumns > 0 ? `${report.hiddenColumns} more not shown` : "",
    ]
      .filter((part) => part !== "")
      .join(" · "),
    `**${verdict.headline}**: ${[verdict.proven, ...verdict.parts].join(" · ")}`,
    cells === null ? "" : `_${cells}_`,
    contradiction === null ? "" : `⚠️ ${contradiction}`,
    report.statedVerdict === null ? "" : `Stated verdict: “${escapeProse(report.statedVerdict)}”`,
  ].filter((part) => part !== "");
  const needs =
    verdict.needsYou.length === 0
      ? ""
      : ["**Needs you**", ...verdict.needsYou.map((item) => `- ${escapeProse(item.what || "Your input")} — ${escapeProse(needsPlaces(item))}`)].join("\n");
  const limitations = report.limitations.length === 0 ? "" : ["Limitations the owner stated:", ...report.limitations.map((item) => `- ${escapeProse(item)}`)].join("\n");
  const shown = report.criteria.slice(0, MARKDOWN_ROWS);
  if (report.columns.length === 0) {
    const lines = shown.map((criterion) => {
      const check = criterion.own;
      const optional = criterion.required ? "" : " _(optional)_";
      return [`- ${acceptanceMark(check)} ${escapeProse(criterion.name)}${optional} — ${escapeProse(checkLabel(check))}`, ...acceptanceDetail(check)].join("\n");
    });
    return paragraphs([head.join("\n"), needs, limitations, [lines.join("\n"), more].filter((part) => part !== "").join("\n")]);
  }
  const rows = shown.map((criterion) => [
    `${acceptanceMark(criterion.own)} ${criterion.name}${criterion.required ? "" : " (optional)"}`,
    ...criterion.cells!.map((check) => acceptanceMark(check)),
  ]);
  const marks = new Set(shown.flatMap((criterion) => [criterion.own, ...criterion.cells!].map(acceptanceMark)));
  const legend = Object.entries({ "✅": "passed", "❌": "failed", "⛔": "blocked", "⚪": "not tested", "💬": "only claimed", "⏭️": "skipped", "➖": "not applicable" })
    .filter(([mark]) => marks.has(mark))
    .map(([mark, word]) => `${mark} ${word}`)
    .join(" · ");
  // Each open criterion's own note (when it has one), then its open cells; only cells are counted.
  let gapCells = 0;
  const gaps = shown.flatMap((criterion) => {
    if (!isGap(criterion)) return [];
    const own = acceptanceDetail({ ...criterion.own, method: null, run: null, at: null });
    const row = own.length === 0 ? [] : [[`- ${acceptanceMark(criterion.own)} **${escapeProse(criterion.name)}**${criterion.own.by === null ? "" : ` (${escapeProse(criterion.own.by)})`}`, ...own].join("\n")];
    const cells = criterion.cells!.flatMap((check, position) => {
      if (!isCellGap(check)) return [];
      const where = `${escapeProse(criterion.name)} · ${escapeProse(report.columns[position] ?? "")}`;
      return [[`- ${acceptanceMark(check)} ${where} — ${escapeProse(checkLabel(check))}`, ...acceptanceDetail(check)].join("\n")];
    });
    gapCells += cells.length;
    return [...row, ...cells];
  });
  const gapList = gaps.slice(0, MARKDOWN_ROWS);
  return paragraphs([
    head.join("\n"),
    needs,
    limitations,
    [table(["Criterion", ...report.columns], rows), more].filter((part) => part !== "").join("\n"),
    `_${legend}_`,
    gapList.length === 0 ? "" : [`**Gaps** (${gapCells} ${gapCells === 1 ? "cell" : "cells"})`, ...gapList, moreLine(gapList.length, gaps.length, "gap")].filter((part) => part !== "").join("\n"),
  ]);
}

/** Words of a lone transcript shown before "…". */
const TRANSCRIPT_EXCERPT_WORDS = 80;

/** Transcripts as WER per hypothesis, then each error with its time; a lone transcript as its text. */
function transcriptMarkdown(value: Value | undefined, audio: string): string {
  const read = readTracks(value);
  if (!read.ok) return `_(${read.error})_`;
  const analysis = analyse(read.tracks);
  if (analysis === null) return "**Transcript** · no words";
  const { reference, refTokens, comparisons, regions } = analysis;
  const end = Math.max(0, ...read.tracks.flatMap((track) => track.words.map((word) => word.end ?? 0)));
  const facts = [`${refTokens.length} ${refTokens.length === 1 ? "word" : "words"}`, end > 0 ? formatClock(end, false) : ""].filter((part) => part !== "");
  const recording = audio === "" ? "" : `Recording: \`${audio}\``;
  if (comparisons.length === 0) {
    const words = reference.words.slice(0, TRANSCRIPT_EXCERPT_WORDS).map((word) => word.text);
    return paragraphs([
      [`**Transcript** · ${reference.name}`, ...facts].join(" · "),
      `> ${words.join(" ")}${reference.words.length > words.length ? " …" : ""}`,
      recording,
    ]);
  }
  const score = (index: number) => {
    const comparison = comparisons[index];
    return `WER ${comparison.wer === null ? "—" : formatWer(comparison.wer)} (${countsText(comparison.counts)})`;
  };
  const head =
    comparisons.length === 1
      ? `**Transcript** · ${read.tracks[1].name} against ${reference.name}: ${score(0)} · ${facts.join(" · ")}`
      : [
          [`**Transcript** · ${comparisons.length} transcripts against ${reference.name}`, ...facts].join(" · "),
          ...comparisons.map((comparison, index) => `- ${read.tracks[comparison.track].name}: ${score(index)}`),
        ].join("\n");
  const shown = regions.slice(0, MARKDOWN_ROWS);
  const lines = shown.map((region) => {
    const at = region.start === null ? "" : `${formatClock(region.start)} `;
    const who = comparisons.length > 1 ? `${read.tracks[region.track].name}: ` : "";
    return `- ${at}${who}${describeRegion(region)}`;
  });
  return paragraphs([head, lines.length === 0 ? "" : [...lines, moreLine(shown.length, regions.length, "error")].filter((part) => part !== "").join("\n"), recording]);
}
