// A coverage report as Codecov reads it: the total large in its tone, the
// other metrics beside it, then the files as a directory tree or as a list
// with the most uncovered lines first, each with a bar. A file whose report
// names its uncovered lines opens to them as range chips; a chip shows those
// lines of the file, the uncovered ones marked.
import { useContext, useId, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  coverageTone,
  coverageTree,
  formatPercent,
  headline,
  mostUncovered,
  percent,
  rangeLabel,
  readCoverage,
  type CoverageFolder,
  type CoverageMetrics,
  type CoverageNode,
  type CoverageTone,
  type CoverageUnit,
  type FileCoverage,
  type LineRange,
  type Ratio,
} from "../../core/coverage";
import { commonDirectory, displayPath } from "../../core/test-results";
import { CardDepthContext } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, type Props } from "../values";
import {
  acceptStrings,
  Chevron,
  CodeExcerpt,
  Disclosure,
  OpenFileButton,
  ReportFrame,
  ReportPathsContext,
  Segmented,
  TEXT_BUTTON,
  useFileText,
  useWorkspaceRoot,
} from "./codeHealthKit";
import { ErrorLine } from "./display";
import { FIELD, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, FADE, RISE, useEntrance, type Entrance } from "./motion";

/** Files a list or an opened folder shows before "Show N more", and how many each click adds. */
const FILE_PAGE = 30;
/** Range chips a file shows before "N more ranges". */
const CHIP_PAGE = 24;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const TONE_INK: Record<CoverageTone, string> = { good: "text-success", warn: "text-warning-text", bad: "text-destructive" };
const TONE_FILL: Record<CoverageTone, string> = { good: "bg-success", warn: "bg-warning", bad: "bg-destructive" };

type View = "tree" | "uncovered";

/** How the rows read: the headline unit and the shown path of each file. */
interface RowContext {
  readonly unit: CoverageUnit;
  readonly shown: (file: FileCoverage) => string;
  readonly isOpen: (key: string) => boolean;
  readonly toggle: (key: string) => void;
  readonly chip: (path: string) => number | null;
  readonly pick: (path: string, start: number) => void;
}

function Bar({ value, className }: { value: number | null; className?: string }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  return (
    <span aria-hidden className={cn("h-1.5 shrink-0 overflow-hidden rounded-full bg-muted", className)}>
      {value === null ? null : (
        <span ref={grow} className={cn("block h-full origin-left rounded-full", TONE_FILL[coverageTone(value)])} style={{ width: `${value}%` }} />
      )}
    </span>
  );
}

/** The bar, percentage and missed count every row ends with. */
function RowFigures({ ratio, missed, unit }: { ratio: Ratio | null; missed: number; unit: CoverageUnit }) {
  const value = percent(ratio);
  return (
    <span className="flex shrink-0 items-center gap-2.5 text-xs tabular-nums">
      <Bar value={value} className="w-10 sm:w-20" />
      <span
        className={cn("w-11 text-right font-medium", value === null ? "text-muted-foreground" : TONE_INK[coverageTone(value)])}
        title={ratio === null ? undefined : `${formatNumber(ratio.covered)} of ${formatNumber(ratio.total)} ${unit} covered`}
      >
        {value === null ? "—" : formatPercent(value)}
      </span>
      <span className={cn("w-10 text-right", missed > 0 ? "text-foreground" : "text-muted-foreground/60")} title={`${formatNumber(missed)} ${unit} not covered`}>
        {formatNumber(missed)}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Header

function MetricStat({ label, ratio }: { label: string; ratio: Ratio }) {
  const value = percent(ratio);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs leading-4 text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1.5 tabular-nums">
        <span className={cn("text-[13px] font-semibold", value === null ? "text-muted-foreground" : "text-foreground")}>
          {value === null ? "—" : formatPercent(value)}
        </span>
        <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
          {formatNumber(ratio.covered)}/{formatNumber(ratio.total)}
        </span>
      </span>
      <Bar value={value} className="w-full" />
    </div>
  );
}

function Summary({ total, unit, files }: { total: CoverageMetrics; unit: CoverageUnit; files: number }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const main = headline(total, unit);
  const value = percent(main);
  const candidates: readonly [string, Ratio | null][] = [
    ["Statements", unit === "statements" ? null : total.statements],
    ["Branches", total.branches],
    ["Functions", total.functions],
  ];
  const others = candidates.flatMap(([label, ratio]) => (ratio !== null && ratio.total > 0 ? [[label, ratio] as const] : []));
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:gap-6">
      <div className="flex min-w-0 shrink-0 flex-col">
        <span className="text-xs leading-5 text-muted-foreground">Coverage</span>
        <span className="flex items-baseline gap-2">
          <span className={cn("text-[30px] font-semibold leading-9 tracking-[-0.02em] tabular-nums", value === null ? "text-muted-foreground" : TONE_INK[coverageTone(value)])}>
            {value === null ? "—" : formatPercent(value)}
          </span>
          <span className="text-xs leading-5 text-muted-foreground">of {unit}</span>
        </span>
        <span className="text-xs leading-5 tabular-nums text-muted-foreground">
          {main === null ? "Nothing to cover" : `${formatNumber(main.covered)} of ${formatNumber(main.total)} ${unit}`} · {formatNumber(files)}{" "}
          {files === 1 ? "file" : "files"}
        </span>
      </div>
      {others.length === 0 ? null : (
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-4 pb-0.5">
          {others.map(([label, ratio]) => (
            <MetricStat key={label} label={label} ratio={ratio} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Uncovered ranges

function RangeChips({ file, context }: { file: FileCoverage; context: RowContext }) {
  const ranges = file.uncovered ?? [];
  const [all, setAll] = useState(false);
  const picked = context.chip(file.path) ?? ranges[0]?.start ?? null;
  const range = ranges.find((item) => item.start === picked) ?? ranges[0] ?? null;
  const fileText = useFileText(range === null ? null : file.path);
  const shown = all ? ranges : ranges.slice(0, CHIP_PAGE);
  if (range === null) return <p className="m-0 pb-2 pl-[22px] text-xs text-muted-foreground">Every line ran.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 pb-2.5 pl-[22px] pt-1">
      <div role="group" aria-label={`Uncovered ${context.unit} in ${context.shown(file)}`} className="flex min-w-0 flex-wrap gap-1">
        {shown.map((item) => (
          <ChipButton key={item.start} range={item} selected={item === range} onClick={() => context.pick(file.path, item.start)} />
        ))}
        {ranges.length > shown.length ? (
          <button type="button" onClick={() => setAll(true)} className={cn(TEXT_BUTTON, "px-1")}>
            {formatNumber(ranges.length - shown.length)} more
          </button>
        ) : null}
      </div>
      <CodeExcerpt path={file.path} file={fileText} tone="bad" mark={{ start: range.start, end: range.end, lines: new Set(range.missed) }} />
    </div>
  );
}

function ChipButton({ range, selected, onClick }: { range: LineRange; selected: boolean; onClick: () => void }) {
  const count = range.missed.length;
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={`${formatNumber(count)} uncovered ${count === 1 ? "line" : "lines"}`}
      aria-label={`${range.start === range.end ? "Line" : "Lines"} ${rangeLabel(range)}, ${formatNumber(count)} uncovered`}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 font-mono text-[11px] tabular-nums transition-colors duration-150",
        FOCUS_RING,
        selected
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-border bg-background text-muted-foreground hover:border-destructive/40 hover:text-foreground",
      )}
    >
      {rangeLabel(range)}
      {range.end > range.start ? <span className="text-[10px] opacity-70">·{count}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rows

function FileRow({ file, name, dir, context, depth }: { file: FileCoverage; name: string; dir: string | null; context: RowContext; depth: number }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const key = `f:${file.path}`;
  const expandable = file.uncovered !== null && file.missed > 0;
  const open = expandable && context.isOpen(key);
  const label = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="min-w-0 truncate font-mono text-[12px] leading-5" title={context.shown(file)}>
        {dir === null || dir === "" ? null : <span className="text-muted-foreground">{dir}/</span>}
        <span className="text-foreground">{name}</span>
      </span>
    </span>
  );
  const indent = { paddingLeft: `${depth * 16}px` };
  return (
    <li ref={rise} className="min-w-0 border-b border-border/50 last:border-b-0">
      {expandable ? (
        <Disclosure
          open={open}
          onToggle={() => context.toggle(key)}
          label={`${context.shown(file)}: ${formatPercent(percent(headline(file, context.unit)) ?? 100)}, ${formatNumber(file.missed)} ${context.unit} uncovered`}
          header={
            <span className="flex w-full min-w-0 items-center gap-2 py-1.5" style={indent}>
              <Chevron open={open} />
              {label}
              <RowFigures ratio={headline(file, context.unit)} missed={file.missed} unit={context.unit} />
            </span>
          }
        >
          {() => (
            <div style={indent}>
              <RangeChips file={file} context={context} />
            </div>
          )}
        </Disclosure>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-2 py-1.5" style={indent}>
          <span aria-hidden className="size-3.5 shrink-0" />
          {label}
          <OpenFileButton path={file.path} line={null} />
          <RowFigures ratio={headline(file, context.unit)} missed={file.missed} unit={context.unit} />
        </div>
      )}
    </li>
  );
}

function FolderRow({ folder, context, depth }: { folder: CoverageFolder; context: RowContext; depth: number }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const key = `d:${folder.path}`;
  const open = context.isOpen(key);
  const ratio = headline(folder.metrics, context.unit);
  return (
    <li ref={rise} className="min-w-0 border-b border-border/50 last:border-b-0">
      <Disclosure
        open={open}
        onToggle={() => context.toggle(key)}
        label={`${folder.path}: ${formatPercent(percent(ratio) ?? 100)}, ${formatNumber(folder.fileCount)} files`}
        header={
          <span className="flex w-full min-w-0 items-center gap-2 py-1.5" style={{ paddingLeft: `${depth * 16}px` }}>
            <Chevron open={open} />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <Icon name={open ? "FolderOpen" : "Folder"} aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-[12px] leading-5 text-foreground">{folder.name}</span>
              <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{formatNumber(folder.fileCount)}</span>
            </span>
            <RowFigures ratio={ratio} missed={folder.missed} unit={context.unit} />
          </span>
        }
      >
        {() => <TreeRows nodes={folder.children} context={context} depth={depth + 1} />}
      </Disclosure>
    </li>
  );
}

function TreeRows({ nodes, context, depth }: { nodes: readonly CoverageNode[]; context: RowContext; depth: number }) {
  const [shown, setShown] = useState(FILE_PAGE);
  const rest = nodes.length - shown;
  return (
    <>
      <ul className={cn("m-0 flex min-w-0 list-none flex-col p-0", depth > 0 && "border-t border-border/50")}>
        {nodes.slice(0, shown).map((node) =>
          node.kind === "folder" ? (
            <FolderRow key={node.path} folder={node} context={context} depth={depth} />
          ) : (
            <FileRow key={node.path} file={node.file} name={node.name} dir={null} context={context} depth={depth} />
          ),
        )}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + FILE_PAGE)} className={cn(TEXT_BUTTON, "py-1")} style={{ paddingLeft: `${depth * 16 + 22}px` }}>
          Show {formatNumber(Math.min(rest, FILE_PAGE))} more of {formatNumber(rest)}
        </button>
      ) : null}
    </>
  );
}

function FlatRows({ files, context }: { files: readonly FileCoverage[]; context: RowContext }) {
  const [shown, setShown] = useState(FILE_PAGE);
  const rest = files.length - shown;
  return (
    <>
      <ul className="m-0 flex min-w-0 list-none flex-col p-0">
        {files.slice(0, shown).map((file) => {
          const path = context.shown(file);
          const slash = path.lastIndexOf("/");
          return <FileRow key={file.path} file={file} name={path.slice(slash + 1)} dir={slash === -1 ? null : path.slice(0, slash)} context={context} depth={0} />;
        })}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + FILE_PAGE)} className={cn(TEXT_BUTTON, "py-1")}>
          Show {formatNumber(Math.min(rest, FILE_PAGE))} more of {formatNumber(rest)}
        </button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

export function Coverage({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const filterId = useId();
  const result = useMemo(() => readCoverage(props.report), [props.report]);
  const id = useMemo(() => propsKey(props.report), [props.report]);
  const report = result.ok ? result.report : null;
  const { common, absolute } = useMemo(() => {
    const paths = report?.files.map((file) => file.path) ?? [];
    return { common: commonDirectory(paths), absolute: paths.some((path) => path.startsWith("/")) };
  }, [report]);
  const root = useWorkspaceRoot(absolute);
  const paths = useMemo(() => ({ root, common }), [root, common]);
  const shown = useMemo(() => (file: FileCoverage) => displayPath(file.path, root, common), [root, common]);
  const tree = useMemo(() => {
    const nodes = report === null ? [] : coverageTree(report.files, shown);
    // One folder at the top (`src`, `data/src`) is the report's root: show what is in it.
    return nodes.length === 1 && nodes[0]!.kind === "folder" ? { base: nodes[0]!.path, nodes: nodes[0]!.children } : { base: null, nodes };
  }, [report, shown]);
  const ranked = useMemo(() => (report === null ? [] : mostUncovered(report.files, report.unit)), [report]);
  const [view, setView] = usePersistedState<View>(`${id}:coverage-view`, "tree", (stored) => (stored === "tree" || stored === "uncovered" ? stored : null));
  const [filter, setFilter] = usePersistedState<string>(`${id}:coverage-filter`, "", (stored) => (typeof stored === "string" ? stored : null));
  // Opened rows (`d:` folders, `f:` files) and each file's picked range (`c:<start>:<path>`). A small
  // report opens its few top folders, so the files show without a click.
  const initiallyOpen =
    tree.nodes.length <= 3 && (report?.files.length ?? 0) <= 30 ? tree.nodes.flatMap((node) => (node.kind === "folder" ? [`d:${node.path}`] : [])) : [];
  const [opened, setOpened] = usePersistedState<string[]>(`${id}:coverage-open`, initiallyOpen, acceptStrings);

  if (!result.ok) return <ErrorLine message={result.error} />;
  const { total, unit, files } = result.report;
  const query = filter.trim().toLowerCase();
  const matches = query === "" ? null : (view === "tree" ? [...files].sort((a, b) => shown(a).localeCompare(shown(b))) : ranked).filter((file) => shown(file).toLowerCase().includes(query));
  const context: RowContext = {
    unit,
    shown,
    isOpen: (key) => opened.includes(key),
    toggle: (key) => setOpened((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key])),
    chip: (path) => {
      const entry = opened.find((item) => item.startsWith("c:") && item.slice(item.indexOf(":", 2) + 1) === path);
      return entry === undefined ? null : Number(entry.slice(2, entry.indexOf(":", 2)));
    },
    pick: (path, start) =>
      setOpened((list) => [...list.filter((item) => !(item.startsWith("c:") && item.slice(item.indexOf(":", 2) + 1) === path)), `c:${start}:${path}`]),
  };

  return (
    <ReportFrame depth={depth} label="Coverage">
      <CardDepthContext value={depth + 1}>
        <ReportPathsContext value={paths}>
          <div className="flex min-w-0 flex-col gap-3.5">
            <Summary total={total} unit={unit} files={files.length} />
            {files.length === 0 ? (
              <p className="m-0 text-xs leading-5 text-muted-foreground">The report lists no files.</p>
            ) : (
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Segmented
                    label="Show files"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "tree", label: "Tree" },
                      { value: "uncovered", label: "Most uncovered" },
                    ]}
                  />
                  {files.length > 1 ? (
                    <label htmlFor={filterId} className="relative min-w-[9rem] flex-1">
                      <span className="sr-only">Filter files</span>
                      <Icon name="Search" aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        id={filterId}
                        type="search"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder="Filter files"
                        className={cn(FIELD, "h-7 pl-7 pr-2 text-xs")}
                      />
                    </label>
                  ) : null}
                </div>
                <div className="flex min-w-0 items-center gap-2 border-b border-border/60 pb-1 text-[11px] leading-4 text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate pl-[22px] font-mono">
                    {matches !== null ? `${formatNumber(matches.length)} of ${formatNumber(files.length)} files` : view === "tree" ? (tree.base ?? "Files") : "Files"}
                  </span>
                  <span className="flex shrink-0 items-center gap-2.5">
                    <span className="w-10 sm:w-20" />
                    <span className="w-11 text-right">{unit === "lines" ? "Lines" : "Stmts"}</span>
                    <span className="w-10 text-right">Missed</span>
                  </span>
                </div>
                {matches !== null ? (
                  matches.length === 0 ? (
                    <p className="m-0 py-1 pl-[22px] text-xs text-muted-foreground">No file matches “{filter.trim()}”.</p>
                  ) : (
                    <FlatRows key={`${view}:${query}`} files={matches} context={context} />
                  )
                ) : view === "tree" ? (
                  <TreeRows nodes={tree.nodes} context={context} depth={0} />
                ) : (
                  <FlatRows files={ranked} context={context} />
                )}
              </div>
            )}
          </div>
        </ReportPathsContext>
      </CardDepthContext>
    </ReportFrame>
  );
}
