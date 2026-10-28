// Shared by Findings and Coverage: the thread's checkout root (to show and
// open the absolute paths tools report), reading a file named in a report
// through `runtime.readText`, the code excerpt with its marked lines, and the
// small controls both use (segmented switch, disclosure row, text buttons).
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { displayPath, workspacePath } from "../../core/test-results";
import { useUiRuntime, type TextFile } from "../runtime";
import { formatNumber } from "../values";
import { FOCUS_RING } from "./inputs";
import { SMOOTH_HEIGHT_CLASS, useSmoothHeight } from "./motion";
import { ICON_BUTTON } from "./projectKit";

export const TEXT_BUTTON = cn(
  "w-fit shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

// ---------------------------------------------------------------------------
// Paths

const workspaceRoots = new Map<string, Promise<string | null>>();

/** The thread's checkout path, read once per thread and only when a path needs it; null until known or where there is none. */
export function useWorkspaceRoot(needed: boolean): string | null {
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

/** How a report's paths read and open: the checkout root and the reported paths' common directory. */
export interface ReportPaths {
  readonly root: string | null;
  readonly common: string;
}

export const ReportPathsContext = createContext<ReportPaths>({ root: null, common: "" });

/** A path as shown: relative to the checkout, else without the report's common directory. */
export function useShownPath(): (path: string) => string {
  const { root, common } = useContext(ReportPathsContext);
  return (path) => displayPath(path, root, common);
}

/** How `path` opens in BB: the path BB opens, and `open` at a line (a toast when it fails); null where BB can't open it. */
export function useFileOpener(path: string): { readonly target: string; open(line: number | null): Promise<void> } | null {
  const { openFile } = useUiRuntime();
  const { root } = useContext(ReportPathsContext);
  const target = workspacePath(path, root);
  if (openFile === null || target === null) return null;
  return {
    target,
    async open(line) {
      let opened = false;
      try {
        opened = await openFile(target, line ?? undefined);
      } catch {
        opened = false;
      }
      if (!opened) toast.error(`Couldn't open ${target}`);
    },
  };
}

/** An icon that opens `path` in BB at `line`, where BB can open it; nothing elsewhere. */
export function OpenFileButton({ path, line, label }: { path: string; line: number | null; label?: string }) {
  const file = useFileOpener(path);
  if (file === null) return null;
  const where = line === null ? file.target : `${file.target}:${line}`;
  return (
    <button
      type="button"
      title={`Open ${where}`}
      aria-label={label ?? (line === null ? `Open ${file.target}` : `Open ${file.target} at line ${line}`)}
      onClick={(event) => {
        event.stopPropagation();
        void file.open(line);
      }}
      className={ICON_BUTTON}
    >
      <Icon name="FileText" className="size-3.5" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Reading the file a report names

/**
 * Paths to try for a reported path, in order: as given, inside the checkout,
 * and for module paths (Go's `github.com/org/repo/pkg/a.go`) the same path
 * without its first one to three segments.
 */
function readCandidates(path: string, root: string | null): string[] {
  const candidates = [path];
  const relative = workspacePath(path, root);
  if (relative !== null) candidates.push(relative);
  const parts = path.split("/");
  if (!path.startsWith("/") && parts.length > 2 && parts[0]!.includes(".")) {
    for (let drop = 1; drop <= 3 && parts.length - drop >= 1; drop++) candidates.push(parts.slice(drop).join("/"));
  }
  return [...new Set(candidates)];
}

/** Files already read, per surface (its readText), so a remounted row shows its code at once. */
const READ = new WeakMap<object, Map<string, TextFile>>();

/** The text of a file a report names: null while it loads. */
export function useFileText(path: string | null): TextFile | null {
  const { readText } = useUiRuntime();
  const { root } = useContext(ReportPathsContext);
  const key = path === null ? null : `${root ?? ""}\n${path}`;
  const cached = key === null || readText === null ? undefined : READ.get(readText)?.get(key);
  const [state, setState] = useState<{ key: string | null; file: TextFile | null }>({ key, file: cached ?? null });
  const current = state.key === key ? state.file : (cached ?? null);
  useEffect(() => {
    if (path === null || key === null) return;
    if (readText === null) {
      setState({ key, file: { ok: false, error: "files can't be read here" } });
      return;
    }
    const known = READ.get(readText)?.get(key);
    if (known !== undefined) {
      setState({ key, file: known });
      return;
    }
    let live = true;
    void (async () => {
      let file: TextFile = { ok: false, error: "file not found" };
      for (const candidate of readCandidates(path, root)) {
        file = await readText(candidate);
        if (file.ok) break;
      }
      let cache = READ.get(readText);
      if (cache === undefined) READ.set(readText, (cache = new Map()));
      if (file.ok) cache.set(key, file);
      if (live) setState({ key, file });
    })();
    return () => {
      live = false;
    };
  }, [path, key, root, readText]);
  return current;
}

// ---------------------------------------------------------------------------
// Code excerpt

/** Lines shown above and below what an excerpt marks. */
const CONTEXT_LINES = 3;
/** Lines an excerpt shows at most; a longer range shows its start and says how much more there is. */
const MAX_EXCERPT_LINES = 40;

export type MarkTone = "bad" | "warn" | "info";

/** The wash over a marked line; the sticky gutter lays it over the background so code scrolling under it stays hidden. */
const MARK_TINT: Record<MarkTone, string> = {
  bad: "color-mix(in oklch, var(--destructive) 9%, transparent)",
  warn: "color-mix(in oklch, var(--warning) 14%, transparent)",
  info: "color-mix(in oklch, var(--color-timeline-accent, var(--primary)) 10%, transparent)",
};

const MARK_GUTTER: Record<MarkTone, string> = {
  bad: "border-destructive text-destructive",
  warn: "border-warning text-warning-text",
  info: "border-[var(--color-timeline-accent,var(--primary))] text-foreground",
};

const MARK_UNDERLINE: Record<MarkTone, string> = {
  bad: "decoration-destructive",
  warn: "decoration-warning",
  info: "decoration-[var(--color-timeline-accent,var(--primary))]",
};

/** The span a column marks on its line: to `endColumn`, else the word (or one character) at `column`. */
function columnSpan(text: string, column: number, endColumn: number | null): [number, number] | null {
  const start = Math.min(column - 1, text.length);
  if (start < 0) return null;
  if (endColumn !== null && endColumn > column) return [start, Math.min(endColumn - 1, text.length)];
  const word = /^[\w$]+/.exec(text.slice(start));
  const end = word !== null ? start + word[0].length : Math.min(start + 1, text.length);
  return end > start ? [start, end] : null;
}

export interface ExcerptMark {
  /** First and last line marked (1-based, inclusive). */
  readonly start: number;
  readonly end: number;
  /** Lines in the range that are marked (all when absent): coverage leaves non-executable lines unmarked. */
  readonly lines?: ReadonlySet<number>;
  /** A column on `start` to underline (a finding's), with its end on the same line when known. */
  readonly column?: { readonly start: number; readonly end: number | null } | null;
}

function Placeholder({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 px-3 py-[7px]">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none"
          style={{ width: `${[62, 80, 45, 70, 54][index % 5]}%` }}
        />
      ))}
    </div>
  );
}

/**
 * The lines of `path` around `mark`, numbered as in the file, the marked
 * lines tinted with a bar in the gutter and the marked column underlined.
 * The file is read through `runtime.readText`; while it loads the excerpt
 * holds its height. Where it can't be read, one quiet line says why (and the
 * tool's own `snippet` shows instead when there is one).
 */
export function CodeExcerpt({
  path,
  file,
  mark,
  tone,
  snippet = null,
}: {
  path: string;
  file: TextFile | null;
  mark: ExcerptMark;
  tone: MarkTone;
  snippet?: string | null;
}) {
  const shownPath = useShownPath()(path);
  const marked = mark.end - mark.start + 1;
  const range = mark.start === mark.end ? `L${mark.start}` : `L${mark.start}–${mark.end}`;
  const frame = (body: ReactNode, caption: ReactNode = range) => (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex h-7 items-center justify-between gap-3 border-b border-border bg-surface-recessed pl-3 pr-1 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2 font-mono">
          <span className="truncate text-foreground" title={path}>
            {shownPath}
          </span>
          <span className="shrink-0 tabular-nums">{caption}</span>
        </span>
        <OpenFileButton path={path} line={mark.start} />
      </div>
      {body}
    </div>
  );

  if (file === null) {
    const rows = Math.min(marked, MAX_EXCERPT_LINES) + CONTEXT_LINES * 2;
    return frame(<Placeholder rows={rows} label={`Reading ${shownPath}`} />);
  }
  if (!file.ok) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="m-0 flex min-w-0 items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          <Icon name="FileQuestion" aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Couldn't show {shownPath}:{mark.start}: {file.error}
          </span>
        </p>
        {snippet === null ? null : frame(<ExcerptLines lines={snippet.replace(/\n$/, "").split("\n")} first={mark.start} mark={mark} tone={tone} />)}
      </div>
    );
  }
  const all = file.text.split(/\r?\n/);
  if (mark.start > all.length) {
    return (
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        {shownPath} has {formatNumber(all.length)} lines; line {formatNumber(mark.start)} is past its end (the file changed since the report).
      </p>
    );
  }
  const from = Math.max(1, mark.start - CONTEXT_LINES);
  const cut = marked > MAX_EXCERPT_LINES;
  const to = Math.min(all.length, cut ? mark.start + MAX_EXCERPT_LINES - 1 : mark.end + CONTEXT_LINES);
  const hidden = cut ? mark.end - to : 0;
  return frame(
    <>
      <ExcerptLines lines={all.slice(from - 1, to)} first={from} mark={mark} tone={tone} />
      {hidden > 0 ? (
        <p className="m-0 border-t border-border/60 px-3 py-1 text-[11px] leading-5 text-muted-foreground">
          {formatNumber(hidden)} more marked {hidden === 1 ? "line" : "lines"} to line {formatNumber(mark.end)}
        </p>
      ) : null}
    </>,
  );
}

function ExcerptLines({ lines, first, mark, tone }: { lines: readonly string[]; first: number; mark: ExcerptMark; tone: MarkTone }) {
  const width = String(first + lines.length - 1).length;
  return (
    <div className="max-h-[26rem] overflow-auto py-1.5 font-mono text-[11.5px] leading-5 [tab-size:2]">
      <div className="min-w-max">
        {lines.map((text, index) => {
          const number = first + index;
          const inRange = number >= mark.start && number <= mark.end;
          const marked = inRange && (mark.lines === undefined || mark.lines.has(number));
          const span = marked && number === mark.start && mark.column != null ? columnSpan(text, mark.column.start, mark.column.end) : null;
          return (
            <div key={number} className="flex" style={marked ? { backgroundColor: MARK_TINT[tone] } : undefined}>
              <span
                className={cn(
                  "sticky left-0 shrink-0 select-none border-l-2 bg-background pl-2 pr-3 text-right tabular-nums",
                  marked ? MARK_GUTTER[tone] : "border-transparent text-muted-foreground/70",
                )}
                style={{
                  minWidth: `${width + 2.5}ch`,
                  backgroundImage: marked ? `linear-gradient(${MARK_TINT[tone]}, ${MARK_TINT[tone]})` : undefined,
                }}
              >
                {number}
                {marked ? <span className="sr-only"> (marked)</span> : null}
              </span>
              <span className={cn("whitespace-pre pr-4", marked ? "text-foreground" : "text-foreground/80")}>
                {span === null ? (
                  text === "" ? " " : text
                ) : (
                  <>
                    {text.slice(0, span[0])}
                    <span className={cn("underline decoration-wavy decoration-[1.5px] underline-offset-[3px]", MARK_UNDERLINE[tone])}>
                      {text.slice(span[0], span[1])}
                    </span>
                    {text.slice(span[1])}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls

export function Chevron({ open }: { open: boolean }) {
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

/** A row that opens to a body: the body mounts on first open, and the height glides on the user's click. */
export function Disclosure({
  open,
  onToggle,
  header,
  label,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  header: ReactNode;
  label?: string;
  children: () => ReactNode;
  className?: string;
}) {
  const id = useId();
  const [mounted, setMounted] = useState(open);
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
          onClick={onToggle}
          className={cn("group flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md text-left", FOCUS_RING)}
        >
          {header}
        </button>
        <div id={`${id}-body`} role="region" aria-labelledby={`${id}-header`} hidden={!open} className={cn("min-w-0 flex-col", open ? "flex" : "hidden")}>
          {mounted ? children() : null}
        </div>
      </div>
    </div>
  );
}

/** Two or three exclusive views (By file / By severity), as Choice draws its segments. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { readonly value: T; readonly label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit max-w-full shrink-0 gap-0.5 rounded-lg bg-surface-recessed p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 cursor-pointer whitespace-nowrap rounded-md px-2.5 text-xs transition-[color,background-color,box-shadow] duration-150",
              FOCUS_RING,
              selected
                ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_0.5px_var(--border)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A string list kept by usePersistedState: anything else stored is refused. */
export function acceptStrings(stored: unknown): string[] | null {
  return Array.isArray(stored) && stored.every((item) => typeof item === "string") ? stored : null;
}

/** The outer frame: a bordered card at the top level, flat inside a Card. */
export function ReportFrame({ depth, label, children }: { depth: number; label: string; children: ReactNode }) {
  if (depth > 0) {
    return (
      <section aria-label={label} className="min-w-0 text-sm text-foreground">
        {children}
      </section>
    );
  }
  return (
    <section aria-label={label} className="min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5">
      {children}
    </section>
  );
}
