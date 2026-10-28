// Benchmark results as a reviewer reads them. Before/after rows: each
// metric's two values on a shared scale, the change and a verdict that calls
// noise noise, and the conditions each side ran under: a row whose
// conditions differ says "not comparable" instead of a verdict. Runs
// (hyperfine, vitest bench): commands ranked fastest first, "3.92 ± 0.44 ×
// slower", and each command's spread drawn as min–max whiskers, a mean ± σ
// band and every run as a dot. All runs of an experiment: a small chart per
// metric across the runs, then one row per run with its metrics, status and
// conditions, the best per metric marked and failed runs kept, grouped by a
// condition the reader picks.
import { useId, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  formatConditions,
  formatRatio,
  groupRuns,
  readBenchmark,
  runStatusWord,
  unmeasuredCounts,
  type AllRunsReport,
  type Cohort,
  type Comparability,
  type CompareReport,
  type Comparison,
  type Context,
  type MetricColumn,
  type Run,
  type RunGroup,
  type RunRecord,
  type RunsReport,
  type RunStatus,
  type Verdict,
} from "../../core/benchmark";
import { formatAmount, formatDelta, formatPercent, niceTicks, unitInfo } from "../../core/perf-units";
import { propsKey, usePersistedState } from "../usePersistedState";
import { ACCENT, optionalText, TONE_PILL, TONE_TEXT, type Props, type Tone } from "../values";
import { useWidth } from "./chartKit";
import { ErrorLine } from "./display";
import { FIELD, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, RISE, useEntrance, type Entrance } from "./motion";
import { Frame, gridLines, Heading, Quiet, TEXT_BUTTON } from "./perfKit";

/** Rows shown before "Show N more". */
const ROW_PAGE = 30;
/** Run dots drawn per command; past this, an even sample of them. */
const MAX_DOTS = 300;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };
const GROW_Y: Entrance = { keyframes: [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], duration: CHART_DRAW_MS };

const VERDICT_TONE: Record<Verdict, Tone> = { better: "good", worse: "bad", same: "neutral" };
const VERDICT_FILL: Record<Verdict, string> = {
  better: "bg-success",
  worse: "bg-destructive",
  same: "bg-muted-foreground/60",
};
/** An after measured under other conditions: hatched in the caution tone, neither better nor worse. */
const INCOMPARABLE_FILL: CSSProperties = {
  background: "repeating-linear-gradient(135deg, var(--warning) 0 3px, color-mix(in oklch, var(--warning) 25%, transparent) 3px 6px)",
};
const STATUS_TONE: Record<RunStatus, Tone> = { ok: "neutral", failed: "bad", timeout: "warn", other: "neutral" };

export function Benchmark({ props }: { props: Props }) {
  const unit = optionalText(props.unit);
  const read = useMemo(() => readBenchmark(props.results, unit), [props.results, unit]);
  const persistId = useMemo(() => propsKey(props.results), [props.results]);
  if (!read.ok) return <ErrorLine message={read.error} />;
  const report = read.report;
  return (
    <Frame label="Benchmark">
      {report.kind === "compare" ? (
        <Comparisons report={report} />
      ) : report.kind === "all-runs" ? (
        <AllRuns report={report} persistId={persistId} />
      ) : (
        <Runs report={report} />
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Before/after

function Comparisons({ report }: { report: CompareReport }) {
  const [shown, setShown] = useState(ROW_PAGE);
  // One scale per unit kind, so bars of the same measure compare across rows.
  const scales = useMemo(() => {
    const max = new Map<string, number>();
    for (const row of report.rows) {
      const key = unitInfo(row.unit).kind + (row.unit ?? "");
      max.set(key, Math.max(max.get(key) ?? 0, Math.abs(row.before), Math.abs(row.after)));
    }
    return max;
  }, [report.rows]);
  if (report.rows.length === 0) return <Quiet>No results to compare{report.ignored > 0 ? ` (${report.ignored} without a name, before and after)` : ""}.</Quiet>;
  const { better, worse, same } = report.counts;
  const parts = [
    better > 0 ? <span key="b" className="text-success">{`${better} ${report.words.better}`}</span> : null,
    worse > 0 ? <span key="w" className="text-destructive">{`${worse} ${report.words.worse}`}</span> : null,
    same > 0 ? <span key="s" className="text-muted-foreground">{`${same} within noise`}</span> : null,
    report.incomparable > 0 ? <span key="i" className="text-warning-text">{`${report.incomparable} not comparable`}</span> : null,
  ].filter((part) => part !== null);
  const overall =
    report.geomean === null || Math.abs(1 - report.geomean) < 0.0005
      ? null
      : `${Math.abs((1 - report.geomean) * 100).toFixed(1)}% ${report.geomean < 1 ? report.words.better : report.words.worse} overall (geometric mean)`;
  const shared = formatConditions(report.shared);
  const rest = report.rows.length - shown;
  return (
    <>
      <Heading
        title={parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`sep${index}`} className="text-muted-foreground"> · </span>, part]))}
        meta={[
          overall,
          "a change under 1% or within the spread counts as noise",
          report.incomparable > 0 ? "a row whose two sides ran under different conditions is not judged" : null,
          report.ignored > 0 ? `${report.ignored} unreadable rows left out` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      />
      {shared === "" ? null : <p className="m-0 text-xs leading-5 text-muted-foreground">Same conditions for every row: {shared}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs leading-5 text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-muted-foreground/30" />
          Before
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="flex gap-[2px]">
            <span className="h-1.5 w-2 rounded-l-full bg-success" />
            <span className="h-1.5 w-2 bg-destructive" />
            <span className="h-1.5 w-2 rounded-r-full" style={{ background: ACCENT }} />
          </span>
          After: {report.words.better}, {report.words.worse}, within noise
        </span>
        {report.incomparable > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-3 rounded-full" style={INCOMPARABLE_FILL} />
            Not comparable
          </span>
        ) : null}
      </div>
      <ul className="m-0 flex min-w-0 list-none flex-col p-0">
        {report.rows.slice(0, shown).map((row, index) => (
          <ComparisonRow key={index} row={row} max={scales.get(unitInfo(row.unit).kind + (row.unit ?? "")) ?? 0} words={report.words} shared={report.shared} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + ROW_PAGE)} className={TEXT_BUTTON}>
          Show {Math.min(rest, ROW_PAGE)} more of {rest}
        </button>
      ) : null}
    </>
  );
}

function ComparisonRow({ row, max, words, shared }: { row: Comparison; max: number; words: CompareReport["words"]; shared: Context }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const tone: Tone = row.comparable ? VERDICT_TONE[row.verdict] : "warn";
  const verdictWord = !row.comparable ? "not comparable" : row.verdict === "same" ? "within noise" : row.verdict === "better" ? words.better : words.worse;
  const width = (value: number) => (max > 0 ? `${(Math.abs(value) / max) * 100}%` : "0%");
  const change = row.percent === null ? formatDelta(row.delta, row.unit) : formatPercent(row.percent);
  const differing = row.comparability?.differing.map((item) => item.key) ?? [];
  const repeats = [row.beforeSamples.length, row.afterSamples.length];
  const repeatNote =
    repeats[0] < 2 && repeats[1] < 2 ? null : repeats[0] === repeats[1] ? `mean of ${repeats[0]} runs each` : `means of ${repeats[0] || 1} and ${repeats[1] || 1} runs`;
  const summary = `${row.name}: ${formatAmount(row.before, row.unit)} before, ${formatAmount(row.after, row.unit)} after, ${change}, ${verdictWord}${row.comparable ? "" : ` (${differing.join(", ")} differ)`}${row.better === "higher" ? " (higher is better)" : ""}`;
  return (
    <li
      ref={rise}
      aria-label={summary}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border/60 py-2 last:border-b-0 @lg:grid-cols-[minmax(0,32%)_minmax(0,1fr)_auto_5.5rem]"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] leading-5 text-foreground" title={row.name}>
          {row.name}
        </span>
        {row.note === null ? null : <span className="truncate text-[11px] leading-4 text-muted-foreground">{row.note}</span>}
        {row.comparability === null ? null : <Conditions comparability={row.comparability} shared={shared} />}
      </div>
      <div aria-hidden className="col-span-2 row-start-2 flex min-w-0 flex-col gap-[3px] @lg:col-span-1 @lg:col-start-2 @lg:row-start-1">
        <Bar width={width(row.before)} className="bg-muted-foreground/30" />
        <Bar
          width={width(row.after)}
          className={!row.comparable || row.verdict === "same" ? "" : VERDICT_FILL[row.verdict]}
          style={!row.comparable ? INCOMPARABLE_FILL : row.verdict === "same" ? { background: ACCENT } : undefined}
        />
      </div>
      <span
        aria-hidden
        className="col-span-2 row-start-3 text-xs leading-5 tabular-nums text-muted-foreground @lg:col-span-1 @lg:col-start-3 @lg:row-start-1 @lg:text-right"
      >
        {formatAmount(row.before, row.unit)} → <span className="font-medium text-foreground">{formatAmount(row.after, row.unit)}</span>
        {row.better === "higher" ? <span className="ml-1 text-[10.5px]">(higher is better)</span> : null}
        {repeatNote === null ? null : <span className="block text-[10.5px] leading-4">{repeatNote}</span>}
      </span>
      <span aria-hidden className="col-start-2 row-start-1 flex flex-col items-end @lg:col-start-4">
        <span className={cn("whitespace-nowrap rounded-full px-1.5 text-[11px] font-medium leading-[18px] tabular-nums", TONE_PILL[tone])} title={verdictWord}>
          {row.comparable ? change : "not comparable"}
        </span>
        <span className={cn("whitespace-nowrap text-[10.5px] leading-4 tabular-nums", row.comparable ? TONE_TEXT[tone] || "text-muted-foreground" : "text-muted-foreground")}>
          {!row.comparable ? `measured ${change}` : row.percent === null ? verdictWord : formatDelta(row.delta, row.unit)}
        </span>
      </span>
    </li>
  );
}

/**
 * A row's conditions, quiet: what differs between its sides in the caution
 * tone, what it varies on purpose, what one side leaves out, then what both
 * share beyond the conditions every row shares.
 */
function Conditions({ comparability, shared }: { comparability: Comparability; shared: Context }) {
  const same = Object.entries(comparability.same).filter(([key]) => !Object.hasOwn(shared, key));
  const items = [
    ...comparability.differing.map((item) => (
      <span key={`d${item.key}`} className="text-warning-text">
        {item.key} differs: {item.before} before, {item.after} after
      </span>
    )),
    ...comparability.varied.map((item) => (
      <span key={`v${item.key}`} className="text-foreground/80">
        {item.key} {item.before ?? "not recorded"} → {item.after ?? "not recorded"}
      </span>
    )),
    ...comparability.oneSided.map((item) => (
      <span key={`o${item.key}`} className="italic">
        {item.key} {item.before ?? item.after}, {item.before === null ? "after" : "before"} only
      </span>
    )),
    ...same.map(([key, value]) => (
      <span key={`s${key}`}>
        {key} {value}
      </span>
    )),
  ];
  if (items.length === 0) return null;
  return (
    <span className="text-[11px] leading-4 text-muted-foreground">
      {items.flatMap((item, index) => (index === 0 ? [item] : [<span key={`sep${index}`}> · </span>, item]))}
    </span>
  );
}

function Bar({ width, className, style }: { width: string; className: string; style?: CSSProperties }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full">
      <div ref={grow} className={cn("h-full min-w-[2px] origin-left rounded-full", className)} style={{ width, ...style }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranked runs

function Runs({ report }: { report: RunsReport }) {
  const groups = report.groups.filter((group) => group.runs.length > 0);
  if (groups.length === 0) return <Quiet>No benchmark results{report.ignored > 0 ? ` (${report.ignored} without a mean)` : ""}.</Quiet>;
  const tool = report.tool === "hyperfine" ? "hyperfine" : report.tool === "vitest" ? "vitest bench" : null;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {groups.map((group, index) => (
        <RunGroupView key={index} group={group} unit={report.unit} tool={index === 0 ? tool : null} />
      ))}
    </div>
  );
}

function RunGroupView({ group, unit, tool }: { group: RunGroup; unit: string; tool: string | null }) {
  const [shown, setShown] = useState(ROW_PAGE);
  const fastest = group.runs[0];
  const slower = group.runs.slice(1);
  const ticks = useMemo(() => {
    const low = Math.min(...group.runs.map((run) => run.min));
    // Past a p99 (vitest), one stray sample would squash every mean into the first pixels: the axis stops there.
    const high = Math.max(...group.runs.map((run) => Math.max(run.mean, run.p99 ?? run.max)));
    // A tight cluster far from zero reads better zoomed; the axis says where it starts.
    return niceTicks(low > 0 && low / high > 0.5 ? low : 0, high);
  }, [group.runs]);
  // hyperfine's summary: "1.84 ± 0.05 × faster than …" for each, up to three; then the next and the slowest.
  const faster = (run: Run) => `${formatRatio(run.ratio, run.ratioStddev)} × faster than ${run.name}`;
  const lead =
    slower.length === 0
      ? null
      : slower.length <= 3
        ? slower.map(faster).join(" · ")
        : `${faster(slower[0])} · ${faster(slower[slower.length - 1])}`;
  const rest = group.runs.length - shown;
  return (
    <section aria-label={group.name ?? "Results"} className="flex min-w-0 flex-col gap-2">
      <Heading
        title={
          <>
            {group.name === null ? null : <span className="mr-2">{group.name}</span>}
            <span className={group.name === null ? "" : "font-normal text-muted-foreground"}>
              {group.name === null ? <code className="font-mono text-[14px]">{fastest.name}</code> : <code className="font-mono text-[13px]">{fastest.name}</code>}
              {group.runs.length > 1 ? " is fastest" : null}
            </span>
          </>
        }
        meta={[lead, [group.source, tool].filter((part) => part !== null).join(" · ") || null].filter((part) => part !== null).join(" · ")}
      />
      <ol className="m-0 flex min-w-0 list-none flex-col p-0">
        {group.runs.slice(0, shown).map((run, index) => (
          <RunRow key={index} run={run} rank={index + 1} unit={unit} ticks={ticks} fastest={fastest} />
        ))}
      </ol>
      <Axis ticks={ticks} unit={unit} />
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + ROW_PAGE)} className={TEXT_BUTTON}>
          Show {Math.min(rest, ROW_PAGE)} more of {rest}
        </button>
      ) : null}
    </section>
  );
}

/** The run row's columns: rank, name, plot, mean. The axis under them repeats the grid. */
const RUN_GRID = "grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 @lg:grid-cols-[1.25rem_minmax(0,30%)_minmax(0,1fr)_7.5rem]";

function RunRow({ run, rank, unit, ticks, fastest }: { run: Run; rank: number; unit: string; ticks: readonly number[]; fastest: Run }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const id = useId();
  const [open, setOpen] = useState(false);
  const first = rank === 1;
  const relative = first ? "fastest" : `${formatRatio(run.ratio, run.ratioStddev)} × slower`;
  const spread = run.stddev === null ? null : formatAmount(run.stddev, unit, 2, run.mean);
  const mean = `${formatAmount(run.mean, unit)}${spread === null ? "" : ` ± ${spread}`}`;
  const facts = [
    ...(run.median === null ? [] : [{ label: "Median", value: formatAmount(run.median, unit) }]),
    { label: "Min", value: formatAmount(run.min, unit) },
    { label: "Max", value: formatAmount(run.max, unit) },
    ...run.facts.map((fact) => ({ label: fact.label, value: fact.unit === "%" ? `±${fact.value.toFixed(2)}%` : formatAmount(fact.value, fact.unit) })),
  ];
  return (
    <li ref={rise} className="min-w-0 border-b border-border/60 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-facts`}
        aria-label={`${rank}. ${run.name}: ${mean}, ${relative}${first ? "" : ` than ${fastest.name}`}${run.failed ? ", exited with an error" : ""}`}
        onClick={() => setOpen((value) => !value)}
        className={cn(RUN_GRID, "w-full cursor-pointer items-center gap-y-1 rounded-md py-2 text-left hover:bg-state-hover", FOCUS_RING)}
      >
        <span aria-hidden className={cn("text-xs font-medium tabular-nums", first ? "text-success" : "text-muted-foreground")}>
          {rank}
        </span>
        <span aria-hidden className="flex min-w-0 flex-col">
          <code className="truncate font-mono text-[12.5px] leading-5 text-foreground" title={run.name}>
            {run.name}
          </code>
          <span className={cn("text-[11px] leading-4 tabular-nums", first ? "text-success" : "text-muted-foreground")}>
            {relative}
            {run.failed ? <span className="ml-1.5 text-destructive">exited non-zero</span> : null}
          </span>
        </span>
        <span aria-hidden className="col-span-3 col-start-1 row-start-2 min-w-0 @lg:col-span-1 @lg:col-start-3 @lg:row-start-1">
          <RunPlot run={run} ticks={ticks} highlight={first} />
        </span>
        <span aria-hidden className="col-start-3 row-start-1 text-right text-xs leading-5 tabular-nums @lg:col-start-4">
          <span className="font-medium text-foreground">{formatAmount(run.mean, unit)}</span>
          {spread === null ? null : <span className="text-muted-foreground"> ± {spread}</span>}
        </span>
      </button>
      <dl
        id={`${id}-facts`}
        hidden={!open}
        className={cn("m-0 grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-x-4 gap-y-1 pb-2.5 pl-8 text-xs leading-5", open ? "grid" : "hidden")}
      >
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 items-baseline gap-1.5">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="m-0 font-medium tabular-nums text-foreground">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/** Deterministic jitter in [-1, 1] per run, so dots at the same time spread without moving between renders. */
function jitter(index: number): number {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const PLOT_HEIGHT = 22;

/** min–max whiskers, a mean ± σ band, the mean as a bold tick, and each run as a dot. */
function RunPlot({ run, ticks, highlight }: { run: Run; ticks: readonly number[]; highlight: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const grow = useEntrance<SVGGElement>(GROW_X);
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  const x = (value: number) => (high > low ? Math.min(width, Math.max(0, ((value - low) / (high - low)) * width)) : 0);
  const clipped = run.max > high;
  const dots = useMemo(() => {
    if (run.times.length <= MAX_DOTS) return run.times;
    const step = run.times.length / MAX_DOTS;
    return Array.from({ length: MAX_DOTS }, (_, index) => run.times[Math.floor(index * step)]);
  }, [run.times]);
  const mid = PLOT_HEIGHT / 2;
  const color = highlight ? "var(--success)" : ACCENT;
  return (
    <div ref={ref} className="h-[22px] w-full" style={{ backgroundImage: gridLines(ticks[1] - ticks[0], high - low) }}>
      {width > 0 ? (
        <svg width={width} height={PLOT_HEIGHT} className="block overflow-visible">
          <g ref={grow} style={{ transformBox: "view-box", transformOrigin: `${x(run.min)}px 0` }}>
            <line x1={x(run.min)} x2={x(run.max)} y1={mid} y2={mid} stroke="var(--muted-foreground)" strokeOpacity={0.55} strokeWidth={1} />
            <line x1={x(run.min)} x2={x(run.min)} y1={mid - 4} y2={mid + 4} stroke="var(--muted-foreground)" strokeOpacity={0.55} />
            {clipped ? (
              // The slowest run lies past the axis: an arrow at the edge says so (its value is in the details).
              <path d={`M${width - 5} ${mid - 3.5} L${width} ${mid} L${width - 5} ${mid + 3.5}`} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.7} strokeWidth={1.25} />
            ) : (
              <line x1={x(run.max)} x2={x(run.max)} y1={mid - 4} y2={mid + 4} stroke="var(--muted-foreground)" strokeOpacity={0.55} />
            )}
            {run.stddev === null ? null : (
              <rect
                x={x(Math.max(low, run.mean - run.stddev))}
                width={Math.max(1, x(run.mean + run.stddev) - x(Math.max(low, run.mean - run.stddev)))}
                y={mid - 5}
                height={10}
                rx={2}
                fill={color}
                fillOpacity={0.18}
              />
            )}
            {dots.map((time, index) => (
              <circle key={index} cx={x(time)} cy={mid + jitter(index) * 4.5} r={1.6} fill={color} fillOpacity={0.45} />
            ))}
            <line x1={x(run.mean)} x2={x(run.mean)} y1={mid - 7} y2={mid + 7} stroke={color} strokeWidth={2} strokeLinecap="round" />
          </g>
        </svg>
      ) : null}
    </div>
  );
}

/** Tick labels under the plots, in the plot column. */
function Axis({ ticks, unit }: { ticks: readonly number[]; unit: string }) {
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  return (
    <div aria-hidden className={cn(RUN_GRID, "-mt-1")}>
      <span className="col-span-3 col-start-1 @lg:col-span-1 @lg:col-start-3">
        <span className="relative block h-4">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className="absolute top-0 whitespace-nowrap text-[10.5px] leading-4 tabular-nums text-muted-foreground"
              style={{
                left: `${((tick - low) / (high - low)) * 100}%`,
                transform: index === 0 ? undefined : index === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {formatAmount(tick, unit, 3, ticks[1] - ticks[0])}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// All runs

/** Past this many metrics, a run's values wrap under its name at every width instead of lining up as table columns. */
const MAX_TABLE_METRICS = 5;
/** The metric columns of the wide table; `--metrics` is their count. */
const WIDE_ROW = "@xl:grid-cols-[minmax(0,1fr)_repeat(var(--metrics),6.25rem)]";
const MINI_HEIGHT = 48;
/** The space between two groups in a metric chart, in run widths. */
const GROUP_GAP = 0.8;

function AllRuns({ report, persistId }: { report: AllRunsReport; persistId: string }) {
  const [chosen, setChosen] = usePersistedState<string>(`${persistId}:benchmark-group`, report.groupBy ?? "", (stored) => (typeof stored === "string" ? stored : null));
  // A stored grouping the data no longer varies in (a new run list) falls back to none.
  const groupBy = report.varying.includes(chosen) ? chosen : null;
  const cohorts = useMemo(() => groupRuns(report, groupBy), [report, groupBy]);
  const charted = useMemo(
    () => report.metrics.filter((metric) => report.runs.filter((run) => run.status === "ok" && Object.hasOwn(run.values, metric.key)).length >= 2),
    [report],
  );
  const [shown, setShown] = useState(ROW_PAGE);
  if (report.runs.length === 0) return <Quiet>No runs{report.ignored > 0 ? ` (${report.ignored} unreadable items left out)` : ""}.</Quiet>;
  const total = report.runs.length;
  const unmeasured = unmeasuredCounts(report.runs);
  const shared = formatConditions(report.shared);
  const unlike = cohorts.some((cohort) => cohort.varying.length > 0 && Object.keys(cohort.best).length > 0);
  const table = report.metrics.length > 0 && report.metrics.length <= MAX_TABLE_METRICS;
  let budget = shown;
  const visible = cohorts.flatMap((cohort) => {
    const runs = cohort.runs.slice(0, Math.max(0, budget));
    budget -= runs.length;
    return runs.length === 0 ? [] : [{ cohort, runs }];
  });
  const rest = total - shown;
  return (
    <>
      <Heading
        title={
          <>
            {`${total} ${total === 1 ? "run" : "runs"}`}
            {unmeasured.length === 0 ? null : <span className="font-normal text-muted-foreground">{` · ${report.counts.ok} measured`}</span>}
            {unmeasured.map((entry) => (
              <span key={entry.word} className={cn("font-normal", TONE_TEXT[STATUS_TONE[entry.status]] || "text-muted-foreground")}>
                {` · ${entry.count} ${entry.word}`}
              </span>
            ))}
          </>
        }
        meta={[
          report.varying.length === 0 ? "Same conditions for every run" : `Conditions differ in ${report.varying.join(", ")}`,
          report.metrics.length === 0
            ? null
            : `★ best measured value${groupBy === null ? "" : ` per ${groupBy}`}${unlike ? ", among runs whose conditions differ" : ""}`,
          report.ignored > 0 ? `${report.ignored} unreadable items left out` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        aside={report.varying.length === 0 ? undefined : <GroupBy value={groupBy} options={report.varying} onChange={setChosen} />}
      />
      {shared === "" ? null : <p className="m-0 text-xs leading-5 text-muted-foreground">Every run: {shared}</p>}
      {charted.length === 0 ? null : (
        <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 @3xl:grid-cols-4">
          {charted.map((metric) => (
            <MetricChart key={metric.key} metric={metric} cohorts={cohorts} />
          ))}
        </div>
      )}
      <div role="table" aria-label="Runs" className="flex min-w-0 flex-col" style={{ "--metrics": report.metrics.length } as CSSProperties}>
        {table ? (
          <div role="row" className={cn("hidden gap-x-3 border-b border-border pb-1 text-[10.5px] leading-4 text-muted-foreground @xl:grid", WIDE_ROW)}>
            <span role="columnheader" className="self-end text-[11px]">
              Run
            </span>
            {report.metrics.map((metric) => (
              <span key={metric.key} role="columnheader" className="min-w-0 text-right">
                <span className="block truncate text-[11px] font-medium text-foreground/80" title={metric.label}>
                  {metric.label}
                </span>
                {metric.better} is better
              </span>
            ))}
          </div>
        ) : null}
        {visible.map(({ cohort, runs }, index) => (
          <div key={cohort.value ?? `none${index}`} role="rowgroup" className="flex min-w-0 flex-col">
            {cohort.key === null ? null : (
              <div role="row" className={cn("border-b border-border/60 pb-1", index === 0 ? "pt-1" : "pt-3")}>
                <span role="rowheader" className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-5">
                  <span className="font-medium text-foreground">{cohort.value === null ? `${cohort.key} not recorded` : `${cohort.key}: ${cohort.value}`}</span>
                  <span className="text-muted-foreground">
                    {cohort.runs.length} {cohort.runs.length === 1 ? "run" : "runs"}
                    {cohort.varying.length > 0 ? ` · ${cohort.varying.join(", ")} still differ` : ""}
                  </span>
                </span>
              </div>
            )}
            {runs.map((run, position) => (
              <RunRecordRow key={position} run={run} metrics={report.metrics} best={cohort.best} conditions={cohort.varying} table={table} />
            ))}
          </div>
        ))}
      </div>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + ROW_PAGE)} className={TEXT_BUTTON}>
          Show {Math.min(rest, ROW_PAGE)} more of {rest}
        </button>
      ) : null}
    </>
  );
}

/** The condition to group runs by, or none. */
function GroupBy({ value, options, onChange }: { value: string | null; options: readonly string[]; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <label htmlFor={id} className="text-xs leading-5 text-muted-foreground">
        Group by
      </label>
      <span className="relative">
        <select
          id={id}
          value={value ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={cn(FIELD, "h-7 w-auto max-w-[11rem] cursor-pointer appearance-none truncate pl-2 pr-7 text-xs")}
        >
          <option value="">None</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <Icon name="ChevronDown" aria-hidden className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </span>
    </div>
  );
}

function RunRecordRow({
  run,
  metrics,
  best,
  conditions,
  table,
}: {
  run: RunRecord;
  metrics: readonly MetricColumn[];
  best: Readonly<Record<string, number>>;
  conditions: readonly string[];
  table: boolean;
}) {
  const rise = useEntrance<HTMLDivElement>(RISE);
  const measured = run.status === "ok";
  const tone = STATUS_TONE[run.status];
  const recorded = conditions.filter((key) => Object.hasOwn(run.context, key));
  return (
    <div ref={rise} role="row" className={cn("grid min-w-0 grid-cols-1 gap-x-3 gap-y-1.5 border-b border-border/60 py-2 last:border-b-0", table && WIDE_ROW)}>
      <div role="rowheader" className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] leading-5 text-foreground" title={run.name}>
            {run.name}
          </span>
          {measured ? null : (
            <span className={cn("shrink-0 rounded-full px-1.5 text-[11px] font-medium leading-[18px]", TONE_PILL[tone])}>{runStatusWord(run)}</span>
          )}
        </span>
        {recorded.length === 0 ? null : (
          <span className="text-[11px] leading-4 text-muted-foreground">
            {recorded.map((key, index) => (
              <span key={key}>
                {index === 0 ? "" : " · "}
                <span className="text-muted-foreground/75">{key}</span> {run.context[key]}
              </span>
            ))}
          </span>
        )}
        {run.note === null ? null : (
          <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground" title={run.note}>
            {run.note}
          </span>
        )}
      </div>
      {metrics.length === 0 ? null : !measured ? (
        <>
          {/* A run without measurements says so once when its values wrap; the wide table repeats it in each column. */}
          <span role="cell" className={cn("text-xs leading-5", TONE_TEXT[tone] || "text-muted-foreground", table && "@xl:hidden")}>
            No measurements: {runStatusWord(run)}
          </span>
          {table
            ? metrics.map((metric) => (
                <span key={metric.key} role="cell" className={cn("hidden items-center justify-end text-xs leading-5 @xl:flex", TONE_TEXT[tone] || "text-muted-foreground")}>
                  {runStatusWord(run)}
                </span>
              ))
            : null}
        </>
      ) : (
        // Narrow: the values wrap under the name, each at least as wide as its number; wide: the cells join the row's table grid.
        <div className={cn("flex min-w-0 flex-wrap gap-x-2 gap-y-1", table && "@xl:contents")}>
          {metrics.map((metric) => {
            const has = Object.hasOwn(run.values, metric.key);
            const value = run.values[metric.key];
            const isBest = has && best[metric.key] === value;
            return (
              <div key={metric.key} role="cell" className={cn("flex shrink-0 grow basis-[4.5rem] flex-col", table && "@xl:min-w-0 @xl:items-end @xl:justify-center")}>
                {/* w-0 min-w-full: the label truncates to the cell instead of setting its width; the number does. Narrow, the best's ★ leads the label so the number keeps its width. */}
                <span className={cn("w-0 min-w-full truncate text-[10.5px] leading-4 text-muted-foreground", table && "@xl:hidden")} title={metric.label}>
                  {isBest ? (
                    <span aria-hidden className="text-success">
                      ★{" "}
                    </span>
                  ) : null}
                  {metric.label}
                </span>
                {!has ? (
                  <span className="text-xs leading-5 text-muted-foreground" title="Not measured">
                    —<span className="sr-only">not measured</span>
                  </span>
                ) : (
                  <span className={cn("whitespace-nowrap text-xs leading-5 tabular-nums", isBest ? "font-semibold text-success" : "text-foreground")}>
                    {isBest && table ? (
                      <span aria-hidden className="hidden @xl:inline">
                        ★{" "}
                      </span>
                    ) : null}
                    {formatAmount(value, metric.unit, 4)}
                    {isBest ? <span className="sr-only"> (best)</span> : null}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One metric across the runs in table order: a bar per measured run (the best in the good tone), × for a run that did not measure, a gap between groups. */
function MetricChart({ metric, cohorts }: { metric: MetricColumn; cohorts: readonly Cohort[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const grow = useEntrance<SVGGElement>(GROW_Y);
  const slots = cohorts.flatMap((cohort, group) => cohort.runs.map((run, index) => ({ run, cohort, gapBefore: group > 0 && index === 0 })));
  const measured = slots.flatMap(({ run }) => (run.status === "ok" && Object.hasOwn(run.values, metric.key) ? [run.values[metric.key]] : []));
  const low = Math.min(...measured);
  const high = Math.max(...measured);
  const ticks = niceTicks(0, high, 4);
  const top = ticks[ticks.length - 1];
  const step = width / (slots.length + (cohorts.length - 1) * GROUP_GAP);
  const barWidth = Math.max(1.5, Math.min(step * 0.7, 16));
  const only = cohorts.length === 1 ? cohorts[0] : null;
  const bestValue = only !== null && Object.hasOwn(only.best, metric.key) ? only.best[metric.key] : null;
  const bestRuns = bestValue === null ? [] : slots.filter(({ run }) => run.status === "ok" && run.values[metric.key] === bestValue).map(({ run }) => run.name);
  const caption =
    bestValue !== null
      ? `best ${formatAmount(bestValue, metric.unit, 4)} · ${bestRuns.join(", ")}`
      : only !== null
        ? "every measured run equal"
        : `best per ${cohorts[0]?.key ?? "group"} in green`;
  let x = 0;
  const bars = slots.map(({ run, cohort, gapBefore }, index) => {
    if (gapBefore) x += step * GROUP_GAP;
    const center = x + step / 2;
    x += step;
    const value = run.status === "ok" && Object.hasOwn(run.values, metric.key) ? run.values[metric.key] : null;
    const label = `${run.name}: ${value === null ? (run.status === "ok" ? "not measured" : runStatusWord(run)) : formatAmount(value, metric.unit, 4)}`;
    if (value === null) {
      if (run.status === "ok") return null;
      const color = run.status === "failed" ? "var(--destructive)" : run.status === "timeout" ? "var(--warning)" : "var(--muted-foreground)";
      return (
        <g key={index} stroke={color} strokeWidth={1.25} strokeLinecap="round">
          <title>{label}</title>
          <line x1={center - 2.5} x2={center + 2.5} y1={MINI_HEIGHT - 7} y2={MINI_HEIGHT - 2} />
          <line x1={center - 2.5} x2={center + 2.5} y1={MINI_HEIGHT - 2} y2={MINI_HEIGHT - 7} />
        </g>
      );
    }
    const height = top > 0 ? Math.max(1, (value / top) * (MINI_HEIGHT - 2)) : 1;
    const isBest = cohort.best[metric.key] === value;
    return (
      <rect
        key={index}
        x={center - barWidth / 2}
        width={barWidth}
        y={MINI_HEIGHT - height}
        height={height}
        rx={Math.min(2, barWidth / 3)}
        fill={isBest ? "var(--success)" : ACCENT}
        fillOpacity={isBest ? 1 : 0.55}
      >
        <title>{label}</title>
      </rect>
    );
  });
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <figcaption className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium leading-5 text-foreground" title={metric.label}>
          {metric.label}
        </span>
        {/* Two lines tall whatever it says, so charts side by side line up. */}
        <span className="line-clamp-2 h-8 text-[11px] leading-4 text-muted-foreground" title={caption}>
          {metric.better} is better · {caption}
        </span>
      </figcaption>
      <div
        ref={ref}
        role="img"
        aria-label={`${metric.label} across ${slots.length} runs: ${formatAmount(low, metric.unit, 4)} to ${formatAmount(high, metric.unit, 4)}, ${caption}`}
        className="relative w-full border-b border-border"
        style={{ height: MINI_HEIGHT }}
      >
        <span aria-hidden className="absolute right-0 top-0 -translate-y-1/2 bg-background pl-1 text-[10px] leading-3 tabular-nums text-muted-foreground">
          {formatAmount(top, metric.unit)}
        </span>
        {width > 0 ? (
          <svg width={width} height={MINI_HEIGHT} className="block overflow-visible" aria-hidden>
            <line x1={0} x2={width} y1={0.5} y2={0.5} stroke="var(--border)" strokeDasharray="2 3" />
            <g ref={grow} style={{ transformBox: "view-box", transformOrigin: `0px ${MINI_HEIGHT}px` }}>
              {bars}
            </g>
          </svg>
        ) : null}
      </div>
    </figure>
  );
}
