// Benchmark results as Benchmark shows them: before/after rows with their
// change and a verdict that respects noise and the conditions each side was
// measured under, ranked runs (hyperfine --export-json, vitest bench
// --outputJson) with "1.84 ± 0.05 × faster than", or every run of an
// experiment with its metrics, status and conditions. Pure; shared by the
// renderer and the markdown fallback.
import { objectFields, unitInfo, type Fields } from "./perf-units";
import type { Value } from "./types";

export type Better = "lower" | "higher";
export type Verdict = "better" | "worse" | "same";

/** A change smaller than this (in percent) is noise whatever the spread. */
export const NOISE_PERCENT = 1;

export interface Comparison {
  readonly name: string;
  readonly before: number;
  readonly after: number;
  readonly unit: string | null;
  readonly better: Better;
  readonly delta: number;
  /** The change in percent of `before`; null when `before` is 0. */
  readonly percent: number | null;
  /** The spread the change is judged against (a stddev), when the row has one. */
  readonly noise: number | null;
  readonly verdict: Verdict;
  readonly note: string | null;
  /** Each side's repeated values when the row gives a list (`before: [58.19, 58.04]`); its value is their mean. */
  readonly beforeSamples: readonly number[];
  readonly afterSamples: readonly number[];
  /** The conditions each side was measured under; null when the row records none. */
  readonly contextBefore: Context | null;
  readonly contextAfter: Context | null;
  /** How the two sides' conditions compare; null when the row records none. */
  readonly comparability: Comparability | null;
  /** False when a recorded condition differs: the change is then no result, and the row is not counted or judged. */
  readonly comparable: boolean;
}

/** How a report's verdicts read: "faster/slower", "smaller/larger", or "better/worse". */
export interface VerdictWords {
  readonly better: string;
  readonly worse: string;
}

export interface CompareReport {
  readonly kind: "compare";
  readonly rows: readonly Comparison[];
  /** Verdicts of the comparable rows. */
  readonly counts: Readonly<Record<Verdict, number>>;
  /** Rows whose two sides were measured under different conditions. */
  readonly incomparable: number;
  /** Conditions every row records on both sides with the same value, said once instead of per row. */
  readonly shared: Context;
  readonly words: VerdictWords;
  /**
   * The geometric mean of every comparable row's after/before, oriented so
   * below 1 is better: 0.9 reads "10% faster overall". Null with fewer than
   * two comparable rows, or when a value is not positive.
   */
  readonly geomean: number | null;
  /** Items without a name or two numbers, left out. */
  readonly ignored: number;
}

export interface Run {
  readonly name: string;
  readonly mean: number;
  readonly stddev: number | null;
  /**
   * The uncertainty of the mean that the ratio's spread propagates: the
   * stddev for hyperfine and hand-written runs (as hyperfine computes its
   * "± "), the standard error of the mean for vitest, whose thousands of
   * samples make the stddev say little about the mean.
   */
  readonly error: number | null;
  /** The 99th percentile where the tool reports it (vitest): the plot's axis stops there, past one-off outliers. */
  readonly p99: number | null;
  readonly median: number | null;
  readonly min: number;
  readonly max: number;
  /** Each run's time (hyperfine `times`, vitest `samples`), in the report's unit. */
  readonly times: readonly number[];
  /** mean ÷ the fastest mean (1 for the fastest). */
  readonly ratio: number;
  /** The spread of `ratio` propagated from both stddevs, as hyperfine computes it; null without stddevs. */
  readonly ratioStddev: number | null;
  /** Further facts the tool reported (user/system time, ops/s, ±rme, samples, memory). */
  readonly facts: readonly { readonly label: string; readonly value: number; readonly unit: string | null }[];
  /** A run that exited non-zero (hyperfine `exit_codes`), so its time measures a failure. */
  readonly failed: boolean;
}

export interface RunGroup {
  readonly name: string | null;
  /** Where the group came from (a bench file), quiet beside its name. */
  readonly source: string | null;
  /** Fastest first. */
  readonly runs: readonly Run[];
}

export interface RunsReport {
  readonly kind: "runs";
  readonly tool: "hyperfine" | "vitest" | "list";
  /** The unit every time is in: "s" for hyperfine, "ms" for vitest, the given unit for a list. */
  readonly unit: string;
  readonly groups: readonly RunGroup[];
  readonly ignored: number;
}

export type BenchmarkReport = CompareReport | RunsReport | AllRunsReport;
export type BenchmarkRead = { readonly ok: true; readonly report: BenchmarkReport } | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Conditions

/** The conditions a value was measured under (device, build, thermal, display, cache, input…): key → value as written, in the order given. */
export type Context = Readonly<Record<string, string>>;

/** One condition on both sides of a comparison; null where that side does not record it. */
export interface ContextChange {
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface Comparability {
  /**
   * matched: every condition recorded on both sides is the same. differs: one
   * differs, so the change is not a like-for-like result. partial: nothing
   * differs, but some conditions are recorded on one side only.
   */
  readonly state: "matched" | "differs" | "partial";
  /** Conditions both sides record, with different values. */
  readonly differing: readonly ContextChange[];
  /** Conditions only one side records. */
  readonly oneSided: readonly ContextChange[];
  /** Conditions the row names as what it varies (`varies`): their change is the experiment, not a flaw. */
  readonly varied: readonly ContextChange[];
  /** Conditions both sides record with the same value. */
  readonly same: Context;
}

// ---------------------------------------------------------------------------
// All runs

/** ok: the run measured; failed: it broke (crashed, errored); timeout: it ran out of time; other: a status the input names (skipped, thermal_refused…). */
export type RunStatus = "ok" | "failed" | "timeout" | "other";

export interface MetricColumn {
  readonly key: string;
  readonly label: string;
  readonly unit: string | null;
  readonly better: Better;
}

export interface RunRecord {
  readonly name: string;
  readonly status: RunStatus;
  /** The status as written when it says more than the canonical word ("crashed", "thermal_refused"); null otherwise. */
  readonly statusLabel: string | null;
  /** Each metric's value by key; a metric the run did not measure is absent. Only an ok run's values are results. */
  readonly values: Readonly<Record<string, number>>;
  readonly context: Context;
  readonly note: string | null;
}

export interface AllRunsReport {
  readonly kind: "all-runs";
  readonly metrics: readonly MetricColumn[];
  /** In the order given, usually the order they ran. */
  readonly runs: readonly RunRecord[];
  readonly counts: Readonly<Record<RunStatus, number>>;
  /** Conditions every run records with the same value. */
  readonly shared: Context;
  /** Conditions that differ between runs or that some runs leave out, in first-seen order: what the runs can be grouped by. */
  readonly varying: readonly string[];
  /** The grouping the input asks for (`groupBy`), when it names a varying condition. */
  readonly groupBy: string | null;
  /** Items that are not runs, left out. */
  readonly ignored: number;
}

/** Runs sharing one value of the grouping condition, with the best value per metric among them. */
export interface Cohort {
  /** The grouping condition; null when the runs are not grouped. */
  readonly key: string | null;
  /** Its value in these runs; null for runs that do not record it (or when not grouped). */
  readonly value: string | null;
  readonly runs: readonly RunRecord[];
  /** The best value per metric key among the cohort's ok runs, where at least two measured it. */
  readonly best: Readonly<Record<string, number>>;
  /** Conditions that still differ inside the cohort: its best values compare unlike runs. */
  readonly varying: readonly string[];
}

const USAGE = "Benchmark needs [{name, before, after}], hyperfine --export-json or vitest bench --outputJson output";

/** A finite number, or a string holding only one ("12.5"). */
function numeric(value: Value | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i.test(value)) return Number(value);
  return null;
}

function label(value: Value | undefined): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** The words a verdict reads in, from what the rows measure. */
export function verdictWords(rows: readonly { readonly unit: string | null; readonly better: Better }[]): VerdictWords {
  const kinds = new Set<string>(rows.map((row) => `${unitInfo(row.unit).kind}:${row.better}`));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "time:lower" || only === "rate:higher") return { better: "faster", worse: "slower" };
    if (only === "bytes:lower") return { better: "smaller", worse: "larger" };
  }
  return { better: "better", worse: "worse" };
}

/** better, worse, or same: within ±NOISE_PERCENT, or no bigger than the spread. */
export function verdictOf(before: number, after: number, better: Better, noise: number | null): Verdict {
  const delta = after - before;
  if (delta === 0) return "same";
  if (before !== 0 && Math.abs(delta / before) * 100 < NOISE_PERCENT) return "same";
  if (noise !== null && Math.abs(delta) <= noise) return "same";
  return (delta < 0) === (better === "lower") ? "better" : "worse";
}

/** Conditions as written: scalar fields only (true/false read "yes"/"no"); null when there are none. */
export function readContext(value: Value | undefined): Context | null {
  const fields = objectFields(value);
  if (fields === null) return null;
  const context: Record<string, string> = {};
  for (const [key, item] of Object.entries(fields)) {
    const text = typeof item === "boolean" ? (item ? "yes" : "no") : label(item);
    if (key.trim() !== "" && text !== "") context[key.trim()] = text;
  }
  return Object.keys(context).length === 0 ? null : context;
}

/** Two conditions are the same when they read the same, ignoring case and spacing ("120 Hz" = "120  hz"). */
function sameCondition(a: string, b: string): boolean {
  const normal = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  return normal(a) === normal(b);
}

/** Later contexts override earlier ones key by key; null when none records anything. */
function mergeContexts(...contexts: readonly (Context | null)[]): Context | null {
  const present = contexts.filter((context): context is Context => context !== null);
  return present.length === 0 ? null : Object.assign({}, ...present);
}

/** How the conditions of a before and an after compare; `varies` names the conditions the comparison changes on purpose. Null when neither side records any. */
export function compareContexts(before: Context | null, after: Context | null, varies: readonly string[] = []): Comparability | null {
  if (before === null && after === null) return null;
  const varied = new Set(varies.map((key) => key.trim().toLowerCase()));
  const result = { differing: [] as ContextChange[], oneSided: [] as ContextChange[], varied: [] as ContextChange[], same: {} as Record<string, string> };
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const change: ContextChange = {
      key,
      before: before !== null && Object.hasOwn(before, key) ? before[key] : null,
      after: after !== null && Object.hasOwn(after, key) ? after[key] : null,
    };
    if (change.before !== null && change.after !== null && sameCondition(change.before, change.after)) result.same[key] = change.before;
    else if (varied.has(key.toLowerCase())) result.varied.push(change);
    else if (change.before === null || change.after === null) result.oneSided.push(change);
    else result.differing.push(change);
  }
  const state = result.differing.length > 0 ? "differs" : result.oneSided.length > 0 ? "partial" : "matched";
  return { state, ...result };
}

/** The conditions every context records with the same value; nothing when one of them records none. */
export function sharedContext(contexts: readonly (Context | null)[]): Context {
  const [first, ...rest] = contexts;
  if (first === undefined || first === null || rest.some((context) => context === null)) return {};
  const shared: Record<string, string> = {};
  for (const [key, value] of Object.entries(first)) {
    if (rest.every((context) => context !== null && Object.hasOwn(context, key) && sameCondition(context[key], value))) shared[key] = value;
  }
  return shared;
}

/** The sample standard deviation of two or more values; null for fewer. */
function sampleStddev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  return Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (values.length - 1));
}

interface Side {
  readonly value: number;
  readonly samples: readonly number[];
  readonly spread: number | null;
  readonly context: Context | null;
}

/** One side of a row: a number, a list of repeats (their mean), or `{value | mean, runs?, stddev?, context?}`. */
function readSide(value: Value | undefined): Side | null {
  const single = numeric(value);
  if (single !== null) return { value: single, samples: [], spread: null, context: null };
  const fields = objectFields(value);
  const repeats = fields === null ? value : (fields.runs ?? fields.times ?? fields.samples ?? fields.values);
  const samples = Array.isArray(repeats) ? repeats.flatMap((item) => numeric(item) ?? []) : [];
  const given = fields === null ? null : numeric(fields.value ?? fields.mean ?? fields.median);
  if (given === null && samples.length === 0) return null;
  return {
    value: given ?? samples.reduce((sum, n) => sum + n, 0) / samples.length,
    samples,
    spread: (fields === null ? null : numeric(fields.stddev ?? fields.sd)) ?? sampleStddev(samples),
    context: fields === null ? null : readContext(fields.context),
  };
}

/** A name or a list of names. */
function labels(value: Value | undefined): string[] {
  if (Array.isArray(value)) return value.map(label).filter((text) => text !== "");
  const one = label(value);
  return one === "" ? [] : one.split(/\s*,\s*/);
}

function readComparisons(items: readonly Value[], unit: string | null): CompareReport {
  const rows: Comparison[] = [];
  let ignored = 0;
  for (const item of items) {
    const fields = objectFields(item);
    if (fields === null) {
      ignored++;
      continue;
    }
    const name = label(fields.name ?? fields.label ?? fields.title ?? fields.metric);
    const beforeSide = readSide(fields.before ?? fields.baseline ?? fields.old);
    const afterSide = readSide(fields.after ?? fields.current ?? fields.new);
    if (name === "" || beforeSide === null || afterSide === null) {
      ignored++;
      continue;
    }
    const before = beforeSide.value;
    const after = afterSide.value;
    const better: Better = label(fields.better).toLowerCase() === "higher" ? "higher" : "lower";
    const rowUnit = label(fields.unit) || unit;
    const spreads = [fields.stddev, fields.sd, fields.noise, fields.beforeStddev, fields.afterStddev]
      .map(numeric)
      .concat(beforeSide.spread, afterSide.spread)
      .filter((n): n is number => n !== null && n >= 0);
    const noise = spreads.length === 0 ? null : Math.max(...spreads);
    // A row's `context` holds for both sides; `contextBefore`/`contextAfter` and a side's own `context` override it.
    const shared = readContext(fields.context ?? fields.conditions);
    const contextBefore = mergeContexts(shared, readContext(fields.contextBefore ?? fields.beforeContext), beforeSide.context);
    const contextAfter = mergeContexts(shared, readContext(fields.contextAfter ?? fields.afterContext), afterSide.context);
    const comparability = compareContexts(contextBefore, contextAfter, labels(fields.varies ?? fields.vary));
    rows.push({
      name,
      before,
      after,
      unit: rowUnit === "" ? null : rowUnit,
      better,
      delta: after - before,
      percent: before === 0 ? null : ((after - before) / Math.abs(before)) * 100,
      noise,
      verdict: verdictOf(before, after, better, noise),
      note: label(fields.note ?? fields.detail) || null,
      beforeSamples: beforeSide.samples,
      afterSamples: afterSide.samples,
      contextBefore,
      contextAfter,
      comparability,
      comparable: comparability?.state !== "differs",
    });
  }
  const judged = rows.filter((row) => row.comparable);
  const counts: Record<Verdict, number> = { better: 0, worse: 0, same: 0 };
  for (const row of judged) counts[row.verdict]++;
  let geomean: number | null = null;
  if (judged.length > 1 && judged.every((row) => row.before > 0 && row.after > 0)) {
    const logs = judged.map((row) => Math.log(row.better === "lower" ? row.after / row.before : row.before / row.after));
    geomean = Math.exp(logs.reduce((sum, n) => sum + n, 0) / logs.length);
  }
  const anyContext = rows.some((row) => row.comparability !== null);
  return {
    kind: "compare",
    rows,
    counts,
    incomparable: rows.length - judged.length,
    shared: anyContext ? sharedContext(rows.flatMap((row) => [row.contextBefore, row.contextAfter])) : {},
    words: verdictWords(rows),
    geomean,
    ignored,
  };
}

/** Ranks runs by mean and computes each one's ratio to the fastest, with hyperfine's error propagation. */
export function rankRuns(runs: readonly Omit<Run, "ratio" | "ratioStddev">[]): Run[] {
  const sorted = [...runs].sort((a, b) => a.mean - b.mean);
  const fastest = sorted[0];
  return sorted.map((run) => {
    if (fastest === undefined || !(fastest.mean > 0)) return { ...run, ratio: 1, ratioStddev: null };
    const ratio = run.mean / fastest.mean;
    const ratioStddev =
      run.error === null || fastest.error === null || !(run.mean > 0)
        ? null
        : ratio * Math.sqrt((run.error / run.mean) ** 2 + (fastest.error / fastest.mean) ** 2);
    return { ...run, ratio, ratioStddev };
  });
}

function numbers(value: Value | undefined): number[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === "number" && Number.isFinite(item) ? [item] : [])) : [];
}

/** min and max from the fields, else from the runs, else the mean. */
function extent(fields: Fields, mean: number, times: readonly number[]): { min: number; max: number } {
  const min = numeric(fields.min) ?? (times.length > 0 ? Math.min(...times) : mean);
  const max = numeric(fields.max) ?? (times.length > 0 ? Math.max(...times) : mean);
  return { min, max };
}

/** hyperfine --export-json: `{results: [{command, mean, stddev, median, user, system, min, max, times, exit_codes?, memory_usage_byte?}]}`, seconds. */
function readHyperfine(results: readonly Value[]): RunsReport {
  const runs: Omit<Run, "ratio" | "ratioStddev">[] = [];
  let ignored = 0;
  for (const item of results) {
    const fields = objectFields(item);
    const mean = numeric(fields?.mean);
    if (fields === null || mean === null) {
      ignored++;
      continue;
    }
    const times = numbers(fields.times);
    const parameters = Object.entries(objectFields(fields.parameters) ?? {}).map(([key, value]) => `${key}=${label(value)}`);
    const name = label(fields.command) || parameters.join(" ") || `Command ${runs.length + 1}`;
    const facts: Run["facts"][number][] = [];
    const user = numeric(fields.user);
    const system = numeric(fields.system);
    if (user !== null) facts.push({ label: "User", value: user, unit: "s" });
    if (system !== null) facts.push({ label: "System", value: system, unit: "s" });
    const memory = numbers(fields.memory_usage_byte);
    if (memory.length > 0) facts.push({ label: "Peak memory", value: Math.max(...memory), unit: "B" });
    facts.push({ label: "Runs", value: times.length > 0 ? times.length : 1, unit: null });
    const exits = numbers(fields.exit_codes);
    runs.push({
      name,
      mean,
      stddev: numeric(fields.stddev),
      error: numeric(fields.stddev),
      p99: null,
      median: numeric(fields.median),
      ...extent(fields, mean, times),
      times,
      facts,
      failed: exits.some((code) => code !== 0),
    });
  }
  return { kind: "runs", tool: "hyperfine", unit: "s", groups: [{ name: null, source: null, runs: rankRuns(runs) }], ignored };
}

/** vitest bench --outputJson: `{files: [{filepath, groups: [{fullName, benchmarks: [{name, mean, sd, min, max, hz, rme, sampleCount, samples}]}]}]}`, milliseconds. */
function readVitest(files: readonly Value[]): RunsReport {
  const groups: RunGroup[] = [];
  let ignored = 0;
  for (const file of files) {
    const fileFields = objectFields(file);
    if (fileFields === null || !Array.isArray(fileFields.groups)) continue;
    for (const group of fileFields.groups) {
      const groupFields = objectFields(group);
      if (groupFields === null || !Array.isArray(groupFields.benchmarks)) continue;
      const runs: Omit<Run, "ratio" | "ratioStddev">[] = [];
      for (const bench of groupFields.benchmarks) {
        const fields = objectFields(bench);
        const mean = numeric(fields?.mean);
        if (fields === null || mean === null) {
          ignored++;
          continue;
        }
        const times = numbers(fields.samples);
        const facts: Run["facts"][number][] = [];
        const hz = numeric(fields.hz);
        const rme = numeric(fields.rme);
        const samples = numeric(fields.sampleCount) ?? (times.length > 0 ? times.length : null);
        const p99 = numeric(fields.p99);
        if (hz !== null) facts.push({ label: "Throughput", value: hz, unit: "ops/s" });
        if (rme !== null) facts.push({ label: "± rme", value: rme, unit: "%" });
        if (p99 !== null) facts.push({ label: "p99", value: p99, unit: "ms" });
        if (samples !== null) facts.push({ label: "Samples", value: samples, unit: null });
        runs.push({
          name: label(fields.name) || `Benchmark ${runs.length + 1}`,
          mean,
          stddev: numeric(fields.sd),
          error: numeric(fields.sem),
          p99,
          median: numeric(fields.median),
          ...extent(fields, mean, times),
          times,
          facts,
          failed: false,
        });
      }
      if (runs.length === 0) continue;
      // "file.bench.ts > group > subgroup": the file goes quiet, the rest names the group.
      const parts = label(groupFields.fullName).split(" > ");
      const fileName = label(fileFields.filepath).split(/[/\\]/).pop() ?? "";
      const source = parts.length > 1 ? parts[0] : fileName || null;
      const name = parts.length > 1 ? parts.slice(1).join(" › ") : parts[0] || null;
      groups.push({ name, source, runs: rankRuns(runs) });
    }
  }
  return { kind: "runs", tool: "vitest", unit: "ms", groups, ignored };
}

/** A hand-written list of runs: `[{name, mean, stddev?, min?, max?, times?}]` in `unit` (default ms). */
function readRunList(items: readonly Value[], unit: string | null): RunsReport {
  const runs: Omit<Run, "ratio" | "ratioStddev">[] = [];
  let ignored = 0;
  for (const item of items) {
    const fields = objectFields(item);
    const mean = numeric(fields?.mean);
    if (fields === null || mean === null) {
      ignored++;
      continue;
    }
    const times = numbers(fields.times);
    runs.push({
      name: label(fields.name ?? fields.command) || `Run ${runs.length + 1}`,
      mean,
      stddev: numeric(fields.stddev ?? fields.sd),
      error: numeric(fields.stddev ?? fields.sd),
      p99: null,
      median: numeric(fields.median),
      ...extent(fields, mean, times),
      times,
      facts: times.length > 0 ? [{ label: "Runs", value: times.length, unit: null }] : [],
      failed: false,
    });
  }
  return { kind: "runs", tool: "list", unit: unit ?? "ms", groups: [{ name: null, source: null, runs: rankRuns(runs) }], ignored };
}

/** Status words and what they mean; anything else is kept as written ("thermal refused"). */
const RUN_STATUS: Record<string, RunStatus> = {
  ok: "ok",
  pass: "ok",
  passed: "ok",
  success: "ok",
  succeeded: "ok",
  done: "ok",
  complete: "ok",
  completed: "ok",
  measured: "ok",
  failed: "failed",
  fail: "failed",
  failure: "failed",
  error: "failed",
  errored: "failed",
  crash: "failed",
  crashed: "failed",
  aborted: "failed",
  killed: "failed",
  timeout: "timeout",
  "timed out": "timeout",
  timedout: "timeout",
};

/** A metric key with its unit written in: "p99 interval (ms)", "p99_ms", "footprint_gb". */
const KEY_UNIT = /^(.+?)\s*\(([^)]+)\)$|^(.+?)[_\s-](ms|s|us|µs|ns|kb|mb|gb|mib|gib|pct)$/i;
/** Metrics where more is better unless the input says otherwise; everything else (times, sizes, intervals) is lower-is-better. */
const HIGHER_IS_BETTER = /fps|frame.?rate|throughput|ops|[rq]ps|hz|score|accuracy|hit|speed/i;

/** A metric's label, unit and direction: from its spec (`{label, unit, better}`), else from its key, else the component's unit. */
function metricColumn(key: string, spec: Fields | null, unit: string | null): MetricColumn {
  const written = KEY_UNIT.exec(key);
  const base = written === null ? key : (written[1] ?? written[3]);
  const keyUnit = written === null ? (/fps/i.test(key) ? "fps" : null) : (written[2] ?? (written[4].toLowerCase() === "pct" ? "%" : written[4]));
  const metricUnit = label(spec?.unit) || keyUnit || unit || null;
  const direction = label(spec?.better).toLowerCase();
  const better: Better =
    direction === "higher" || direction === "lower" ? direction : HIGHER_IS_BETTER.test(base) || unitInfo(metricUnit).kind === "rate" ? "higher" : "lower";
  const name = label(spec?.label ?? spec?.title) || (/^fps$/i.test(base) ? "FPS" : base.replace(/_/g, " "));
  return { key, label: name, unit: metricUnit, better };
}

/** Conditions that differ between runs or that some runs leave out, in first-seen order. */
function varyingConditions(runs: readonly RunRecord[]): string[] {
  const shared = runs.length === 0 ? {} : sharedContext(runs.map((run) => run.context));
  return [...new Set(runs.flatMap((run) => Object.keys(run.context)))].filter((key) => !Object.hasOwn(shared, key));
}

/** Each metric's best value among the ok runs, where at least two measured it and they are not all equal. */
export function bestValues(runs: readonly RunRecord[], metrics: readonly MetricColumn[]): Record<string, number> {
  const best: Record<string, number> = {};
  for (const metric of metrics) {
    const measured = runs.flatMap((run) => (run.status === "ok" && Object.hasOwn(run.values, metric.key) ? [run.values[metric.key]] : []));
    if (measured.length < 2) continue;
    const low = Math.min(...measured);
    const high = Math.max(...measured);
    if (low !== high) best[metric.key] = metric.better === "lower" ? low : high;
  }
  return best;
}

/**
 * Every run of an experiment: `[{name | run, status?, metrics: {fps: 58, p99: 21.4} | {fps: {value, unit?, better?}}, context?, note?}]`,
 * with `spec` (the object form's `metrics`) naming labels, units and directions: `[{key, label?, unit?, better?}]` or `{key: {label?, unit?, better?} | unit}`.
 */
function readAllRuns(items: readonly Value[], spec: Value | undefined, groupBy: Value | undefined, unit: string | null): AllRunsReport {
  const specs: Record<string, Fields> = {};
  const order: string[] = [];
  if (Array.isArray(spec)) {
    for (const entry of spec) {
      const fields = objectFields(entry);
      const key = label(fields?.key ?? fields?.name ?? fields?.metric);
      if (fields === null || key === "" || Object.hasOwn(specs, key)) continue;
      specs[key] = fields;
      order.push(key);
    }
  } else {
    for (const [key, entry] of Object.entries(objectFields(spec) ?? {})) {
      specs[key] = objectFields(entry) ?? { unit: label(entry) };
      order.push(key);
    }
  }
  const runs: RunRecord[] = [];
  let ignored = 0;
  for (const item of items) {
    const fields = objectFields(item);
    if (fields === null) {
      ignored++;
      continue;
    }
    const values: Record<string, number> = {};
    for (const [key, raw] of Object.entries(objectFields(fields.metrics ?? fields.values) ?? {})) {
      const detail = objectFields(raw);
      const value = numeric(detail === null ? raw : detail.value);
      if (!order.includes(key)) order.push(key);
      // A metric's own {unit, better} stands in for a spec the input did not give.
      if (detail !== null && !Object.hasOwn(specs, key)) specs[key] = detail;
      if (value !== null) values[key] = value;
    }
    const written = label(fields.status ?? fields.outcome).toLowerCase().replace(/[_-]+/g, " ");
    const status: RunStatus = written === "" ? "ok" : (RUN_STATUS[written] ?? "other");
    runs.push({
      name: label(fields.name ?? fields.run ?? fields.label ?? fields.title ?? fields.id) || `Run ${runs.length + 1}`,
      status,
      statusLabel: status === "ok" || written === "" || written === status || written === "fail" ? null : written,
      values,
      context: readContext(fields.context ?? fields.conditions) ?? {},
      note: label(fields.note ?? fields.detail ?? fields.reason ?? fields.error) || null,
    });
  }
  const counts: Record<RunStatus, number> = { ok: 0, failed: 0, timeout: 0, other: 0 };
  for (const run of runs) counts[run.status]++;
  const varying = varyingConditions(runs);
  const wanted = label(groupBy).toLowerCase();
  return {
    kind: "all-runs",
    metrics: order.map((key) => metricColumn(key, specs[key] ?? null, unit)),
    runs,
    counts,
    shared: runs.length === 0 ? {} : sharedContext(runs.map((run) => run.context)),
    varying,
    groupBy: varying.find((key) => key.toLowerCase() === wanted) ?? null,
    ignored,
  };
}

/** The runs by their value of condition `key` (first-seen order, runs that do not record it last), or all together when `key` is null. */
export function groupRuns(report: AllRunsReport, key: string | null): Cohort[] {
  const cohort = (value: string | null, runs: readonly RunRecord[]): Cohort => ({
    key,
    value,
    runs,
    best: bestValues(runs, report.metrics),
    varying: varyingConditions(runs).filter((condition) => condition !== key),
  });
  if (key === null) return [cohort(null, report.runs)];
  const groups: { value: string; runs: RunRecord[] }[] = [];
  const unrecorded: RunRecord[] = [];
  for (const run of report.runs) {
    if (!Object.hasOwn(run.context, key)) {
      unrecorded.push(run);
      continue;
    }
    const value = run.context[key];
    const group = groups.find((candidate) => sameCondition(candidate.value, value));
    if (group === undefined) groups.push({ value, runs: [run] });
    else group.runs.push(run);
  }
  return [...groups.map((group) => cohort(group.value, group.runs)), ...(unrecorded.length === 0 ? [] : [cohort(null, unrecorded)])];
}

/** Reads any input Benchmark takes; `unit` is the component's unit param. */
export function readBenchmark(value: Value | undefined, unit: string | null): BenchmarkRead {
  if (value === undefined || value === null) return { ok: false, error: USAGE };
  const fields = objectFields(value);
  if (fields !== null) {
    if (Array.isArray(fields.runs)) return { ok: true, report: readAllRuns(fields.runs, fields.metrics, fields.groupBy ?? fields.group, unit) };
    if (Array.isArray(fields.results)) return { ok: true, report: readHyperfine(fields.results) };
    if (Array.isArray(fields.files)) {
      const report = readVitest(fields.files);
      return report.groups.length === 0 && report.ignored === 0 ? { ok: false, error: "This vitest bench report has no benchmarks" } : { ok: true, report };
    }
    return { ok: false, error: USAGE };
  }
  if (!Array.isArray(value)) return { ok: false, error: USAGE };
  if (value.some((item) => objectFields(objectFields(item)?.metrics) !== null)) return { ok: true, report: readAllRuns(value, undefined, undefined, unit) };
  const runList = value.some((item) => {
    const row = objectFields(item);
    return row !== null && numeric(row.mean) !== null && row.before === undefined;
  });
  return { ok: true, report: runList ? readRunList(value, unit) : readComparisons(value, unit) };
}

/** "1.84 ± 0.05" for a ratio, or "1.84" without its spread. */
export function formatRatio(ratio: number, spread: number | null): string {
  const digits = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
  return spread === null ? digits(ratio) : `${digits(ratio)} ± ${digits(spread)}`;
}

/** Conditions as one line: "thermal Nominal · display 120 Hz". */
export function formatConditions(context: Context): string {
  return Object.entries(context)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
}

/** What a run's status says: "failed", "timed out", or the input's own word ("crashed", "thermal refused"). */
export function runStatusWord(run: RunRecord): string {
  return run.statusLabel ?? (run.status === "timeout" ? "timed out" : run.status);
}

/** The runs that did not measure, counted per status word in first-seen order: [{word: "failed", count: 2}, {word: "thermal refused", count: 1}]. */
export function unmeasuredCounts(runs: readonly RunRecord[]): { readonly word: string; readonly status: RunStatus; readonly count: number }[] {
  const counts: { word: string; status: RunStatus; count: number }[] = [];
  for (const run of runs) {
    if (run.status === "ok") continue;
    const word = runStatusWord(run);
    const entry = counts.find((candidate) => candidate.word === word);
    if (entry === undefined) counts.push({ word, status: run.status, count: 1 });
    else entry.count++;
  }
  return counts;
}
