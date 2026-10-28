// Tracking: Board (a read-only kanban of BB tasks, GitHub issues or pull
// requests, or written cards), Roadmap (a Gantt with lanes, milestones,
// dependencies and a today line) and Status (a project-health report). The
// reading and date maths live in core/tracking.ts; this file only draws.
// Wide and narrow layouts switch on the frame's own width (container
// queries), so a row opens at its final height without measuring first.
import { useContext, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { relativeTime } from "../../core/project";
import {
  axisShare,
  cardLate,
  firstColumn,
  formatDay,
  formatDays,
  formatRange,
  fullDay,
  HEALTH_LABEL,
  healthSummary,
  initials,
  itemDays,
  localDay,
  readBoard,
  readRoadmap,
  readStatus,
  relativeDue,
  ROADMAP_STATUS_LABEL,
  type Board as BoardData,
  type BoardCard,
  type BoardColumn,
  type Health,
  type HealthItem,
  type Priority,
  type Roadmap as RoadmapData,
  type RoadmapItem,
  type RoadmapStatus,
} from "../../core/tracking";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { usePersistedState, propsKey } from "../usePersistedState";
import { formatNumber, TONE_DOT, TONE_PILL, TONE_TEXT, type Props, type Tone } from "../values";
import { actionIntent } from "./action-logic";
import { CHAR_WIDTH, useWidth } from "./chartKit";
import { ErrorLine } from "./display";
import { ActionHint, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, EASE_OUT_EXPO, FADE, RISE, useEntrance, type Entrance } from "./motion";
import { QuietLine, ShowAll } from "./projectKit";

/** Cards a column shows before "N more", and how many each press adds. */
const COLUMN_PAGE = 8;
/** Roadmap rows and Status rows shown before "Show all". */
const ROADMAP_ROWS = 40;
const STATUS_ROWS = 30;
/** Labels a card shows before "+N". */
const CARD_LABELS = 3;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const ACCENT_BG = "bg-[var(--color-timeline-accent,var(--primary))]";
const ACCENT_TEXT = "text-[var(--color-timeline-accent,var(--primary))]";

const TEXT_BUTTON = cn(
  "w-fit shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

/** Notes and details: small prose at every width (BB's markdown sizes its own paragraphs up on phones). */
const SMALL_PROSE =
  "min-w-0 text-xs leading-[18px] [overflow-wrap:anywhere] [&_li]:text-xs [&_p]:my-0 [&_p]:text-xs [&_p]:leading-[18px] [&>:first-child]:mt-0 [&>:last-child]:mb-0";

/** Today on the user's wall clock, read once: a report left open past midnight keeps its day. */
function useToday(): number {
  const [today] = useState(() => localDay(new Date()));
  return today;
}

/** Opens `href` through the runtime's OpenUrl action, which owns the scheme check and the user's browser choice. */
function useOpenUrl(): (href: string) => void {
  const { run } = useUiRuntime();
  return (href) => void run([{ kind: "action", type: "openUrl", url: href }]);
}

/** The outermost component draws the frame; inside a Card it sits flat. */
function Frame({ label, children }: { label: string; children: ReactNode }) {
  const depth = useContext(CardDepthContext);
  const fade = useEntrance<HTMLDivElement>(FADE);
  const body = (
    <div ref={fade} className="@container flex min-w-0 flex-col gap-3">
      {children}
    </div>
  );
  if (depth > 0) return <div aria-label={label} className="min-w-0 text-sm text-foreground">{body}</div>;
  return (
    <CardDepthContext value={1}>
      <section aria-label={label} className="min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5">
        {body}
      </section>
    </CardDepthContext>
  );
}

function Heading({ title, meta }: { title: string; meta: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <h3 className="m-0 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">{title}</h3>
      {meta === null ? null : <p className="m-0 text-xs leading-5 text-muted-foreground">{meta}</p>}
    </div>
  );
}

/** A person's initials in a small round chip; the full name on hover and for screen readers. */
function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9.5px] font-semibold leading-none tracking-[0.02em] text-muted-foreground ring-2 ring-background",
        className,
      )}
    >
      <span aria-hidden>{initials(name)}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}

function Owners({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, 3);
  return (
    <span className="flex shrink-0 -space-x-1" aria-label={`Assigned to ${names.join(", ")}`}>
      {shown.map((name) => (
        <Avatar key={name} name={name} />
      ))}
      {names.length > shown.length ? (
        <span className="inline-flex h-5 items-center pl-1.5 text-[10.5px] tabular-nums text-muted-foreground">+{names.length - shown.length}</span>
      ) : null}
    </span>
  );
}

function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4", TONE_PILL[tone], className)}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Board

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  none: "No priority",
};

/** Linear's marks: signal bars for high/medium/low, a filled "!" square for urgent; nothing for none. */
function PriorityMark({ priority }: { priority: Priority | null }) {
  if (priority === null || priority === "none") return null;
  const label = PRIORITY_LABEL[priority];
  if (priority === "urgent") {
    return (
      <svg viewBox="0 0 14 14" role="img" aria-label={label} className="size-3.5 shrink-0 text-destructive">
        <title>{label}</title>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" rx="0.75" fill="var(--background)" />
        <circle cx="7" cy="10" r="0.9" fill="var(--background)" />
      </svg>
    );
  }
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg viewBox="0 0 14 14" role="img" aria-label={label} className="size-3.5 shrink-0 text-foreground/80">
      <title>{label}</title>
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={1.5 + bar * 4}
          y={9 - bar * 3}
          width="3"
          height={4 + bar * 3}
          rx="1"
          fill="currentColor"
          opacity={bar < filled ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

const STATUS_TONE: Record<string, string> = {
  triage: "text-muted-foreground",
  backlog: "text-muted-foreground",
  todo: "text-muted-foreground",
  draft: "text-muted-foreground",
  open: "text-success",
  in_progress: "text-warning",
  in_review: "text-success",
  blocked: "text-destructive",
  done: ACCENT_TEXT,
  merged: ACCENT_TEXT,
  closed: "text-muted-foreground",
  canceled: "text-muted-foreground",
};

/** A column's status as Linear draws it: dashed (not started), empty, part-filled (moving), filled with a mark (finished). */
function StatusGlyph({ status }: { status: string }) {
  const color = Object.hasOwn(STATUS_TONE, status) ? STATUS_TONE[status] : "text-muted-foreground";
  const ring = <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />;
  let mark: ReactNode = ring;
  if (status === "backlog" || status === "triage" || status === "draft") {
    mark = <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.9" />;
  } else if (status === "in_progress" || status === "in_review") {
    const sweep = status === "in_progress" ? Math.PI : Math.PI * 1.5;
    const x = 7 + 3 * Math.sin(sweep);
    const y = 7 - 3 * Math.cos(sweep);
    mark = (
      <>
        {ring}
        <path d={`M7 7 V4 A3 3 0 ${sweep > Math.PI ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`} fill="currentColor" />
      </>
    );
  } else if (status === "blocked") {
    mark = (
      <>
        {ring}
        <path d="M3.4 10.6 L10.6 3.4" stroke="currentColor" strokeWidth="1.5" />
      </>
    );
  } else if (status === "done" || status === "merged" || status === "closed") {
    mark = (
      <>
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        <path d="M4.3 7.2 L6.2 9 L9.8 5.2" fill="none" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else if (status === "canceled") {
    mark = (
      <>
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        <path d="M5 5 L9 9 M9 5 L5 9" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" />
      </>
    );
  }
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={cn("size-3.5 shrink-0", color)}>
      {mark}
    </svg>
  );
}

/** A label as a quiet chip, with its GitHub colour as a dot when it has one. */
function LabelChip({ name, color }: { name: string; color: string | null }) {
  return (
    <span className="inline-flex min-w-0 max-w-[11rem] items-center gap-1 rounded-full border border-border px-1.5 text-[10.5px] leading-[18px] text-muted-foreground">
      {color === null ? null : <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="truncate">{name}</span>
    </span>
  );
}

function LiveDot({ agents }: { agents: number }) {
  const label = `${agents} ${agents === 1 ? "agent" : "agents"} working`;
  return (
    <span title={label} className="relative flex size-2 shrink-0">
      <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
      <span aria-hidden className="relative size-2 rounded-full bg-success" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Card({ card, today, open, onToggle }: { card: BoardCard; today: number; open: boolean; onToggle: () => void }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const openUrl = useOpenUrl();
  const late = cardLate(card, today);
  const detailId = useId();
  const shownLabels = card.labels.slice(0, CARD_LABELS);
  const due = card.due === null ? null : relativeDue(card.due, today);
  const meta: ReactNode[] = [];
  if (card.due !== null) {
    meta.push(
      <span
        key="due"
        title={`Due ${fullDay(card.due)}${late && due !== null ? ` · ${due.text}` : ""}`}
        className={cn("inline-flex items-center gap-1 whitespace-nowrap tabular-nums", late ? "text-destructive" : "text-muted-foreground")}
      >
        <Icon name="Calendar" aria-hidden className="size-3" />
        {formatDay(card.due, today)}
        {late ? <span className="sr-only"> (late)</span> : null}
      </span>,
    );
  }
  if (card.parent !== null) {
    meta.push(
      <span key="parent" title={`Sub-task of ${card.parent}`} className="whitespace-nowrap font-mono text-[10.5px] text-muted-foreground">
        ↳ {card.parent}
      </span>,
    );
  }
  if (card.updated !== null) {
    meta.push(
      <span key="updated" title={new Date(card.updated).toLocaleString()} className="whitespace-nowrap text-muted-foreground">
        {relativeTime(card.updated, Date.now())}
      </span>,
    );
  }
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <PriorityMark priority={card.priority} />
        {card.key === null ? null : <span className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{card.key}</span>}
        {card.url === null ? null : <Icon name="ExternalLink" aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
        <span className="flex-1" />
        {card.agents > 0 ? <LiveDot agents={card.agents} /> : null}
        <Owners names={card.owners} />
      </span>
      <span className="line-clamp-3 text-[13px] leading-[18px] text-foreground [overflow-wrap:anywhere]">{card.title}</span>
      {shownLabels.length > 0 || meta.length > 0 ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4">
          {shownLabels.map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
          {card.labels.length > shownLabels.length ? (
            <span className="text-[10.5px] text-muted-foreground" title={card.labels.slice(CARD_LABELS).map((label) => label.name).join(", ")}>
              +{card.labels.length - shownLabels.length}
            </span>
          ) : null}
          {meta}
        </span>
      ) : null}
    </>
  );
  const surface = cn(
    "flex w-full min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-background px-2.5 py-2 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
    late && "border-destructive/40",
  );
  const interactive = cn(surface, "cursor-pointer transition-colors duration-150 hover:border-foreground/20 hover:bg-state-hover", FOCUS_RING);
  let content: ReactNode;
  if (card.url !== null) {
    const url = card.url;
    content = (
      <ActionHint hint={actionIntent([{ kind: "action", type: "openUrl", url }]).hint}>
        <button type="button" className={interactive} onClick={() => openUrl(url)}>
          {body}
        </button>
      </ActionHint>
    );
  } else if (card.detail !== null) {
    content = (
      <div className="flex min-w-0 flex-col">
        <button type="button" aria-expanded={open} aria-controls={detailId} onClick={onToggle} className={cn(interactive, open && "rounded-b-none")}>
          {body}
        </button>
        {open ? (
          <div
            id={detailId}
            className="max-h-60 min-w-0 overflow-y-auto rounded-b-lg border border-t-0 border-border bg-surface-recessed px-2.5 py-2 text-xs"
          >
            <Markdown content={card.detail} className={SMALL_PROSE} />
          </div>
        ) : null}
      </div>
    );
  } else {
    content = <div className={surface}>{body}</div>;
  }
  return (
    <li ref={rise} className="min-w-0">
      {content}
    </li>
  );
}

function Column({
  column,
  today,
  shown,
  onMore,
  open,
  onToggle,
  hidden,
  panelId,
  tabId,
}: {
  column: BoardColumn;
  today: number;
  shown: number;
  onMore: () => void;
  open: string | null;
  onToggle: (id: string) => void;
  hidden: boolean;
  panelId: string;
  tabId: string;
}) {
  const cards = column.cards.slice(0, shown);
  const rest = column.cards.length - cards.length;
  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      className={cn(
        "min-w-0 flex-col gap-2 rounded-xl bg-surface-recessed p-1.5 @xl:flex @xl:min-w-[13rem] @xl:flex-1 @xl:snap-start",
        hidden ? "hidden" : "flex",
      )}
    >
      <div className="hidden min-w-0 items-center gap-1.5 px-1 pt-0.5 text-xs leading-5 @xl:flex">
        <StatusGlyph status={column.status} />
        <span className="truncate font-medium text-foreground">{column.label}</span>
        <span className="tabular-nums text-muted-foreground">{formatNumber(column.cards.length)}</span>
      </div>
      {column.cards.length === 0 ? (
        <p className="m-0 px-1 pb-1 text-xs leading-5 text-muted-foreground">Nothing here</p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
          {cards.map((card) => (
            <Card key={card.id} card={card} today={today} open={open === card.id} onToggle={() => onToggle(card.id)} />
          ))}
        </ul>
      )}
      {rest > 0 ? (
        <button type="button" onClick={onMore} className={cn(TEXT_BUTTON, "self-center px-1 pb-0.5")}>
          {formatNumber(rest)} more
        </button>
      ) : null}
    </div>
  );
}

interface BoardView {
  readonly column: string | null;
  readonly open: string | null;
  readonly more: Readonly<Record<string, number>>;
}

const BOARD_VIEW: BoardView = { column: null, open: null, more: {} };

function acceptBoardView(stored: unknown): BoardView | null {
  if (typeof stored !== "object" || stored === null) return null;
  const view = stored as Partial<BoardView>;
  const more = view.more;
  return {
    column: typeof view.column === "string" ? view.column : null,
    open: typeof view.open === "string" ? view.open : null,
    more:
      typeof more === "object" && more !== null
        ? Object.fromEntries(Object.entries(more).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
        : {},
  };
}

const SOURCE_NOUN: Record<BoardData["source"], [string, string]> = {
  list: ["item", "items"],
  tasks: ["task", "tasks"],
  issues: ["issue", "issues"],
  pulls: ["pull request", "pull requests"],
};

const SOURCE_TITLE: Record<BoardData["source"], string> = {
  list: "Board",
  tasks: "Tasks",
  issues: "Issues",
  pulls: "Pull requests",
};

export function Board({ props }: { props: Props }) {
  const today = useToday();
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const strip = useRef<HTMLDivElement>(null);
  // The first column shown may sit past the strip's edge on a phone: bring its tab into view once, before paint.
  useLayoutEffect(() => {
    const tab = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (strip.current && tab && tab.offsetLeft + tab.offsetWidth > strip.current.clientWidth) strip.current.scrollLeft = tab.offsetLeft - 4;
  }, []);
  const read = useMemo(() => readBoard(props.items, props.columns), [props.items, props.columns]);
  const key = useMemo(() => propsKey(props), [props]);
  const [view, setView] = usePersistedState<BoardView>(`${key}:board`, BOARD_VIEW, acceptBoardView);
  if (!read.ok) return <ErrorLine message={read.error} />;
  const board = read.value;
  const [one, many] = SOURCE_NOUN[board.source];
  const late = board.columns.reduce((sum, column) => sum + column.cards.filter((card) => cardLate(card, today)).length, 0);
  const working = board.columns.reduce((sum, column) => sum + column.cards.filter((card) => card.agents > 0).length, 0);
  const meta = [
    `${formatNumber(board.total)}${board.truncated ? "+" : ""} ${board.total === 1 ? one : many}`,
    late > 0 ? <span key="late" className="text-destructive">{formatNumber(late)} late</span> : null,
    working > 0 ? `${formatNumber(working)} with agents working` : null,
    board.hidden > 0 ? `${formatNumber(board.hidden)} in other columns not shown` : null,
    board.skipped > 0 ? `${formatNumber(board.skipped)} without a title left out` : null,
    board.truncated ? "more in BB Tasks" : null,
  ].filter((part) => part !== null);
  const metaLine = meta.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]));

  if (board.columns.length === 0) {
    return (
      <Frame label={SOURCE_TITLE[board.source]}>
        <Heading title={SOURCE_TITLE[board.source]} meta={null} />
        <QuietLine>{board.skipped > 0 ? `No item has a title (${formatNumber(board.skipped)} left out).` : `No ${many}.`}</QuietLine>
      </Frame>
    );
  }
  const statuses = board.columns.map((column) => column.status);
  const active = view.column !== null && statuses.includes(view.column) ? statuses.indexOf(view.column) : firstColumn(board);
  const select = (index: number) => setView((previous) => ({ ...previous, column: statuses[index]! }));
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (active + step + statuses.length) % statuses.length;
    select(next);
    tabs.current[next]?.focus();
  };

  return (
    <Frame label={SOURCE_TITLE[board.source]}>
      <Heading title={SOURCE_TITLE[board.source]} meta={metaLine} />
      {/* Narrow: one column at a time, picked here. Wide: every column side by side, this strip hidden. */}
      <div
        ref={strip}
        role="tablist"
        aria-label="Columns"
        onKeyDown={onKeyDown}
        className="flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-surface-recessed p-0.5 [scrollbar-width:none] @xl:hidden"
      >
        {board.columns.map((column, index) => (
          <button
            key={column.status}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => select(index)}
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs leading-5 transition-colors duration-150",
              FOCUS_RING,
              index === active ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <StatusGlyph status={column.status} />
            {column.label}
            <span className="tabular-nums text-muted-foreground">{formatNumber(column.cards.length)}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col @xl:snap-x @xl:flex-row @xl:items-start @xl:gap-2 @xl:overflow-x-auto @xl:pb-1">
        {board.columns.map((column, index) => (
          <Column
            key={column.status}
            column={column}
            today={today}
            shown={view.more[column.status] ?? COLUMN_PAGE}
            onMore={() =>
              setView((previous) => ({
                ...previous,
                more: { ...previous.more, [column.status]: (previous.more[column.status] ?? COLUMN_PAGE) + 20 },
              }))
            }
            open={view.open}
            onToggle={(card) => setView((previous) => ({ ...previous, open: previous.open === card ? null : card }))}
            hidden={index !== active}
            panelId={`${id}-panel-${index}`}
            tabId={`${id}-tab-${index}`}
          />
        ))}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Roadmap

/** Bar colour per status: the track is a wash of it, progress the full colour. */
const ROADMAP_COLOR: Record<RoadmapStatus, string> = {
  done: "var(--success)",
  active: "var(--color-timeline-accent,var(--primary))",
  planned: "color-mix(in oklch, var(--muted-foreground) 70%, var(--background))",
  blocked: "var(--destructive)",
  "at-risk": "var(--warning)",
};

const ROADMAP_TONE: Record<RoadmapStatus, Tone> = {
  done: "good",
  active: "info",
  planned: "neutral",
  blocked: "bad",
  "at-risk": "warn",
};

const ROW_H = 30;
const LANE_H = 26;

/** Row layout shared by the label column, the bars and the dependency lines. */
interface RoadmapRow {
  readonly kind: "lane" | "item";
  readonly top: number;
  readonly lane: string;
  readonly item: RoadmapItem | null;
}

function roadmapRows(roadmap: RoadmapData, limit: number): { rows: RoadmapRow[]; height: number; shown: number } {
  const rows: RoadmapRow[] = [];
  let top = 0;
  let shown = 0;
  for (const lane of roadmap.lanes) {
    if (shown >= limit) break;
    if (lane.name !== "" || roadmap.lanes.length > 1) {
      rows.push({ kind: "lane", top, lane: lane.name, item: null });
      top += LANE_H;
    }
    for (const item of lane.items) {
      if (shown >= limit) break;
      rows.push({ kind: "item", top, lane: lane.name, item });
      top += ROW_H;
      shown += 1;
    }
  }
  return { rows, height: top, shown };
}

function Diamond({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("block size-2.5 rotate-45 rounded-[2px]", className)} style={{ background: color }} />;
}

/** One bar, growing from its start once on mount; progress fills from the left. */
function Bar({ item, roadmap, selected, onSelect }: { item: RoadmapItem; roadmap: RoadmapData; selected: boolean; onSelect: () => void }) {
  const grow = useEntrance<HTMLButtonElement>(GROW_X);
  const color = ROADMAP_COLOR[item.status];
  const left = axisShare(item.start, roadmap) * 100;
  if (item.milestone) {
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={onSelect}
        className="absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center"
        style={{ left: `${(axisShare(item.start, roadmap) + axisShare(item.start + 1, roadmap)) * 50}%` }}
      >
        <Diamond color={color} className={cn(item.late && "ring-2 ring-destructive/60", selected && "ring-2 ring-foreground/40")} />
      </button>
    );
  }
  const width = (axisShare(item.end + 1, roadmap) - axisShare(item.start, roadmap)) * 100;
  const progress = item.progress ?? (item.status === "done" ? 100 : 0);
  return (
    <button
      ref={grow}
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={onSelect}
      className={cn(
        "absolute top-1/2 h-4 min-w-1 origin-left -translate-y-1/2 cursor-pointer overflow-hidden rounded-[5px] transition-shadow duration-150",
        item.late && "ring-1 ring-destructive",
        selected && "ring-2 ring-foreground/35",
      )}
      style={{ left: `${left}%`, width: `${width}%`, background: `color-mix(in oklch, ${color} 24%, transparent)` }}
    >
      <span
        className="absolute inset-y-0 left-0 block"
        style={{ width: `${progress}%`, background: color, transitionTimingFunction: EASE_OUT_EXPO }}
      />
      {item.status === "planned" && progress === 0 ? (
        <span className="absolute inset-0 rounded-[5px] border border-dashed" style={{ borderColor: color }} />
      ) : null}
    </button>
  );
}

function ItemDetail({ item, roadmap, onClose }: { item: RoadmapItem; roadmap: RoadmapData; onClose?: () => void }) {
  const today = roadmap.today;
  const before = item.afterIndex === null ? null : roadmap.items.find((other) => other.index === item.afterIndex)!;
  const facts: ReactNode[] = [
    <span key="when" className="tabular-nums">
      {item.milestone ? fullDay(item.start) : `${formatRange(item.start, item.end, today)} · ${formatDays(itemDays(item))}`}
    </span>,
  ];
  if (item.owner !== null) facts.push(<span key="owner">{item.owner}</span>);
  if (item.progress !== null && !item.milestone) facts.push(<span key="progress" className="tabular-nums">{Math.round(item.progress)}% done</span>);
  if (item.late) {
    facts.push(
      <span key="late" className="text-destructive">
        {item.milestone ? "passed" : "ended"} {relativeDue(item.end, today).text.replace(" late", " ago")}, not done
      </span>,
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-recessed px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{item.title}</span>
        <Pill tone={ROADMAP_TONE[item.status]}>{item.milestone ? "Milestone" : ROADMAP_STATUS_LABEL[item.status]}</Pill>
        {onClose === undefined ? null : (
          <button type="button" aria-label="Close" onClick={onClose} className={cn(TEXT_BUTTON, "inline-flex size-5 items-center justify-center")}>
            <Icon name="X" aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <p className="m-0 flex flex-wrap gap-x-1.5 text-xs leading-5 text-muted-foreground">
        {facts.flatMap((fact, index) => (index === 0 ? [fact] : [<span key={`dot${index}`}>·</span>, fact]))}
      </p>
      {item.after !== null ? (
        <p className={cn("m-0 text-xs leading-5", item.overlap ? TONE_TEXT.warn : "text-muted-foreground")}>
          {before === null
            ? `After “${item.after}” (not on this roadmap)`
            : item.overlap
              ? `After ${before.title}, but starts before it ${before.milestone ? "is reached" : "ends"} (${formatDay(before.end, today)})`
              : `After ${before.title} (${before.milestone ? "" : "ends "}${formatDay(before.end, today)})`}
        </p>
      ) : null}
      {item.detail === null ? null : <Markdown content={item.detail} className={SMALL_PROSE} />}
    </div>
  );
}

/** Tick labels left to right, each placed only where it fits: clear of the previous one, the today pill and the right edge. */
function Axis({ roadmap, width }: { roadmap: RoadmapData; width: number }) {
  const todayX = roadmap.today >= roadmap.from && roadmap.today < roadmap.to ? axisShare(roadmap.today + 0.5, roadmap) * width : null;
  let lastEnd = Number.NEGATIVE_INFINITY;
  const placed = roadmap.ticks.filter((tick) => {
    // Before the first measure every label shows; the layout's height doesn't depend on which.
    if (width === 0) return true;
    const x = axisShare(tick.day, roadmap) * width;
    const end = x + tick.label.length * CHAR_WIDTH + 8;
    if (x < lastEnd || end > width + 4) return false;
    if (todayX !== null && x < todayX + 26 && end > todayX - 26) return false;
    lastEnd = end;
    return true;
  });
  return (
    <div className="relative h-6 min-w-0 border-b border-border text-[10.5px] tabular-nums text-muted-foreground" aria-hidden>
      {placed.map((tick) => (
        <span
          key={tick.day}
          className={cn("absolute top-1 whitespace-nowrap pl-1", tick.major && "font-medium text-foreground/80")}
          style={{ left: `${axisShare(tick.day, roadmap) * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

/** Elbow lines from each predecessor's end to its successor's start; overlaps in the warning tone. */
function DependencyLines({ rows, roadmap, height }: { rows: readonly RoadmapRow[]; roadmap: RoadmapData; height: number }) {
  const centre = new Map<number, number>();
  for (const row of rows) if (row.item !== null) centre.set(row.item.index, row.top + ROW_H / 2);
  const lines = rows.flatMap((row) => {
    const item = row.item;
    if (item === null || item.afterIndex === null) return [];
    const fromY = centre.get(item.afterIndex);
    const before = roadmap.items.find((other) => other.index === item.afterIndex);
    if (fromY === undefined || before === undefined) return [];
    const x1 = (before.milestone ? axisShare(before.end + 0.5, roadmap) : axisShare(before.end + 1, roadmap)) * 1000;
    const x2 = (item.milestone ? axisShare(item.start + 0.5, roadmap) : axisShare(item.start, roadmap)) * 1000;
    const toY = row.top + ROW_H / 2;
    const elbow = Math.max(x1 + 6, Math.min(x2 - 4, x1 + 14));
    const d = `M${x1.toFixed(1)} ${fromY} H${elbow.toFixed(1)} V${toY} H${x2.toFixed(1)}`;
    return [{ key: item.index, d, overlap: item.overlap }];
  });
  if (lines.length === 0) return null;
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-x-0 top-0" width="100%" height={height} viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none">
      {lines.map((line) => (
        <path
          key={line.key}
          d={line.d}
          fill="none"
          vectorEffect="non-scaling-stroke"
          strokeWidth={1.25}
          strokeLinejoin="round"
          stroke={line.overlap ? "var(--warning)" : "color-mix(in oklch, var(--muted-foreground) 55%, transparent)"}
          strokeDasharray={line.overlap ? "3 2" : undefined}
        />
      ))}
    </svg>
  );
}

function Legend({ roadmap }: { roadmap: RoadmapData }) {
  const statuses = (["done", "active", "at-risk", "blocked", "planned"] as const).filter((status) =>
    roadmap.items.some((item) => item.status === status && !item.milestone),
  );
  const milestones = roadmap.items.some((item) => item.milestone);
  const todayShown = roadmap.today >= roadmap.from && roadmap.today < roadmap.to;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] leading-4 text-muted-foreground" aria-hidden>
      {statuses.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span className="block h-2 w-3 rounded-[3px]" style={{ background: ROADMAP_COLOR[status] }} />
          {ROADMAP_STATUS_LABEL[status]}
        </span>
      ))}
      {milestones ? (
        <span className="inline-flex items-center gap-1.5">
          <Diamond color="var(--muted-foreground)" className="size-2" />
          Milestone
        </span>
      ) : null}
      {todayShown ? (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("block h-3 w-px", ACCENT_BG)} />
          Today
        </span>
      ) : null}
    </p>
  );
}

/** The narrow layout: per lane, each item with its dates, status and a mini bar on the shared axis. */
function RoadmapList({
  roadmap,
  shown,
  selected,
  onSelect,
}: {
  roadmap: RoadmapData;
  shown: number;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const detailId = useId();
  let budget = shown;
  const todayShare = roadmap.today >= roadmap.from && roadmap.today < roadmap.to ? axisShare(roadmap.today + 0.5, roadmap) : null;
  return (
    <div className="flex min-w-0 flex-col gap-3 @xl:hidden">
      {roadmap.lanes.map((lane) => {
        if (budget <= 0) return null;
        const items = lane.items.slice(0, budget);
        budget -= items.length;
        return (
          <section key={lane.name} className="flex min-w-0 flex-col" aria-label={lane.name || "Items"}>
            {lane.name === "" ? null : <h4 className="m-0 pb-1 text-[11px] font-medium uppercase leading-5 tracking-[0.06em] text-muted-foreground">{lane.name}</h4>}
            <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border/60 p-0">
              {items.map((item) => {
                const open = selected === item.index;
                const color = ROADMAP_COLOR[item.status];
                const progress = item.progress ?? (item.status === "done" ? 100 : 0);
                return (
                  <li key={item.index} className="min-w-0 py-1.5">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`${detailId}-${item.index}`}
                      onClick={() => onSelect(item.index)}
                      className={cn("flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-md text-left", FOCUS_RING)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {item.milestone ? <Diamond color={color} className="size-2" /> : null}
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">{item.title}</span>
                        {item.late ? <Pill tone="bad">Late</Pill> : null}
                        <Pill tone={ROADMAP_TONE[item.status]}>{ROADMAP_STATUS_LABEL[item.status]}</Pill>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-[11px] leading-4 text-muted-foreground">
                        <span className="w-[6.75rem] shrink-0 truncate tabular-nums">
                          {item.milestone ? formatDay(item.start, roadmap.today) : formatRange(item.start, item.end, roadmap.today)}
                        </span>
                        <span aria-hidden className="relative h-1.5 min-w-0 flex-1 rounded-full bg-muted">
                          {item.milestone ? (
                            <span
                              className="absolute top-1/2 block size-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45"
                              style={{ left: `${axisShare(item.start + 0.5, roadmap) * 100}%`, background: color }}
                            />
                          ) : (
                            <span
                              className="absolute inset-y-0 block min-w-[3px] overflow-hidden rounded-full"
                              style={{
                                left: `${axisShare(item.start, roadmap) * 100}%`,
                                width: `${(axisShare(item.end + 1, roadmap) - axisShare(item.start, roadmap)) * 100}%`,
                                background: `color-mix(in oklch, ${color} 30%, transparent)`,
                              }}
                            >
                              <span className="absolute inset-y-0 left-0 block" style={{ width: `${progress}%`, background: color }} />
                            </span>
                          )}
                          {todayShare === null ? null : (
                            <span className={cn("absolute -inset-y-0.5 block w-px", ACCENT_BG)} style={{ left: `${todayShare * 100}%` }} />
                          )}
                        </span>
                        {item.owner === null ? <span className="size-4 shrink-0" /> : <Avatar name={item.owner} className="size-4 text-[8px]" />}
                      </span>
                    </button>
                    {open ? (
                      <div id={`${detailId}-${item.index}`} className="pt-1.5">
                        <ItemDetail item={item} roadmap={roadmap} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The wide layout: a label column and a timeline of bars on one axis. */
function Gantt({
  roadmap,
  shown,
  selected,
  onSelect,
}: {
  roadmap: RoadmapData;
  shown: number;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const [measure, width] = useWidth<HTMLDivElement>();
  const { rows, height } = roadmapRows(roadmap, shown);
  const todayShown = roadmap.today >= roadmap.from && roadmap.today < roadmap.to;
  const todayLeft = axisShare(roadmap.today + 0.5, roadmap) * 100;
  const chosen = selected === null ? null : (roadmap.items.find((item) => item.index === selected) ?? null);
  return (
    <div className="hidden min-w-0 flex-col gap-2.5 @xl:flex">
      <div className="flex min-w-0">
        <div className="w-[clamp(8rem,28%,13rem)] shrink-0 pr-3">
          <div className="h-6 border-b border-border" />
          {rows.map((row) =>
            row.kind === "lane" ? (
              <div key={`lane-${row.lane}`} className="flex items-end pb-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground" style={{ height: LANE_H }}>
                <span className="truncate">{row.lane || "Other"}</span>
              </div>
            ) : (
              <button
                key={row.item!.index}
                type="button"
                aria-pressed={selected === row.item!.index}
                onClick={() => onSelect(row.item!.index)}
                title={row.item!.title}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left text-[13px] leading-5 text-foreground hover:text-foreground/80",
                  FOCUS_RING,
                  selected === row.item!.index && "font-medium",
                )}
                style={{ height: ROW_H }}
              >
                <span className="truncate">{row.item!.title}</span>
                {row.item!.late ? (
                  <span className="shrink-0 text-[10.5px] font-medium text-destructive">
                    Late<span className="sr-only">: ended {formatDay(row.item!.end, roadmap.today)}, not done</span>
                  </span>
                ) : null}
              </button>
            ),
          )}
        </div>
        <div ref={measure} className="relative min-w-0 flex-1">
          <Axis roadmap={roadmap} width={width} />
          <div className="relative" style={{ height }}>
            {roadmap.ticks.map((tick) => (
              <span
                key={tick.day}
                aria-hidden
                className={cn("absolute inset-y-0 w-px", tick.major ? "bg-border" : "bg-border/45")}
                style={{ left: `${axisShare(tick.day, roadmap) * 100}%` }}
              />
            ))}
            {rows.map((row) =>
              row.kind === "lane" ? (
                <span key={`lane-${row.lane}`} aria-hidden className="absolute inset-x-0 h-px bg-border/70" style={{ top: row.top + LANE_H - 1 }} />
              ) : (
                <div key={row.item!.index} className="absolute inset-x-0" style={{ top: row.top, height: ROW_H }}>
                  <Bar item={row.item!} roadmap={roadmap} selected={selected === row.item!.index} onSelect={() => onSelect(row.item!.index)} />
                </div>
              ),
            )}
            <DependencyLines rows={rows} roadmap={roadmap} height={height} />
          </div>
          {todayShown ? (
            <>
              <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 w-px", ACCENT_BG)} style={{ left: `${todayLeft}%` }} />
              <span
                aria-hidden
                className={cn("pointer-events-none absolute top-0.5 -translate-x-1/2 whitespace-nowrap rounded-full px-1.5 text-[10px] font-medium leading-4 text-background", ACCENT_BG)}
                style={{ left: `${todayLeft}%` }}
              >
                {formatDay(roadmap.today, roadmap.today)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <Legend roadmap={roadmap} />
      {chosen === null ? null : <ItemDetail item={chosen} roadmap={roadmap} onClose={() => onSelect(chosen.index)} />}
    </div>
  );
}

function acceptRoadmapView(stored: unknown): { selected: number | null; all: boolean } | null {
  if (typeof stored !== "object" || stored === null) return null;
  const view = stored as { selected?: unknown; all?: unknown };
  return { selected: typeof view.selected === "number" ? view.selected : null, all: view.all === true };
}

export function Roadmap({ props }: { props: Props }) {
  const today = useToday();
  const read = useMemo(() => readRoadmap(props.items, today), [props.items, today]);
  const key = useMemo(() => propsKey(props), [props]);
  const [view, setView] = usePersistedState(`${key}:roadmap`, { selected: null as number | null, all: false }, acceptRoadmapView);
  if (!read.ok) return <ErrorLine message={read.error} />;
  const roadmap = read.value;
  if (roadmap.items.length === 0) {
    return (
      <Frame label="Roadmap">
        <Heading title="Roadmap" meta={null} />
        <QuietLine>No roadmap items.</QuietLine>
      </Frame>
    );
  }
  const total = roadmap.items.length;
  const shown = view.all ? total : Math.min(total, ROADMAP_ROWS);
  const first = Math.min(...roadmap.items.map((item) => item.start));
  const last = Math.max(...roadmap.items.map((item) => item.end));
  const late = roadmap.items.filter((item) => item.late).length;
  const done = roadmap.items.filter((item) => item.status === "done").length;
  const meta = [
    `${formatRange(first, last, today)}`,
    `${formatNumber(total)} ${total === 1 ? "item" : "items"}`,
    done > 0 ? `${formatNumber(done)} done` : null,
    late > 0 ? <span key="late" className="text-destructive">{formatNumber(late)} late</span> : null,
    roadmap.skipped.length > 0 ? (
      <span key="skipped" title={roadmap.skipped.map((skip) => `${skip.title}: ${skip.reason}`).join("\n")}>
        {formatNumber(roadmap.skipped.length)} without usable dates left out
      </span>
    ) : null,
  ].filter((part) => part !== null);
  const select = (index: number) => setView((previous) => ({ ...previous, selected: previous.selected === index ? null : index }));
  return (
    <Frame label="Roadmap">
      <Heading title="Roadmap" meta={meta.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]))} />
      <Gantt roadmap={roadmap} shown={shown} selected={view.selected} onSelect={select} />
      <RoadmapList roadmap={roadmap} shown={shown} selected={view.selected} onSelect={select} />
      {shown < total ? <ShowAll count={total} noun="items" onClick={() => setView((previous) => ({ ...previous, all: true }))} /> : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Status

const HEALTH_TONE: Record<Health, Tone> = {
  "off-track": "bad",
  blocked: "bad",
  "at-risk": "warn",
  "on-track": "good",
  "not-started": "neutral",
  done: "info",
};

/** The summary strip: one segment per status, worst first like the rows. */
const STRIP_FILL: Record<Health, string> = {
  "off-track": TONE_DOT.bad,
  blocked: "bg-destructive/55",
  "at-risk": TONE_DOT.warn,
  "on-track": TONE_DOT.good,
  "not-started": "bg-muted-foreground/30",
  done: TONE_DOT.info,
};

const FILL: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

function HealthBar({ item }: { item: HealthItem }) {
  const fill = useEntrance<HTMLDivElement>(FILL);
  if (item.progress === null) return <span className="text-xs leading-5 text-muted-foreground/70">—</span>;
  const tone = item.status === null ? "neutral" : HEALTH_TONE[item.status];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        role="progressbar"
        aria-label={`${item.name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(item.progress)}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span
          ref={fill}
          className={cn("block h-full origin-left rounded-full", tone === "neutral" ? ACCENT_BG : TONE_DOT[tone])}
          style={{ width: `${item.progress}%` }}
        />
      </span>
      <span className="min-w-9 shrink-0 whitespace-nowrap text-right text-xs leading-5 tabular-nums text-foreground">{Math.round(item.progress)}%</span>
    </span>
  );
}

function HealthRow({ item, today }: { item: HealthItem; today: number }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const tone: Tone = item.status === null ? "neutral" : HEALTH_TONE[item.status];
  const due = item.due === null ? null : relativeDue(item.due, today);
  const label = item.status === null ? (item.given ?? "No status") : HEALTH_LABEL[item.status];
  return (
    <li
      ref={rise}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 py-2.5 @xl:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_minmax(0,7.5rem)_6rem]"
    >
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{item.name}</span>
        {item.note === null ? null : <Markdown content={item.note} className={cn(SMALL_PROSE, "text-muted-foreground")} />}
      </div>
      <Pill tone={tone} className="col-start-2 row-start-1 mt-0.5 justify-self-end @xl:justify-self-start">
        <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
        {label}
      </Pill>
      <div className={cn("col-span-2 min-w-0 @xl:col-span-1 @xl:col-start-3 @xl:row-start-1 @xl:mt-0.5", item.progress === null && "hidden @xl:block")}>
        <HealthBar item={item} />
      </div>
      <div className="col-span-2 flex min-w-0 items-center gap-3 text-xs leading-5 text-muted-foreground @xl:contents">
        <span className="flex min-w-0 items-center gap-1.5 @xl:col-start-4 @xl:row-start-1 @xl:mt-0.5">
          {item.owner === null ? null : (
            <>
              <Avatar name={item.owner} />
              <span className="truncate">{item.owner}</span>
            </>
          )}
        </span>
        <span
          title={item.due === null ? undefined : `Due ${fullDay(item.due)}`}
          className={cn(
            "ml-auto whitespace-nowrap tabular-nums @xl:col-start-5 @xl:row-start-1 @xl:ml-0 @xl:mt-0.5 @xl:text-right",
            item.late && "font-medium text-destructive",
          )}
        >
          {due === null ? null : item.status === "done" ? formatDay(item.due!, today) : due.text}
        </span>
      </div>
    </li>
  );
}

export function Status({ props }: { props: Props }) {
  const today = useToday();
  const read = useMemo(() => readStatus(props.items, today), [props.items, today]);
  const key = useMemo(() => propsKey(props), [props]);
  const [all, setAll] = usePersistedState(`${key}:status`, false, (stored) => (typeof stored === "boolean" ? stored : null));
  if (!read.ok) return <ErrorLine message={read.error} />;
  const report = read.value;
  if (report.items.length === 0) {
    return (
      <Frame label="Status">
        <Heading title="Status" meta={null} />
        <QuietLine>{report.skipped > 0 ? `No item has a name (${formatNumber(report.skipped)} left out).` : "Nothing to report."}</QuietLine>
      </Frame>
    );
  }
  const total = report.items.length;
  const late = report.items.filter((item) => item.late).length;
  const worst = report.items[0]!;
  const attention = report.items.filter((item) => item.status === "off-track" || item.status === "blocked" || item.status === "at-risk").length;
  const title =
    attention === 0
      ? report.items.every((item) => item.status === "done")
        ? "All done"
        : "Everything on track"
      : `${formatNumber(attention)} of ${formatNumber(total)} need attention`;
  const shown = all ? report.items : report.items.slice(0, STATUS_ROWS);
  const segments = (["off-track", "blocked", "at-risk", "on-track", "not-started", "done"] as const)
    .map((status) => ({ status, count: report.items.filter((item) => item.status === status).length }))
    .filter((segment) => segment.count > 0);
  return (
    <Frame label="Status">
      <div className="flex min-w-0 flex-col gap-2">
        <Heading
          title={title}
          meta={
            <>
              {healthSummary(report)}
              {late > 0 ? (
                <>
                  {" · "}
                  <span className="text-destructive">{formatNumber(late)} past due</span>
                </>
              ) : null}
              {report.skipped > 0 ? ` · ${formatNumber(report.skipped)} without a name left out` : null}
            </>
          }
        />
        <div role="img" aria-label={healthSummary(report)} className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
          {segments.map((segment) => (
            <span key={segment.status} className={cn("h-full min-w-[3px]", STRIP_FILL[segment.status])} style={{ flex: `${segment.count} 1 0` }} />
          ))}
          {report.unknown > 0 ? <span className="h-full min-w-[3px] bg-muted-foreground/20" style={{ flex: `${report.unknown} 1 0` }} /> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="hidden min-w-0 grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_minmax(0,7.5rem)_6rem] gap-x-4 border-b border-border pb-1.5 text-[11px] leading-4 text-muted-foreground @xl:grid">
          <span>{worst.status === "done" ? "Project" : "Project · worst first"}</span>
          <span>Status</span>
          <span>Progress</span>
          <span>Owner</span>
          <span className="text-right">Due</span>
        </div>
        <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border/60 p-0">
          {shown.map((item) => (
            <HealthRow key={item.index} item={item} today={today} />
          ))}
        </ul>
      </div>
      {shown.length < total ? <ShowAll count={total} noun="projects" onClick={() => setAll(true)} /> : null}
    </Frame>
  );
}
