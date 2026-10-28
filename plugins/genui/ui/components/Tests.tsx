// A test run as a reviewer reads it: the verdict and counts up top, every
// failure open with its message and the frame that matters, and the tests
// that passed or were skipped folded by file or suite. Built for real runs:
// collapsed groups mount nothing, and long lists page in with "N more".
import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ansiLines,
  commonDirectory,
  countsText,
  displayPath,
  firstAppFrame,
  formatDuration,
  groupTests,
  readTestRun,
  libraryFrame,
  stripAnsi,
  workspacePath,
  type AnsiColor,
  type AnsiSegment,
  type StackFrame,
  type TestCase,
  type TestGroup,
  type TestRun,
} from "../../core/test-results";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { formatNumber, optionalText, type Props } from "../values";
import { ErrorLine } from "./display";
import { CAPTION, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, FADE, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight, type Entrance } from "./motion";

/** Failures shown before "N more failures", and how many each click adds. */
const FAILURE_PAGE = 20;
/** Groups (files, suites) shown before "N more". */
const GROUP_PAGE = 30;
/** Tests listed in an opened group before "N more". */
const TEST_PAGE = 100;
/** Lines of a failure message shown before "N more lines". */
const MESSAGE_LINES = 40;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const TEXT_BUTTON = cn(
  "w-fit shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

const ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
  FOCUS_RING,
);

const ANSI_CLASS: Record<AnsiColor, string> = {
  red: "text-destructive",
  green: "text-success",
  yellow: "text-warning-text",
  blue: "text-[var(--color-timeline-accent,var(--primary))]",
  magenta: "text-[var(--color-timeline-accent,var(--primary))]",
  cyan: "text-[var(--color-timeline-accent,var(--primary))]",
  dim: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// The workspace root, to open the absolute paths vitest and jest report

const workspaceRoots = new Map<string, Promise<string | null>>();

/** The thread's checkout path, read once per thread and only when a path needs it; null until known or where there is none. */
function useWorkspaceRoot(needed: boolean): string | null {
  const { threadId } = useUiRuntime();
  const sdk = useSdk();
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    if (!needed || threadId === null) return;
    let pending = workspaceRoots.get(threadId);
    if (pending === undefined) {
      pending = sdk.threads
        .get({ threadId, include: "environment" })
        .then((thread) => {
          const environment = "environment" in thread ? thread.environment : null;
          return typeof environment?.path === "string" ? environment.path : null;
        })
        .catch(() => null);
      workspaceRoots.set(threadId, pending);
    }
    let live = true;
    void pending.then((path) => {
      if (live) setRoot(path);
    });
    return () => {
      live = false;
    };
  }, [needed, threadId, sdk]);
  return root;
}

/** How paths read and open in this run. */
interface Paths {
  readonly root: string | null;
  readonly common: string;
}

const PathsContext = createContext<Paths>({ root: null, common: "" });

/** A `file:line` that opens the file in BB where it can, else plain text. */
function FileLink({ path, line, className }: { path: string; line: number | null; className?: string }) {
  const { openFile } = useUiRuntime();
  const { root, common } = useContext(PathsContext);
  const shown = displayPath(path, root, common);
  const label = line === null ? shown : `${shown}:${line}`;
  const target = workspacePath(path, root);
  if (openFile === null || target === null) {
    return (
      <span className={cn("min-w-0 truncate font-mono text-[11px]", className)} title={path}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Open ${target}`}
      onClick={async (event) => {
        event.stopPropagation();
        let opened = false;
        try {
          opened = await openFile(target, line ?? undefined);
        } catch {
          opened = false;
        }
        if (!opened) toast.error(`Couldn't open ${target}`);
      }}
      className={cn(
        "min-w-0 cursor-pointer truncate rounded-sm text-left font-mono text-[11px] text-primary underline-offset-2 hover:underline",
        FOCUS_RING,
        className,
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Marks

function StatusMark({ status, className }: { status: TestCase["status"]; className?: string }) {
  if (status === "failed") return <Icon name="CircleX" aria-hidden className={cn("size-3.5 shrink-0 text-destructive", className)} />;
  if (status === "passed") return <Icon name="CircleCheck" aria-hidden className={cn("size-3.5 shrink-0 text-success", className)} />;
  // A dashed ring: skipped is neither a pass nor a failure.
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.1" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="ChevronRight"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground motion-reduce:transition-none",
        open && "rotate-90",
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Failure messages

/** Styled runs; `base` (the checkout or the run's common directory) is cut from paths so traces read relative. */
function AnsiText({ segments, base }: { segments: readonly AnsiSegment[]; base: string }) {
  const shorten = (text: string) => (base === "" ? text : text.split(`file://${base}`).join("").split(base).join(""));
  return segments.map((segment, index) =>
    segment.color === null && !segment.bold && !segment.inverse ? (
      shorten(segment.text)
    ) : (
      <span
        key={index}
        className={cn(
          segment.color !== null && ANSI_CLASS[segment.color],
          segment.bold && "font-semibold",
          segment.inverse && "rounded-[2px] bg-[color-mix(in_oklch,currentColor_18%,transparent)]",
        )}
      >
        {shorten(segment.text)}
      </span>
    ),
  );
}

interface MessageLine {
  readonly segments: readonly AnsiSegment[];
  /** The first frame of the code under test, on its line only. */
  readonly frame: StackFrame | null;
  /** A frame of a dependency or the runtime. */
  readonly library: boolean;
  /** A line of an uncoloured Expected/Received diff. */
  readonly side: "expected" | "received" | null;
}

/** A line, or a run of consecutive dependency/runtime frames folded into one row (keyed by its first line). */
type MessageItem = { readonly type: "line"; readonly index: number; readonly line: MessageLine } | { readonly type: "fold"; readonly start: number; readonly count: number };

/**
 * A failure message in monospace with its colours, the first frame of the
 * code under test marked (and opening its file), and runs of dependency and
 * runtime frames folded into one row that opens on click.
 */
function Message({ text }: { text: string }) {
  const { root, common } = useContext(PathsContext);
  const base = root !== null ? `${root.replace(/\/+$/, "")}/` : common;
  const [all, setAll] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  const lines = useMemo((): MessageLine[] => {
    const styled = ansiLines(text.replace(/\s+$/, ""));
    const plain = styled.map((line) => line.map((segment) => segment.text).join(""));
    const first = firstAppFrame(plain);
    // An assertion diff without colour codes (JSON and JUnit reports): `-` lines are the expected side, `+` the received, as the runners print them.
    const diff = plain.some((line) => line.startsWith("- Expected")) && plain.some((line) => line.startsWith("+ Received"));
    return styled.map((segments, index) => ({
      segments,
      frame: first !== null && first.index === index ? first : null,
      library: libraryFrame(plain[index]),
      side:
        !diff || segments.some((segment) => segment.color !== null)
          ? null
          : plain[index].startsWith("-")
            ? "expected"
            : plain[index].startsWith("+")
              ? "received"
              : null,
    }));
  }, [text]);
  const items = useMemo(() => {
    const folded: MessageItem[] = [];
    for (let index = 0; index < lines.length; ) {
      let end = index;
      while (end < lines.length && lines[end].library) end++;
      if (end - index >= 2 && !unfolded.has(index)) {
        folded.push({ type: "fold", start: index, count: end - index });
        index = end;
      } else {
        const stop = Math.max(end, index + 1);
        for (; index < stop; index++) folded.push({ type: "line", index, line: lines[index] });
      }
    }
    return folded;
  }, [lines, unfolded]);
  const shown = all ? items : items.slice(0, MESSAGE_LINES);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="max-h-96 min-w-0 overflow-auto rounded-md bg-surface-recessed py-2 font-mono text-[11.5px] leading-[18px] text-foreground">
        {shown.map((item) =>
          item.type === "fold" ? (
            <button
              key={`fold-${item.start}`}
              type="button"
              onClick={() => setUnfolded((previous) => new Set(previous).add(item.start))}
              className={cn("block w-full cursor-pointer whitespace-pre-wrap px-2.5 text-left text-muted-foreground hover:text-foreground", FOCUS_RING)}
            >
              {"    "}… {item.count} more frames
            </button>
          ) : (
            <div
              key={item.index}
              className={cn(
                "min-h-[18px] whitespace-pre-wrap px-2.5 [overflow-wrap:anywhere]",
                item.line.frame !== null && "flex items-start gap-2 border-l-2 border-destructive bg-destructive/[0.07] pl-2 font-medium",
                item.line.library && "text-muted-foreground",
                item.line.side === "expected" && "text-success",
                item.line.side === "received" && "text-destructive",
              )}
            >
              {item.line.frame !== null ? (
                <>
                  <span className="min-w-0 flex-1">
                    <AnsiText segments={item.line.segments} base={base} />
                  </span>
                  {item.line.frame.linkable ? <OpenFrame path={item.line.frame.path} line={item.line.frame.line} /> : null}
                </>
              ) : (
                <AnsiText segments={item.line.segments} base={base} />
              )}
            </div>
          ),
        )}
      </div>
      {items.length > MESSAGE_LINES ? (
        <button type="button" onClick={() => setAll((value) => !value)} className={TEXT_BUTTON}>
          {all ? "Show fewer lines" : `Show ${formatNumber(items.length - MESSAGE_LINES)} more lines`}
        </button>
      ) : null}
    </div>
  );
}

/** An icon that opens a frame's file, where BB can open it; nothing elsewhere (the line already names it). */
function OpenFrame({ path, line }: { path: string; line: number }) {
  const { openFile } = useUiRuntime();
  const { root } = useContext(PathsContext);
  const target = workspacePath(path, root);
  if (openFile === null || target === null) return null;
  return (
    <button
      type="button"
      title={`Open ${target}:${line}`}
      aria-label={`Open ${target} at line ${line}`}
      onClick={async () => {
        let opened = false;
        try {
          opened = await openFile(target, line ?? undefined);
        } catch {
          opened = false;
        }
        if (!opened) toast.error(`Couldn't open ${target}`);
      }}
      className={cn(ICON_BUTTON, "-my-[3px] size-5")}
    >
      <Icon name="FileText" className="size-3" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Disclosure: a header button and a body that mounts on first open and glides

function Disclosure({
  defaultOpen,
  header,
  label,
  children,
  className,
}: {
  defaultOpen: boolean;
  header: (open: boolean) => ReactNode;
  label?: string;
  children: () => ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  if (open && !mounted) setMounted(true);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS, className)}>
      <div ref={inner} className="flex min-w-0 flex-col">
        <button
          type="button"
          id={`${id}-header`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          aria-label={label}
          onClick={() => setOpen((value) => !value)}
          className={cn("group flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md text-left", FOCUS_RING)}
        >
          {header(open)}
        </button>
        <div
          id={`${id}-body`}
          role="region"
          aria-labelledby={`${id}-header`}
          hidden={!open}
          className={cn("min-w-0 flex-col", open ? "flex" : "hidden")}
        >
          {mounted ? children() : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failures

function Detail({ detail }: { detail: string | null }) {
  if (detail === null) return null;
  return (
    <span className="mt-px shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] font-medium leading-4 text-muted-foreground">
      {detail}
    </span>
  );
}

function Failure({ test }: { test: TestCase }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const { run } = useUiRuntime();
  const { root, common } = useContext(PathsContext);
  const suite = test.suite !== null && test.suite !== test.file ? test.suite : null;
  const copy = () => {
    const where = test.file === null ? "" : `\n${displayPath(test.file, root, common)}${test.line === null ? "" : `:${test.line}`}`;
    const message = test.message === null ? "" : `\n\n${stripAnsi(test.message)}`;
    void run([{ kind: "action", type: "copy", text: `${test.name}${where}${message}` }]);
  };
  return (
    <li ref={rise} className="min-w-0">
      <Disclosure
        defaultOpen
        label={`${test.name}, failed`}
        header={(open) => (
          <>
            <span className="mt-[3px] flex items-center gap-1.5">
              <Chevron open={open} />
              <StatusMark status="failed" />
            </span>
            <span className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground [overflow-wrap:anywhere]">
              {test.name}
            </span>
            <Detail detail={test.detail} />
            {test.ms === null ? null : (
              <span className="mt-px shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">{formatDuration(test.ms)}</span>
            )}
          </>
        )}
      >
        {() => (
          <div className="flex min-w-0 flex-col gap-2 pb-1 pl-[42px] pt-1.5">
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5">
                {suite === null ? null : <span className="min-w-0 truncate">{suite}</span>}
                {test.file === null ? null : <FileLink path={test.file} line={test.line} />}
              </span>
              <button type="button" title="Copy failure" aria-label={`Copy the failure of ${test.name}`} onClick={copy} className={ICON_BUTTON}>
                <Icon name="Copy" className="size-3.5" />
              </button>
            </div>
            {test.message === null ? (
              <p className="m-0 text-xs text-muted-foreground">No message was reported.</p>
            ) : (
              <Message text={test.message} />
            )}
            {test.output === null ? null : (
              <Disclosure
                defaultOpen={false}
                header={(open) => (
                  <>
                    <span className="mt-[3px]">
                      <Chevron open={open} />
                    </span>
                    <span className="text-xs leading-5 text-muted-foreground group-hover:text-foreground">Output</span>
                  </>
                )}
              >
                {() => (
                  <div className="pt-1.5">
                    <Message text={test.output!} />
                  </div>
                )}
              </Disclosure>
            )}
          </div>
        )}
      </Disclosure>
    </li>
  );
}

function Failures({ failures }: { failures: readonly TestCase[] }) {
  const [shown, setShown] = useState(FAILURE_PAGE);
  const rest = failures.length - shown;
  return (
    <section aria-label="Failures" className="flex min-w-0 flex-col gap-2">
      <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
        {failures.slice(0, shown).map((test, index) => (
          <Failure key={index} test={test} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + FAILURE_PAGE)} className={cn(TEXT_BUTTON, "pl-[42px]")}>
          Show {formatNumber(Math.min(rest, FAILURE_PAGE))} more of {formatNumber(rest)} failures
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Passed and skipped, by file or suite

function TestRow({ test }: { test: TestCase }) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-[3px] text-xs leading-5">
      <StatusMark status={test.status} className="mt-[3px] size-3" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("[overflow-wrap:anywhere]", test.status === "skipped" ? "text-muted-foreground" : "text-foreground")}>
          {test.name}
        </span>
        {test.status === "skipped" && test.message !== null ? (
          <span className="truncate text-[11px] text-muted-foreground" title={stripAnsi(test.message)}>
            {stripAnsi(test.message).split("\n").find((line) => line.trim() !== "")}
          </span>
        ) : null}
      </span>
      <Detail detail={test.detail} />
      {test.ms === null ? null : <span className="shrink-0 tabular-nums text-muted-foreground">{formatDuration(test.ms)}</span>}
    </li>
  );
}

function GroupTests({ tests }: { tests: readonly TestCase[] }) {
  const [shown, setShown] = useState(TEST_PAGE);
  const rest = tests.length - shown;
  return (
    <div className="flex min-w-0 flex-col pb-1.5 pl-[22px] pt-0.5">
      <ul className="m-0 min-w-0 list-none p-0">
        {tests.slice(0, shown).map((test, index) => (
          <TestRow key={index} test={test} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + TEST_PAGE)} className={TEXT_BUTTON}>
          Show {formatNumber(Math.min(rest, TEST_PAGE))} more of {formatNumber(rest)}
        </button>
      ) : null}
    </div>
  );
}

function Group({ group }: { group: TestGroup }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const { root, common } = useContext(PathsContext);
  const label = group.file !== null && group.label === group.file ? displayPath(group.file, root, common) : group.label;
  const status = group.counts.passed > 0 ? "passed" : "skipped";
  const summary = countsText(group.counts);
  return (
    <li ref={rise} className="min-w-0 border-b border-border/60 last:border-b-0">
      <Disclosure
        defaultOpen={false}
        label={`${label}: ${summary}`}
        header={(open) => (
          <span className="flex w-full min-w-0 items-center gap-2 py-1.5">
            <Chevron open={open} />
            <StatusMark status={status} />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground" title={group.file ?? group.label}>
              {label}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {group.counts.passed > 0 ? `${formatNumber(group.counts.passed)} passed` : null}
              {group.counts.passed > 0 && group.counts.skipped > 0 ? " · " : null}
              {group.counts.skipped > 0 ? `${formatNumber(group.counts.skipped)} skipped` : null}
              {group.ms === null ? null : <span className="hidden sm:inline"> · {formatDuration(group.ms)}</span>}
            </span>
          </span>
        )}
      >
        {() => <GroupTests tests={group.tests} />}
      </Disclosure>
    </li>
  );
}

function Groups({ groups, heading }: { groups: readonly TestGroup[]; heading: string }) {
  const [shown, setShown] = useState(GROUP_PAGE);
  const rest = groups.length - shown;
  return (
    <section aria-label={heading} className="flex min-w-0 flex-col gap-1">
      <h4 className={cn(CAPTION, "m-0 font-normal")}>{heading}</h4>
      <ul className="m-0 flex min-w-0 list-none flex-col p-0">
        {groups.slice(0, shown).map((group) => (
          <Group key={group.label} group={group} />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + GROUP_PAGE)} className={cn(TEXT_BUTTON, "pt-1")}>
          Show {formatNumber(Math.min(rest, GROUP_PAGE))} more of {formatNumber(rest)}
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header

function Summary({ run, title }: { run: TestRun; title: string | null }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  const { passed, failed, skipped } = run.counts;
  const total = passed + failed + skipped;
  const verdict =
    failed > 0
      ? `${formatNumber(failed)} of ${formatNumber(total)} ${total === 1 ? "test" : "tests"} failed`
      : passed === 0
        ? `${formatNumber(skipped)} skipped, none ran`
        : `${passed === total ? "All " : ""}${formatNumber(passed)} ${passed === 1 ? "test" : "tests"} passed`;
  const parts = [
    { status: "failed" as const, count: failed, label: "failed", fill: "bg-destructive", ink: "text-destructive" },
    { status: "passed" as const, count: passed, label: "passed", fill: "bg-success", ink: "text-success" },
    { status: "skipped" as const, count: skipped, label: "skipped", fill: "bg-muted-foreground/35", ink: "text-muted-foreground" },
  ];
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <StatusMark status={failed > 0 ? "failed" : passed > 0 ? "passed" : "skipped"} className="mt-[3px] size-4" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="m-0 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
            {title ?? verdict}
          </h3>
          {title === null ? null : <span className="text-xs leading-5 text-muted-foreground">{verdict}</span>}
        </div>
        {run.ms === null ? null : (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs leading-5 tabular-nums text-muted-foreground" title="Duration">
            <Icon name="Clock" aria-hidden className="size-3.5" />
            {formatDuration(run.ms)}
          </span>
        )}
      </div>
      <div
        ref={grow}
        role="img"
        aria-label={countsText(run.counts)}
        className="flex h-1.5 w-full origin-left gap-[2px] overflow-hidden rounded-full bg-muted"
      >
        {parts.map((part) =>
          part.count > 0 ? (
            <div key={part.status} className={cn("h-full min-w-[3px]", part.fill)} style={{ flex: `${part.count} 1 0` }} />
          ) : null,
        )}
      </div>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-xs leading-5 text-muted-foreground">
        {parts.map((part) =>
          part.count > 0 || part.status !== "skipped" ? (
            <span key={part.status} className="flex items-center gap-1.5 tabular-nums">
              <span aria-hidden className={cn("size-2 rounded-full", part.count > 0 ? part.fill : "bg-muted")} />
              <span className={cn("font-medium", part.count > 0 ? part.ink : "text-muted-foreground")}>{formatNumber(part.count)}</span>
              {part.label}
            </span>
          ) : null,
        )}
        {run.ignored > 0 ? (
          <span>
            {formatNumber(run.ignored)} {run.ignored === 1 ? "item" : "items"} without a name or status left out
          </span>
        ) : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Tests({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const result = useMemo(() => readTestRun(props.results), [props.results]);
  const title = optionalText(props.title);
  const tests = result.ok ? result.run.tests : [];
  const { failures, groups, common, absolute } = useMemo(() => {
    const files = new Set<string>();
    for (const test of tests) if (test.file !== null) files.add(test.file);
    return {
      failures: tests.filter((test) => test.status === "failed"),
      groups: groupTests(tests.filter((test) => test.status !== "failed")),
      common: commonDirectory(files),
      absolute: [...files].some((file) => file.startsWith("/") || file.startsWith("file://")),
    };
  }, [tests]);
  // Failure traces name absolute paths too; reading the root is one cached request per thread.
  const root = useWorkspaceRoot(absolute || failures.length > 0);
  const paths = useMemo(() => ({ root, common }), [root, common]);

  if (!result.ok) return <ErrorLine message={result.error} />;
  const run = result.run;
  const body =
    run.tests.length === 0 ? (
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="m-0 text-[15px] font-semibold leading-6 text-foreground">{title ?? "Tests"}</h3>
        <p className="m-0 text-xs leading-5 text-muted-foreground">No tests ran.</p>
      </div>
    ) : (
      <PathsContext value={paths}>
        <div className="flex min-w-0 flex-col gap-4">
          <Summary run={run} title={title} />
          {failures.length > 0 ? <Failures failures={failures} /> : null}
          {groups.length > 0 ? (
            <Groups groups={groups} heading={failures.length > 0 ? "Passed and skipped" : run.counts.skipped > 0 ? "By file" : "Passed"} />
          ) : null}
        </div>
      </PathsContext>
    );
  if (depth > 0) return <div className="min-w-0 text-sm text-foreground">{body}</div>;
  return (
    <CardDepthContext value={1}>
      <section className="min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5">{body}</section>
    </CardDepthContext>
  );
}
