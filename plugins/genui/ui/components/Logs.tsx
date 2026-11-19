// A command's output or a log file as a terminal would show it, made easy to
// read: the command and its exit code up top, colours kept, a quiet level bar
// per line with filter chips, search with next/previous, repeated lines
// folded, long output opened at its tail (where a failure usually is) with
// earlier lines a click away, and `file:line` locations opening in BB. Reads
// text, lists of lines and JSON log records (core/logs.ts).
import { useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  LOG_LEVELS,
  firstError,
  foldRepeats,
  lineRuns,
  occurrences,
  readLogs,
  type LogLevel,
  type LogLine,
  type LogLink,
  type LogOutput,
  type LogRow,
} from "../../core/logs";
import { workspacePath, type AnsiColor } from "../../core/test-results";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { finiteNumber, formatNumber, optionalText, type Props } from "../values";
import { ReportFrame, acceptStrings, useWorkspaceRoot } from "./codeHealthKit";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { FADE, useEntrance } from "./motion";
import { IconButton, WithTooltip } from "./iconButton";

/** Rows past which the output opens at its tail. */
const LONG = 80;
/** Rows shown at the tail of long output. */
const TAIL = 60;
/** Rows each "Show earlier/later lines" adds. */
const PAGE = 200;
/** Rows a jump (search, first error) may leave mounted before it shows a window around its target instead. */
const MAX_MOUNTED = 1000;

const ANSI_CLASS: Record<AnsiColor, string> = {
  red: "text-destructive",
  green: "text-success",
  yellow: "text-warning-text",
  blue: "text-[var(--color-timeline-accent,var(--primary))]",
  magenta: "text-[var(--color-timeline-accent,var(--primary))]",
  cyan: "text-[var(--color-timeline-accent,var(--primary))]",
  dim: "text-muted-foreground",
};

const LEVEL_BAR: Record<LogLevel, string> = {
  fatal: "bg-destructive",
  error: "bg-destructive",
  warn: "bg-warning",
  info: "bg-[var(--color-timeline-accent,var(--primary))]",
  debug: "bg-muted-foreground/40",
  trace: "bg-muted-foreground/20",
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  fatal: "Fatal",
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
  trace: "Trace",
};

const LEVEL_NOUN: Record<LogLevel, [string, string]> = {
  fatal: ["fatal", "fatal"],
  error: ["error", "errors"],
  warn: ["warning", "warnings"],
  info: ["info", "info"],
  debug: ["debug", "debug"],
  trace: ["trace", "trace"],
};

interface Range {
  /** The level filter the range belongs to; another filter starts from the default range. */
  readonly view: string;
  readonly start: number;
  /** Exclusive; null: through the last row, however many there become. */
  readonly end: number | null;
}

function acceptRange(stored: unknown): Range | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { view, start, end } = stored as Partial<Range>;
  return typeof view === "string" && typeof start === "number" && (end === null || typeof end === "number") ? { view, start, end } : null;
}

// ---------------------------------------------------------------------------
// One line

function LinkText({ link, text, root }: { link: LogLink; text: string; root: string | null }) {
  const { openFile } = useUiRuntime();
  const target = workspacePath(link.path, root);
  if (openFile === null || target === null) return <>{text}</>;
  return (
    <button
      type="button"
      title={`Open ${target}:${link.line}`}
      onClick={async () => {
        let opened = false;
        try {
          opened = await openFile(target, link.line);
        } catch {
          opened = false;
        }
        if (!opened) toast.error(`Couldn't open ${target}`);
      }}
      className={cn("inline cursor-pointer rounded-sm text-left underline decoration-current/40 underline-offset-2 hover:decoration-current", FOCUS_RING)}
    >
      {text}
    </button>
  );
}

function Line({
  line,
  row,
  rowIndex,
  query,
  current,
  digits,
  wrap,
  root,
  onUnfold,
}: {
  line: LogLine;
  row: LogRow;
  rowIndex: number;
  query: string;
  current: boolean;
  digits: number;
  wrap: boolean;
  root: string | null;
  onUnfold: (index: number) => void;
}) {
  const runs = useMemo(() => lineRuns(line, query), [line, query]);
  const bad = line.level === "error" || line.level === "fatal";
  return (
    <div
      data-row={rowIndex}
      className={cn("flex min-w-0", bad && "bg-destructive/[0.06]", current && "bg-warning/20")}
    >
      <span
        aria-hidden
        className={cn("sticky left-0 z-[1] shrink-0 select-none bg-surface-recessed pl-2 pr-2 text-right tabular-nums text-muted-foreground/60", bad && "bg-[color-mix(in_oklch,var(--destructive)_6%,var(--surface-recessed))]")}
        style={{ width: `calc(${digits}ch + 1rem)` }}
      >
        {line.number}
      </span>
      <span aria-hidden className={cn("w-[3px] shrink-0 rounded-full", line.level === null ? "bg-transparent" : LEVEL_BAR[line.level], line.continued && "opacity-40")} />
      <span className={cn("min-w-0 flex-1 pl-2 pr-3", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
        {line.level === null || line.continued ? null : <span className="sr-only">{LEVEL_LABEL[line.level]}: </span>}
        {runs.length === 0
          ? " "
          : runs.map((run, index) => {
              const style = cn(
                run.color !== null && ANSI_CLASS[run.color],
                run.bold && "font-semibold",
                run.inverse && "rounded-[2px] bg-[color-mix(in_oklch,currentColor_18%,transparent)]",
                run.quiet && "text-muted-foreground",
                run.match && "rounded-[2px] bg-warning/40 text-foreground",
              );
              const content = run.link === null ? run.text : <LinkText link={run.link} text={run.text} root={root} />;
              return style === "" ? (
                <span key={index}>{content}</span>
              ) : (
                <span key={index} className={style}>
                  {content}
                </span>
              );
            })}
        {row.count > 1 ? (
          <button
            type="button"
            onClick={() => onUnfold(row.index)}
            title={`Repeated ${formatNumber(row.count)} times; show each`}
            aria-label={`Repeated ${formatNumber(row.count)} times; show each`}
            className={cn("ml-2 inline-flex cursor-pointer rounded-full bg-muted px-1 align-baseline font-sans text-[10.5px] font-medium leading-4 text-muted-foreground hover:text-foreground", FOCUS_RING)}
          >
            × {formatNumber(row.count)}
          </button>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header and toolbar

function Header({ command, exit, output }: { command: string | null; exit: number | null; output: LogOutput }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const { run } = useUiRuntime();
  const lines = output.lines.length;
  const counts = LOG_LEVELS.filter((level) => output.counts[level] > 0 && (level === "fatal" || level === "error" || level === "warn")).map(
    (level) => `${formatNumber(output.counts[level])} ${LEVEL_NOUN[level][output.counts[level] === 1 ? 0 : 1]}`,
  );
  const facts = [
    `${formatNumber(lines)} ${lines === 1 ? "line" : "lines"}`,
    ...counts,
    ...output.context.map(([key, value]) => `${key} ${value}`),
    output.utc ? "times UTC" : "",
    output.dropped > 0 ? `first ${formatNumber(output.dropped)} lines left out` : "",
  ].filter((fact) => fact !== "");
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        {command === null ? (
          <h3 className="m-0 flex min-w-0 flex-1 items-center gap-1 text-[13px] font-semibold leading-6 text-foreground">
            <Icon name={output.format === "records" ? "FileText" : "Terminal"} aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {output.format === "records" ? "Log" : "Output"}
          </h3>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-1">
            <code className="min-w-0 whitespace-pre-wrap py-0.5 font-mono text-[12.5px] leading-5 text-foreground [overflow-wrap:anywhere]">
              <span className="select-none text-muted-foreground">$ </span>
              {command}
            </code>
            <IconButton label="Copy the command" onClick={() => void run([{ kind: "action", type: "copy", text: command }])}>
              <Icon name="Copy" className="size-3.5" />
            </IconButton>
          </div>
        )}
        {exit === null ? null : (
          <Badge variant={exit === 0 ? "success" : "danger"} className="gap-1 px-2 font-medium tabular-nums">
            <Icon name={exit === 0 ? "CircleCheck" : "CircleX"} aria-hidden className="size-3.5" />
            exit {exit}
          </Badge>
        )}
      </div>
      <p className="m-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{facts.join(" · ")}</p>
    </div>
  );
}

function LevelChips({ output, selected, onToggle }: { output: LogOutput; selected: readonly string[]; onToggle: (level: LogLevel) => void }) {
  const present = LOG_LEVELS.filter((level) => output.counts[level] > 0);
  if (present.length === 0) return null;
  return (
    <ToggleGroup
      type="multiple"
      aria-label="Show levels"
      value={present.filter((level) => selected.includes(level))}
      // The group reports the whole set; the caller toggles the one level that changed.
      onValueChange={(next) => {
        const changed = present.find((level) => next.includes(level) !== selected.includes(level));
        if (changed !== undefined) onToggle(changed);
      }}
      className="min-w-0 flex-wrap justify-start gap-1"
    >
      {present.map((level) => (
        <ToggleGroupItem
          key={level}
          value={level}
          variant="outline"
          aria-label={`${LEVEL_LABEL[level]}, ${formatNumber(output.counts[level])}`}
          className="h-6 min-w-0 gap-1 rounded-full px-2 text-xs font-normal leading-none"
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", LEVEL_BAR[level])} />
          {LEVEL_LABEL[level]}
          <span className="tabular-nums text-muted-foreground">{formatNumber(output.counts[level])}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// ---------------------------------------------------------------------------

function LogView({ output, command, exit, id }: { output: LogOutput; command: string | null; exit: number | null; id: string }) {
  const { run } = useUiRuntime();
  const [levels, setLevels] = usePersistedState<string[]>(`${id}:levels`, [], acceptStrings);
  const [wrap, setWrap] = usePersistedState<boolean>(`${id}:wrap`, true, (stored) => (typeof stored === "boolean" ? stored : null));
  const [unfolded, setUnfolded] = usePersistedState<number[]>(`${id}:unfolded`, [], (stored) =>
    Array.isArray(stored) && stored.every((item) => typeof item === "number") ? stored : null,
  );
  const [stored, setRange] = usePersistedState<Range | null>(`${id}:range`, null, acceptRange);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  /** Counts jumps, so jumping to the same row again scrolls back to it. */
  const [jumps, setJumps] = useState(0);
  const [seekError, setSeekError] = useState(false);
  const viewer = useRef<HTMLDivElement>(null);
  const tailed = useRef(false);

  const view = [...levels].sort().join(",");
  const rows = useMemo(() => {
    const indices = output.lines.flatMap((line, index) => (levels.length === 0 || (line.level !== null && levels.includes(line.level)) ? [index] : []));
    const open = new Set(unfolded);
    return foldRepeats(output.lines, indices).flatMap((row) =>
      row.count > 1 && open.has(row.index) ? Array.from({ length: row.count }, (_, offset) => ({ index: row.index + offset, count: 1 })) : [row],
    );
  }, [output, levels, unfolded]);
  const fallback: Range = { view, start: rows.length > LONG ? rows.length - TAIL : 0, end: null };
  const range = stored !== null && stored.view === view && stored.start < Math.max(rows.length, 1) ? stored : fallback;
  const end = Math.min(rows.length, range.end ?? rows.length);
  const shown = rows.slice(range.start, end);
  const matches = useMemo(
    () => (query === "" ? [] : rows.flatMap((row, index) => (occurrences(output.lines[row.index].text, query).length > 0 ? [index] : []))),
    [rows, output, query],
  );
  const firstErrorLine = useMemo(() => firstError(output.lines), [output]);
  const digits = String(output.lines.length).length;
  const root = useWorkspaceRoot(useMemo(() => output.lines.some((line) => line.links.some((link) => link.path.startsWith("/"))), [output]));

  // Long output opens scrolled to its end, once per mount.
  useLayoutEffect(() => {
    if (tailed.current || viewer.current === null) return;
    tailed.current = true;
    if (range.start > 0 && end === rows.length) viewer.current.scrollTop = viewer.current.scrollHeight;
  }, [range.start, end, rows.length]);

  // A jump scrolls the viewer (never the page) to its row.
  useLayoutEffect(() => {
    if (focus === null || viewer.current === null) return;
    const element = viewer.current.querySelector<HTMLElement>(`[data-row="${focus}"]`);
    if (element !== null) viewer.current.scrollTop = Math.max(0, element.offsetTop - viewer.current.clientHeight / 3);
  }, [focus, jumps, range.start, end]);

  /** Mounts row `index` (widening the range, or a window around it past MAX_MOUNTED) and scrolls to it. */
  const reveal = (index: number) => {
    if (index < range.start || index >= end) {
      const start = Math.min(range.start, index);
      const stop = Math.max(end, index + 1);
      if (stop - start <= MAX_MOUNTED) setRange({ view, start, end: stop >= rows.length ? null : stop });
      else {
        const from = Math.max(0, index - 20);
        setRange({ view, start: from, end: from + PAGE >= rows.length ? null : from + PAGE });
      }
    }
    setFocus(index);
    setJumps((count) => count + 1);
  };

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (current + direction + matches.length) % matches.length;
    setCurrent(next);
    reveal(matches[next]);
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      setQuery("");
    }
  };

  // The first error, once the rows hold it (the level filter may have hidden it).
  useLayoutEffect(() => {
    if (!seekError) return;
    setSeekError(false);
    const index = rows.findIndex((row) => firstErrorLine >= row.index && firstErrorLine < row.index + row.count);
    if (index !== -1) reveal(index);
  });

  const jumpToError = () => {
    if (firstErrorLine === -1) return;
    if (!rows.some((row) => firstErrorLine >= row.index && firstErrorLine < row.index + row.count)) setLevels([]);
    setSeekError(true);
  };

  const toggleLevel = (level: LogLevel) => {
    setLevels((previous) => (previous.includes(level) ? previous.filter((each) => each !== level) : [...previous, level]));
    setFocus(null);
    setCurrent(0);
  };

  const currentRow = matches.length > 0 ? matches[Math.min(current, matches.length - 1)] : null;
  const earlier = range.start;
  const later = rows.length - end;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Header command={command} exit={exit} output={output} />
      {output.lines.length === 0 ? (
        <p className="m-0 text-xs leading-5 text-muted-foreground">No output.</p>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <LevelChips output={output} selected={levels} onToggle={toggleLevel} />
            <div className="flex min-w-0 flex-1 basis-56 items-center gap-1">
              <div className="relative flex min-w-0 flex-1 items-center">
                <Icon name="Search" aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Search the output"
                  value={query}
                  placeholder="Search"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setCurrent(0);
                  }}
                  onKeyDown={onSearchKey}
                  className="min-w-0 pl-8 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
                />
              </div>
              {query === "" ? null : (
                <>
                  <span aria-live="polite" className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
                    {matches.length === 0 ? "No matches" : `${formatNumber(Math.min(current, matches.length - 1) + 1)} of ${formatNumber(matches.length)}`}
                  </span>
                  <IconButton label="Previous match" tooltip="Previous match (Shift+Enter)" disabled={matches.length === 0} onClick={() => step(-1)}>
                    <Icon name="ChevronUp" className="size-3.5" />
                  </IconButton>
                  <IconButton label="Next match" tooltip="Next match (Enter)" disabled={matches.length === 0} onClick={() => step(1)}>
                    <Icon name="ChevronDown" className="size-3.5" />
                  </IconButton>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {firstErrorLine === -1 ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={jumpToError}
                  className="mr-1 h-6 gap-1 px-1 font-normal text-destructive hover:text-destructive [&_[data-icon-root]]:size-3.5"
                >
                  <Icon name="ArrowUp" aria-hidden />
                  First error
                </Button>
              )}
              <WithTooltip tip={wrap ? "Don't wrap long lines" : "Wrap long lines"}>
                <Toggle
                  size="sm"
                  pressed={wrap}
                  onPressedChange={setWrap}
                  aria-label="Wrap long lines"
                  className="size-6 min-w-0 p-0 [&_[data-icon-root]]:size-3.5"
                >
                  <Icon name="TextWrap" />
                </Toggle>
              </WithTooltip>
              <IconButton
                label="Copy all of the output"
                tooltip="Copy all"
                onClick={() => void run([{ kind: "action", type: "copy", text: output.lines.map((line) => line.text).join("\n") }])}
              >
                <Icon name="Copy" className="size-3.5" />
              </IconButton>
            </div>
          </div>
          <div
            ref={viewer}
            role="log"
            aria-label={command === null ? "Output" : `Output of ${command}`}
            className="relative max-h-[28rem] min-w-0 overflow-auto rounded-md bg-surface-recessed py-2 font-mono text-[11.5px] leading-[18px] text-foreground"
          >
            {earlier > 0 ? (
              <Button
                type="button"
                onClick={() => setRange({ view, start: Math.max(0, range.start - PAGE), end: range.end })}
                variant="ghost"
                size="sm"
                className="sticky left-0 mb-1 h-auto px-3 py-0 font-sans font-normal leading-5 text-muted-foreground"
              >
                Show {formatNumber(Math.min(PAGE, earlier))} earlier {Math.min(PAGE, earlier) === 1 ? "line" : "lines"}
                {earlier > PAGE ? ` (${formatNumber(earlier)} in all)` : ""}
              </Button>
            ) : null}
            <div className={wrap ? "min-w-0" : "min-w-max"}>
              {rows.length === 0 ? (
                <p className="m-0 px-3 font-sans text-xs text-muted-foreground">No lines at the chosen levels.</p>
              ) : (
                shown.map((row, offset) => (
                  <Line
                    key={row.index}
                    line={output.lines[row.index]}
                    row={row}
                    rowIndex={range.start + offset}
                    query={query}
                    current={currentRow === range.start + offset || (currentRow === null && focus === range.start + offset)}
                    digits={digits}
                    wrap={wrap}
                    root={root}
                    onUnfold={(index) => setUnfolded((previous) => [...previous, index])}
                  />
                ))
              )}
            </div>
            {later > 0 ? (
              <Button
                type="button"
                onClick={() => setRange({ view, start: range.start, end: end + PAGE >= rows.length ? null : end + PAGE })}
                variant="ghost"
                size="sm"
                className="sticky left-0 mt-1 h-auto px-3 py-0 font-sans font-normal leading-5 text-muted-foreground"
              >
                Show {formatNumber(Math.min(PAGE, later))} later {Math.min(PAGE, later) === 1 ? "line" : "lines"}
                {later > PAGE ? ` (${formatNumber(later)} in all)` : ""}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function Logs({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const result = useMemo(() => readLogs(props.output), [props.output]);
  const command = optionalText(props.command)?.trim() || null;
  const exit = finiteNumber(props.exit);
  const id = useMemo(() => propsKey([props.output, command, exit]), [props.output, command, exit]);
  if (!result.ok) return <ErrorLine message={result.error} />;
  const body = <LogView output={result.output} command={command} exit={exit} id={`logs:${id}`} />;
  return (
    <ReportFrame depth={depth} label={command === null ? "Log" : `Output of ${command}`}>
      {depth > 0 ? body : <CardDepthContext value={1}>{body}</CardDepthContext>}
    </ReportFrame>
  );
}
