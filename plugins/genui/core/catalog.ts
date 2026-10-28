// The component catalog: the only components, actions and functions a UI
// spec may use. The validator checks specs against it, the renderer draws it,
// and the agent instructions are generated from it, so all three stay in
// lockstep.

export type ParamKind =
  /** Any scalar; numbers and booleans are converted with String(). */
  | "string"
  /** Markdown text. */
  | "text"
  | "number"
  | "boolean"
  /** One of `values`. */
  | "enum"
  /** Children: a node, string, number, null/false (dropped), or a nested list of those. Normalized to UiNode[]. */
  | "nodes"
  /** Any list. */
  | "list"
  /** `number[]`, or an object of series name → `number[]`. */
  | "series"
  /** A `$state` reference (two-way binding). Must be written literally as `$name`. */
  | "binding"
  /** An action call or a list of action calls. Normalized to Action[]. */
  | "actions"
  /**
   * A value, or a function the renderer calls for it (an arrow `t => ...`,
   * or a named function passed by name). Arrives as the value, or as a
   * FunctionValue.
   */
  | "function"
  /** Any value. */
  | "any";

/** What a bound `$state` must hold. `null` always fits: it means "empty". */
export type StateKind = "text" | "number" | "boolean" | "scalar" | "list";

export interface ParamSpec {
  readonly name: string;
  readonly kind: ParamKind;
  /** Optional params may be omitted or passed as `null`. */
  readonly optional?: boolean;
  /** Required param that may also be `null`. */
  readonly nullable?: boolean;
  /** Allowed literals for `enum`. */
  readonly values?: readonly string[];
  /** For `binding`: the state's required type, checked at compile and evaluation time. */
  readonly holds?: StateKind;
  /**
   * Accepted so replies written before it was retired still render, and
   * ignored: left out of every signature, so no prompt teaches it.
   */
  readonly legacy?: true;
  /**
   * Left out of the signatures because the reference states it once, in a
   * line, for every component that takes it (`source:`).
   */
  readonly unlisted?: true;
}

export interface ComponentSpec {
  readonly params: readonly ParamSpec[];
  /** Guidance for the agent instructions, only where the signature alone would mislead. */
  readonly summary?: string;
}

/** Instruction-prompt grouping; one line per group. */
export type ComponentGroup = "Layout" | "Content" | "Media" | "Data" | "Inputs" | "Widgets" | "Project" | "Dev" | "Manage" | "Evidence" | "3D";

export interface CatalogComponentSpec extends ComponentSpec {
  readonly group: ComponentGroup;
}

const TONES = ["neutral", "good", "warn", "bad", "info"] as const;

const tone = { name: "tone", kind: "enum", optional: true, values: TONES } as const;
const label = { name: "label", kind: "string", optional: true } as const;
const children = { name: "children", kind: "nodes" } as const;
/** Where a Table's, Chart's or Metric's numbers come from; a quiet caption under it. */
const source = { name: "source", kind: "string", optional: true, unlisted: true } as const;

export const COMPONENTS = {
  Card: {
    group: "Layout",
    params: [{ name: "title", kind: "string", nullable: true }, children],
  },
  Row: {
    group: "Layout",
    params: [children],
    summary: "equal-width, wraps",
  },
  Stack: {
    group: "Layout",
    params: [children],
  },
  Grid: {
    group: "Layout",
    params: [children, { name: "columns", kind: "number", optional: true }],
    summary: "tiles",
  },
  Tabs: {
    group: "Layout",
    params: [{ name: "labels", kind: "list" }, children],
  },
  Details: {
    group: "Layout",
    params: [{ name: "title", kind: "string" }, children, { name: "open", kind: "boolean", optional: true }],
    summary: "collapsible",
  },
  Divider: {
    group: "Layout",
    params: [],
  },
  Text: {
    group: "Content",
    params: [{ name: "text", kind: "text" }, tone],
    summary: "markdown",
  },
  Callout: {
    group: "Content",
    params: [{ name: "text", kind: "text" }, tone, { name: "title", kind: "string", optional: true }],
  },
  Metric: {
    group: "Content",
    params: [
      { name: "label", kind: "string" },
      { name: "value", kind: "string" },
      { name: "note", kind: "string", optional: true },
      tone,
      source,
    ],
    summary: "key number; 2-4 in a Row",
  },
  Badge: {
    group: "Content",
    params: [{ name: "text", kind: "string" }, tone],
    summary: "1-3 word status; explain in the next cell",
  },
  Icon: {
    group: "Content",
    params: [{ name: "name", kind: "string" }, tone],
    summary: "lucide name",
  },
  KeyValue: {
    group: "Content",
    params: [{ name: "pairs", kind: "any" }],
    summary: "object or [[k, v]]",
  },
  Image: {
    group: "Content",
    params: [{ name: "src", kind: "string" }, { name: "alt", kind: "string", optional: true }],
    summary: "path or https URL; the only way the user sees an image (they never see images your tools open)",
  },
  File: {
    group: "Content",
    params: [
      { name: "path", kind: "string" },
      { name: "line", kind: "number", optional: true },
    ],
  },
  Table: {
    group: "Data",
    params: [
      { name: "columns", kind: "list" },
      { name: "rows", kind: "list" },
      source,
    ],
    summary: "rows: lists of values or components",
  },
  Chart: {
    group: "Data",
    params: [
      { name: "type", kind: "enum", values: ["bar", "line", "area", "pie", "scatter", "radar", "funnel", "heatmap", "histogram", "box"] },
      { name: "labels", kind: "list" },
      { name: "series", kind: "series" },
      { name: "unit", kind: "string", optional: true },
      { name: "stacked", kind: "boolean", optional: true },
      source,
    ],
    summary: "series: numbers or {name: numbers | {values, tone}}; labels: scatter x values, histogram bin edges or []; heatmap: series = rows",
  },
  Sparkline: {
    group: "Data",
    params: [{ name: "values", kind: "list" }, tone],
  },
  Progress: {
    group: "Data",
    params: [
      { name: "value", kind: "number" },
      { name: "max", kind: "number", optional: true },
      label,
      tone,
    ],
    summary: "% without max",
  },
  Steps: {
    group: "Data",
    params: [{ name: "items", kind: "list" }],
    summary: "{title,detail?,status?:done|current|blocked}",
  },
  Timeline: {
    group: "Data",
    params: [{ name: "items", kind: "list" }],
    summary: "{time,title,detail?,tone?}",
  },
  Tree: {
    group: "Data",
    params: [{ name: "items", kind: "list" }],
    summary: "paths or {label,children?,note?}",
  },
  Code: {
    group: "Data",
    params: [
      { name: "code", kind: "string" },
      { name: "language", kind: "string", optional: true },
    ],
  },
  Snippet: {
    group: "Data",
    params: [
      { name: "path", kind: "string" },
      { name: "from", kind: "number", optional: true },
      { name: "to", kind: "number", optional: true },
    ],
    summary: "lines of a file, 1-based",
  },
  Diff: {
    group: "Data",
    params: [{ name: "patch", kind: "string" }],
    summary: "unified, one file",
  },
  Diagram: {
    group: "Data",
    params: [
      { name: "mermaid", kind: "string" },
      { name: "details", kind: "any", optional: true },
    ],
    summary: "details {nodeId: text or components} open when that node is clicked",
  },
  Slider: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "number" },
      { name: "min", kind: "number" },
      { name: "max", kind: "number" },
      { name: "step", kind: "number", optional: true },
      label,
    ],
  },
  Stepper: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "number" },
      { name: "min", kind: "number", optional: true },
      { name: "max", kind: "number", optional: true },
      { name: "step", kind: "number", optional: true },
      label,
    ],
    summary: "counts",
  },
  Toggle: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "boolean" },
      { name: "label", kind: "string" },
    ],
  },
  Choice: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding", holds: "scalar" }, { name: "options", kind: "list" }, label],
    summary: "short options",
  },
  Radio: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding", holds: "scalar" }, { name: "options", kind: "list" }, label],
    summary: "{value,detail} options",
  },
  Select: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding", holds: "scalar" }, { name: "options", kind: "list" }, label],
    summary: "many options",
  },
  Checklist: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding", holds: "list" }, { name: "options", kind: "list" }, label],
    summary: "multi-select, state []",
  },
  ListEditor: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "list" },
      label,
      { name: "placeholder", kind: "string", optional: true },
    ],
    summary: "editable list of strings",
  },
  Input: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "text" },
      label,
      { name: "placeholder", kind: "string", optional: true },
    ],
  },
  TextArea: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "text" },
      label,
      { name: "placeholder", kind: "string", optional: true },
    ],
  },
  DateInput: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding", holds: "text" }, label],
    summary: "yyyy-mm-dd",
  },
  Rating: {
    group: "Inputs",
    params: [
      { name: "value", kind: "binding", holds: "number" },
      { name: "max", kind: "number", optional: true },
      label,
    ],
  },
  Button: {
    group: "Inputs",
    params: [
      { name: "label", kind: "string" },
      { name: "action", kind: "actions", optional: true },
      {
        name: "variant",
        kind: "enum",
        optional: true,
        values: ["primary", "secondary", "destructive"],
      },
      { name: "icon", kind: "string", optional: true },
    ],
    summary:
      "no action: a choice; its label is the answer; primary: the one main action; destructive: deleting or discarding; icon: lucide name",
  },
  Form: {
    group: "Inputs",
    params: [children, { name: "submit", kind: "string", optional: true, legacy: true }],
    summary: "one labeled field per question; the answers go into the user's message",
  },
  Timer: {
    group: "Widgets",
    params: [{ name: "seconds", kind: "number", optional: true }, label],
    summary: "no seconds = stopwatch",
  },
  Quiz: {
    group: "Widgets",
    params: [{ name: "questions", kind: "list" }],
    summary: "{q,options,answer:index,why?}",
  },
  Flashcards: {
    group: "Widgets",
    params: [{ name: "cards", kind: "list" }],
    summary: "{front,back}",
  },
  // Added from ChatGPT's catalog (see README "Components").
  ImageSearch: {
    group: "Media",
    params: [
      { name: "query", kind: "string" },
      { name: "alt", kind: "string", optional: true },
      { name: "aspect", kind: "enum", optional: true, values: ["wide", "square", "tall"] },
    ],
    summary: "a credited web photo of a description, for things no file shows; wide by default",
  },
  Gallery: {
    group: "Media",
    params: [
      { name: "images", kind: "list" },
      { name: "columns", kind: "number", optional: true },
    ],
    summary: "paths, https URLs or {src|query, caption?}",
  },
  Map: {
    group: "Media",
    params: [
      { name: "places", kind: "list" },
      { name: "route", kind: "boolean", optional: true },
      { name: "tour", kind: "boolean", optional: true },
    ],
    summary:
      "{name, lat?, lng?, note?, day?, wiki?: Wikipedia title (credited photo)}; names without lat/lng are looked up; route joins them day by day; tour drops pins in turn",
  },
  Hotspots: {
    group: "Media",
    params: [
      { name: "image", kind: "string" },
      { name: "points", kind: "list" },
    ],
    summary: "numbered pins on an image: {x, y (% across, down), title, text?}",
  },
  Entity: {
    group: "Content",
    params: [
      { name: "name", kind: "string" },
      { name: "kind", kind: "enum", optional: true, values: ["product", "place", "person", "org", "link", "other"] },
      { name: "image", kind: "string", optional: true },
      { name: "facts", kind: "any", optional: true },
      { name: "url", kind: "string", optional: true },
      { name: "note", kind: "text", optional: true },
    ],
    summary: "a product, place or person card; facts {label: value} open in its detail view",
  },
  Sources: {
    group: "Content",
    params: [{ name: "links", kind: "list" }],
    summary: "https URLs or {url, title?, note?}",
  },
  List: {
    group: "Content",
    params: [{ name: "items", kind: "list" }],
    summary: "rows {title, detail?, icon?, value?, tone?, action?}",
  },
  Calendar: {
    group: "Data",
    params: [
      { name: "events", kind: "list" },
      { name: "month", kind: "string", optional: true },
    ],
    summary: "{date: yyyy-mm-dd, title, tone?} on a month grid; month yyyy-mm",
  },
  Gauge: {
    group: "Data",
    params: [
      { name: "value", kind: "number" },
      { name: "min", kind: "number", optional: true },
      { name: "max", kind: "number", optional: true },
      label,
      tone,
    ],
    summary: "a dial; max defaults to 100",
  },
  CalendarHeatmap: {
    group: "Data",
    params: [{ name: "days", kind: "any" }, label, tone],
    summary: "{yyyy-mm-dd: count} or [{date, value}]",
  },
  SegmentedBar: {
    group: "Data",
    params: [
      { name: "parts", kind: "list" },
      { name: "unit", kind: "string", optional: true },
    ],
    summary: "shares of one whole: {label, value, tone?}",
  },
  Carousel: {
    group: "Layout",
    params: [children],
    summary: "a swipeable row of cards",
  },
  OptionCards: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding" }, { name: "options", kind: "list" }, label],
    summary: "picture or detail options {value, title?, detail?, image?, icon?}; a list state picks several",
  },
  Swatches: {
    group: "Inputs",
    params: [
      { name: "colors", kind: "list" },
      { name: "value", kind: "binding", holds: "text", optional: true },
      label,
    ],
    summary: "CSS colors or {value, name?}; with a $state the user picks one",
  },
  EditableTable: {
    group: "Inputs",
    params: [{ name: "value", kind: "binding", holds: "list" }, { name: "columns", kind: "list" }, label],
    summary: "state: list of row objects; columns: keys or {key, label?, type?: text|number|boolean}",
  },
  FollowUps: {
    group: "Inputs",
    params: [{ name: "prompts", kind: "list" }],
    summary: "suggested next questions; a tap picks one",
  },
  Walkthrough: {
    group: "Widgets",
    params: [{ name: "steps", kind: "list" }],
    summary: "{title, body, code?, language?} one step at a time",
  },
  // Project: the first four read BB's own state for the reply's thread, so the
  // model writes no data at all; Tests and Json take Load() of a report.
  Changes: {
    group: "Project",
    params: [
      { name: "target", kind: "string", optional: true },
      { name: "paths", kind: "list", optional: true },
    ],
    summary:
      'files changed in this thread\'s checkout with +/- and diffs; target: omit for the branch\'s work incl. uncommitted, "uncommitted", or a commit sha; paths filters',
  },
  Commits: {
    group: "Project",
    params: [{ name: "limit", kind: "number", optional: true }],
    summary: "this branch's commits since the default branch, each opening its changes",
  },
  PullRequest: {
    group: "Project",
    params: [],
    summary: "this branch's pull request: state, checks, review",
  },
  Threads: {
    group: "Project",
    params: [{ name: "ids", kind: "list", optional: true }],
    summary: "live status of BB threads; omit ids for this thread's subthreads",
  },
  Tests: {
    group: "Project",
    params: [{ name: "results", kind: "any" }, { name: "title", kind: "string", optional: true }],
    summary: "a Load()ed test report, or [{name, status: passed|failed|skipped, message?, file?, line?}]",
  },
  Json: {
    group: "Project",
    params: [{ name: "value", kind: "any" }, label],
    summary: "collapsible JSON explorer; Load() a big file instead of retyping it",
  },
  // Dev: what tools print, read from the file the agent saved (Load), never
  // retyped: logs, errors, findings, CI runs, coverage, dependencies, timings.
  Logs: {
    group: "Dev",
    params: [
      { name: "output", kind: "any" },
      { name: "command", kind: "string", optional: true },
      { name: "exit", kind: "number", optional: true },
    ],
    summary: "Load a log or command output; exit: its exit code",
  },
  StackTrace: {
    group: "Dev",
    params: [{ name: "trace", kind: "any" }, { name: "title", kind: "string", optional: true }],
    summary: "an error and its stack, any language",
  },
  Findings: {
    group: "Dev",
    params: [{ name: "items", kind: "any" }, { name: "title", kind: "string", optional: true }],
    summary: "review/lint/type errors [{severity, title, file?, line?, detail?, fix?, status?: open|fixed|confirmed|rejected}] or a Load()ed lint/tsc report",
  },
  Coverage: {
    group: "Dev",
    params: [{ name: "report", kind: "any" }],
    summary: "a Load()ed coverage report",
  },
  Dependencies: {
    group: "Dev",
    params: [{ name: "report", kind: "any" }],
    summary: "[{name, current, latest}] or a Load()ed npm/pip report",
  },
  Pipeline: {
    group: "Dev",
    params: [{ name: "run", kind: "any" }],
    summary: "a CI run: [{name, status, jobs?}] or a Load()ed gh run",
  },
  Benchmark: {
    group: "Dev",
    params: [{ name: "results", kind: "any" }, { name: "unit", kind: "string", optional: true }],
    summary: "before/after [{name, before, after, better?: lower|higher, context?}], every run [{name, metrics, status?, context?}] or a Load()ed hyperfine run",
  },
  Waterfall: {
    group: "Dev",
    params: [{ name: "spans", kind: "any" }, { name: "unit", kind: "string", optional: true }],
    summary: "timings [{name, start, duration, depth?}] or a Load()ed HAR",
  },
  Treemap: {
    group: "Dev",
    params: [{ name: "items", kind: "any" }, { name: "unit", kind: "string", optional: true }],
    summary: "sizes [{path, size}] or a Load()ed du/esbuild report",
  },
  // Manage: planning and tracking, plus BB's own environments.
  Board: {
    group: "Manage",
    params: [{ name: "items", kind: "any" }, { name: "columns", kind: "list", optional: true }],
    summary: "kanban: [{title, status, …}] or a Load()ed task/issue list",
  },
  Roadmap: {
    group: "Manage",
    params: [{ name: "items", kind: "list" }],
    summary: "Gantt [{title, start, end, lane?, status?, milestone?}], dates yyyy-mm-dd",
  },
  Status: {
    group: "Manage",
    params: [{ name: "items", kind: "list" }],
    summary: "health [{name, status: on-track|at-risk|off-track|done, progress?, owner?, due?, note?}]",
  },
  Plan: {
    group: "Manage",
    params: [{ name: "steps", kind: "list" }, { name: "submit", kind: "string", optional: true, legacy: true }],
    summary: "steps the user approves first [{title, detail?, files?, risk?, estimate?}]",
  },
  Decision: {
    group: "Manage",
    params: [
      { name: "options", kind: "list" },
      { name: "criteria", kind: "list" },
    ],
    summary: "options [{name, scores: 1-5 per criterion, pros?, cons?}] vs criteria; user tunes weights",
  },
  Estimate: {
    group: "Manage",
    params: [{ name: "tasks", kind: "list" }, { name: "unit", kind: "string", optional: true }],
    summary: "three-point effort [{title, low, high, likely?}]: P50/P90 total",
  },
  Environments: {
    group: "Manage",
    params: [],
    summary: "this project's worktrees: branch, threads, changes, PR",
  },
  // Evidence: what is actually proven, running, or heard, as opposed to what
  // an agent says. Grounded in the user's own BB history (acceptance claims
  // without proof, visual parity disputes, wrong installed builds, speech).
  Acceptance: {
    group: "Evidence",
    params: [{ name: "criteria", kind: "any" }, { name: "columns", kind: "list", optional: true }],
    summary:
      "is it really done (criteria, a review verdict, claimed vs checked): [{name, status | cells: {column: status | {status, note?, evidence?}}}]; passed|failed|blocked|untested|claimed",
  },
  Compare: {
    group: "Evidence",
    params: [{ name: "images", kind: "list" }],
    summary: "a visual difference vs a reference or before/after: [src | {src, label?}], reference first; wipe, blink, pixel diff",
  },
  Transcript: {
    group: "Evidence",
    params: [{ name: "tracks", kind: "any" }, { name: "audio", kind: "string", optional: true }],
    summary:
      "transcription or speaker errors: [{name, words: [{text, start, end, speaker?}]} | {name, text}], the first is the reference; WER; a word seeks the audio",
  },
  Provenance: {
    group: "Evidence",
    params: [{ name: "stages", kind: "list" }, { name: "expected", kind: "any", optional: true }],
    summary:
      "which build/revision is really installed or deployed where: [{name, status, facts?: {branch, sha, build, device}}], source to live; expected flags mismatches",
  },
  // 3D: Zeron's ui.scene and ui.shader. The full object and uniform reference
  // is in the gallery examples' notes (ui_examples), not the instructions.
  Scene: {
    group: "3D",
    params: [
      { name: "objects", kind: "function" },
      { name: "height", kind: "number", optional: true },
      { name: "camera", kind: "any", optional: true },
      { name: "orbit", kind: "boolean", optional: true },
      { name: "spin", kind: "number", optional: true },
      { name: "animate", kind: "boolean", optional: true },
    ],
    summary: "[{shape, at, …}] or t => [...] per frame",
  },
  Shader: {
    group: "3D",
    params: [
      { name: "code", kind: "string" },
      { name: "height", kind: "number", optional: true },
      { name: "buffers", kind: "list", optional: true },
      { name: "inputs", kind: "any", optional: true },
      { name: "textures", kind: "list", optional: true },
      { name: "blend", kind: "enum", optional: true, values: ["light", "alpha", "opaque"] },
      { name: "bloom", kind: "number", optional: true },
      { name: "orbit", kind: "boolean", optional: true },
      { name: "spin", kind: "number", optional: true },
      { name: "camera", kind: "any", optional: true },
      { name: "animate", kind: "boolean", optional: true },
    ],
    summary: "Shadertoy GLSL",
  },
} as const satisfies Record<string, CatalogComponentSpec>;

export type ComponentName = keyof typeof COMPONENTS;

/** `Name(a, b?, $state, kind:x|y?)`: how the reference and the gallery write a component's or action's call. */
export function callSignature(name: string, spec: ComponentSpec): string {
  const params = spec.params.filter((param) => param.legacy !== true && param.unlisted !== true).map((param) => {
    let base = param.kind === "binding" ? `$${param.name}` : param.name;
    // Tones are listed once in the reference header; other enums inline their values.
    if (param.kind === "enum" && param.name !== "tone") {
      base += `:${param.values?.join("|")}`;
    }
    return param.optional ? `${base}?` : base;
  });
  return `${name}(${params.join(", ")})`;
}

/** `Sig: summary`, as the reference lists a component. */
export function componentSignature(name: ComponentName): string {
  const spec: ComponentSpec = COMPONENTS[name];
  const sig = callSignature(name, spec);
  return spec.summary === undefined ? sig : `${sig}: ${spec.summary}`;
}

export const ACTIONS = {
  Send: {
    params: [{ name: "text", kind: "string" }],
    summary: "the answer a picked Button or List row puts in the user's message",
  },
  Set: {
    params: [
      { name: "state", kind: "binding" },
      { name: "value", kind: "any" },
    ],
    summary: "assign a state variable",
  },
  OpenUrl: {
    params: [{ name: "url", kind: "string" }],
    summary: "open an http(s) URL",
  },
  Copy: {
    params: [{ name: "text", kind: "string" }],
    summary: "copy text to the clipboard",
  },
} as const satisfies Record<string, ComponentSpec>;

export type ActionName = keyof typeof ACTIONS;

/** Global pure functions. */
export const FUNCTIONS = {
  round: "round(x, digits?)",
  fmt: "fmt(x, digits?) → grouped string, e.g. 1,234.5",
  sum: "sum(list)",
  min: "min(list | ...numbers)",
  max: "max(list | ...numbers)",
  abs: "abs(x)",
  floor: "floor(x)",
  ceil: "ceil(x)",
  sqrt: "sqrt(x)",
  pow: "pow(x, y)",
  sin: "sin(radians)",
  cos: "cos(radians)",
  tan: "tan(radians)",
  asin: "asin(x) → radians",
  acos: "acos(x) → radians",
  atan: "atan(x) → radians",
  atan2: "atan2(y, x) → radians",
  clamp: "clamp(x, lo, hi)",
  lerp: "lerp(a, b, t) → a + (b - a) * t",
  range: "range(a, b, step?) → [a, a + step, …] up to b, exclusive",
  random: "random(i) → 0–1, the same for the same i on every render",
  keys: "keys(object) → list of keys",
  values: "values(object) → list of values",
  entries: "entries(object) → list of [key, value]",
  Load: "Load(path): JSON/CSV/TSV/JSONL/text file, workspace-relative or in thread storage",
} as const;

export type FunctionName = keyof typeof FUNCTIONS;

/** Built-in names that read as numbers, for angles in 3D. */
export const CONSTANTS: Readonly<Record<string, number>> = { PI: Math.PI, TAU: 2 * Math.PI };

/** Whitelisted methods by receiver type. Anything else is an error. */
export const METHODS = {
  list: [
    "map",
    "filter",
    "find",
    "some",
    "every",
    "join",
    "slice",
    "includes",
    "indexOf",
  ],
  string: [
    "includes",
    "slice",
    "split",
    "trim",
    "toUpperCase",
    "toLowerCase",
    "startsWith",
    "endsWith",
  ],
  number: ["toFixed"],
} as const;

/** Read-only properties allowed on lists and strings (plain objects allow any own key). */
export const PROPERTIES = { list: ["length"], string: ["length"] } as const;

/** Property names that are always rejected, on every receiver. */
export const FORBIDDEN_PROPERTIES = [
  "__proto__",
  "prototype",
  "constructor",
] as const;

/** Resource limits enforced by compile/evaluate. */
export const LIMITS = {
  sourceChars: 20_000,
  /** Interpreter steps per evaluate() call. */
  steps: 200_000,
  /**
   * Steps per call of a function a renderer calls (a Scene's `t => ...`, a
   * surface's `f`): each call starts afresh, since a scene calls it every frame
   * and a surface once per grid point.
   */
  functionSteps: 50_000,
  /** UiNodes produced per evaluate() call. */
  nodes: 2_000,
  /** Elements in any list produced or iterated. */
  listLength: 1_000,
  /**
   * Elements in any list of a loaded file. Reports (SARIF results, Ruff, a HAR)
   * pass 1,000 often and go to a component whole; iterating one in the spec
   * (`.map`, `.filter`, …) is still capped at listLength.
   */
  loadedListLength: 20_000,
} as const;
