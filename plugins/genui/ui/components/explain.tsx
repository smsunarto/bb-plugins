// Components that explain: a step-by-step Walkthrough, a List of rows, and
// a month Calendar of events. Each keeps its own React state; the pure parts
// (parsing, date math) live in explain-logic.ts.
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button as BaseButton } from "@/components/ui/button";
import { Icon as HostIcon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { resolveIconName } from "../icons";
import { RenderNode } from "../render";
import { NodeKeyContext, questionClosed, sentFor, useAnswers, useUiRuntime } from "../runtime";
import { ACCENT, isNode, list, TONE_DOT, TONE_PILL, TONE_TEXT, type Props } from "../values";
import { ACTION_GLYPHS, actionIntent, sendEffect } from "./action-logic";
import { Code } from "./code";
import { CheckMark, ErrorLine } from "./display";
import {
  addMonths,
  daysInMonth,
  dayKey,
  firstWeekday,
  initialMonth,
  localToday,
  monthIndex,
  monthKey,
  monthRange,
  monthWeeks,
  parseDay,
  parseEvents,
  parseListRows,
  parseMonth,
  parseSteps,
  sentTexts,
  weekday,
  type CalendarEvent,
  type Day,
  type ListRow,
  type Month,
  type WalkthroughStep,
} from "./explain-logic";
import { ActionHint, CAPTION, FOCUS_RING, InMessageLine } from "./inputs";
import { FADE, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";

/** Outline buttons sit on the page color, as inputs.tsx's quiet buttons do. */
const QUIET = "bg-background";

/** A quiet text button for secondary toggles. */
const TEXT_BUTTON = cn(
  "shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

const PROSE = "min-w-0 text-sm [&>:first-child]:mt-0 [&>:last-child]:mb-0";

function SkippedNote({ skipped, noun }: { skipped: number; noun: string }) {
  if (skipped === 0) return null;
  return (
    <p className="m-0 text-xs text-muted-foreground">
      Skipped {skipped} invalid {noun}
      {skipped === 1 ? "" : "s"}
    </p>
  );
}

// ── Walkthrough ──────────────────────────────────────────────────────────

/** Past this many steps the progress is one bar instead of a segment per step. */
const MAX_SEGMENTS = 12;

function StepContent({ step }: { step: WalkthroughStep }) {
  return (
    <>
      {step.body === "" ? null : <Markdown content={step.body} className={cn(PROSE, "text-foreground")} />}
      {step.code === null ? null : <Code props={{ code: step.code, language: step.language }} />}
    </>
  );
}

/** One step dealt by Back/Next: slides in a little from that side. */
function DealtStep({ step, from }: { step: WalkthroughStep; from: number }) {
  const enter = useEntrance<HTMLDivElement>(
    from === 0
      ? FADE
      : {
          keyframes: [{ opacity: 0, transform: `translateX(${from}px)` }, { opacity: 1, transform: "none" }],
          duration: 320,
        },
  );
  return (
    <div ref={enter} className="flex min-w-0 flex-col gap-3">
      {step.title === "" ? null : (
        <h4 className="m-0 text-[15px] font-medium leading-6 text-foreground [overflow-wrap:anywhere]">{step.title}</h4>
      )}
      <StepContent step={step} />
    </div>
  );
}

function Progress({ at, count }: { at: number; count: number }) {
  if (count > MAX_SEGMENTS) {
    return (
      <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${((at + 1) / count) * 100}%`, background: ACCENT }}
        />
      </div>
    );
  }
  return (
    <div aria-hidden className="flex w-full gap-1">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none",
            index > at && "bg-muted",
          )}
          style={index <= at ? { background: ACCENT } : undefined}
        />
      ))}
    </div>
  );
}

/** Every step at once: numbered markers joined by a line, as Steps draws them. */
function AllSteps({ steps }: { steps: readonly WalkthroughStep[] }) {
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col p-0">
      {steps.map((step, index) => (
        <li key={index} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
          <div aria-hidden className="flex flex-col items-center">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
                TONE_PILL.info,
              )}
            >
              {index + 1}
            </span>
            {index === steps.length - 1 ? null : <span className="my-1 w-px flex-1 bg-border" />}
          </div>
          <div className={cn("flex min-w-0 flex-col gap-2", index < steps.length - 1 && "pb-5")}>
            <span className="sr-only">Step {index + 1}: </span>
            {step.title === "" ? null : (
              <span className="text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{step.title}</span>
            )}
            <StepContent step={step} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Walkthrough({ props }: { props: Props }) {
  const { steps, skipped } = parseSteps(props.steps);
  const [position, setPosition] = useState(0);
  const [from, setFrom] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const root = useRef<HTMLDivElement>(null);

  if (steps.length === 0) {
    return list(props.steps).length === 0 ? null : <ErrorLine message="Walkthrough steps need a title, body or code" />;
  }

  const count = steps.length;
  // Steps may still be streaming in, and may shrink for a moment.
  const at = Math.min(position, count - 1);
  const last = at === count - 1;

  const go = (next: number) => {
    const target = Math.max(0, Math.min(count - 1, next));
    if (target === at) return;
    setFrom(target > at ? 16 : -16);
    setPosition(target);
    // Back disables on the first step and drops focus; keep it in the walkthrough so the arrows still work.
    const element = root.current;
    if (element !== null && element.contains(document.activeElement)) {
      requestAnimationFrame(() => {
        if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (showAll) return;
    // Keys typed into a control inside a step (a code viewer, a field) are theirs.
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.tagName !== "BUTTON") return;
    if (event.key === "ArrowLeft") go(at - 1);
    else if (event.key === "ArrowRight") go(at + 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={root}
      role="group"
      aria-roledescription="walkthrough"
      aria-label={`Walkthrough, ${count} steps`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span aria-live="polite" className={cn(CAPTION, "tabular-nums")}>
          {showAll ? `${count} steps` : `Step ${at + 1} of ${count}`}
        </span>
        {count > 1 ? (
          <button type="button" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)} className={TEXT_BUTTON}>
            {showAll ? "One at a time" : "Show all"}
          </button>
        ) : null}
      </div>
      {showAll || count === 1 ? null : <Progress at={at} count={count} />}
      <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
        <div ref={inner} className="min-w-0">
          {showAll ? <AllSteps steps={steps} /> : <DealtStep key={at} step={steps[at]!} from={from} />}
        </div>
      </div>
      {showAll || count === 1 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <BaseButton
            type="button"
            size="sm"
            variant="outline"
            className={QUIET}
            aria-keyshortcuts="ArrowLeft"
            disabled={at === 0}
            onClick={() => go(at - 1)}
          >
            Back
          </BaseButton>
          {last ? (
            <BaseButton type="button" size="sm" variant="outline" className={QUIET} onClick={() => go(0)}>
              Start over
            </BaseButton>
          ) : (
            <BaseButton type="button" size="sm" aria-keyshortcuts="ArrowRight" onClick={() => go(at + 1)} className="min-w-16">
              Next
            </BaseButton>
          )}
        </div>
      )}
      <SkippedNote skipped={skipped} noun="step" />
    </div>
  );
}

// ── List ─────────────────────────────────────────────────────────────────

type Leading = "icon" | "dot" | null;

/**
 * A row's own icon, as on a Button: on a row that acts, never an action's
 * glyph, which its end already draws or which would promise another action.
 */
function rowIcon(row: ListRow): string | null {
  const named = row.icon === null ? null : resolveIconName(row.icon);
  return named !== null && row.actions.length > 0 && ACTION_GLYPHS.has(named) ? null : named;
}

function ListValue({ value }: { value: ListRow["value"] }): ReactNode {
  if (value === null) return null;
  if (isNode(value)) {
    return (
      <span className="flex max-w-[45%] shrink-0 items-center justify-end">
        <RenderNode node={value} />
      </span>
    );
  }
  if (typeof value === "object") return null;
  return (
    <span className="max-w-[45%] shrink-0 truncate text-right text-sm tabular-nums text-muted-foreground">{String(value)}</span>
  );
}

/** A List row's part in its List's question (only rows that reply use it): picked, sent, and how to pick it. */
interface RowChoice {
  readonly pressed: boolean;
  readonly sent: boolean;
  /** The question is closed: sent, or the thread moved on. */
  readonly closed: boolean;
  pick(text: string): void;
}

function ListItem({ row, leading, choice }: { row: ListRow; leading: Leading; choice: RowChoice }) {
  const { run } = useUiRuntime();
  const rise = useEntrance<HTMLLIElement>(RISE);
  const [running, setRunning] = useState(false);
  const icon = rowIcon(row);
  const toneName = row.tone ?? "neutral";
  const sends = sentTexts(row.actions);
  const others = row.actions.filter((action) => action.type !== "send");
  // A row that replies is a choice: once its List was answered, or the thread moved on, it is no longer a question.
  const replies = sends.length > 0;
  const closed = replies && choice.closed;
  const pressed = replies && choice.pressed;
  const interactive = (replies || others.length > 0) && !closed;
  const { target } = useAnswers();
  const { glyph, hint } = actionIntent(row.actions, { send: sendEffect(target, replies && !closed, pressed), shown: row.title });

  const content = (
    <>
      {leading === null ? null : (
        <span aria-hidden className={cn("flex shrink-0 items-center justify-center", leading === "icon" ? "size-8" : "w-2")}>
          {icon !== null ? (
            <span className="flex size-8 items-center justify-center rounded-lg bg-surface-recessed">
              <HostIcon name={icon} aria-hidden className={cn("size-4", TONE_TEXT[toneName] || "text-muted-foreground")} />
            </span>
          ) : row.tone !== null ? (
            <span className={cn("size-2 rounded-full", TONE_DOT[row.tone])} />
          ) : null}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{row.title}</span>
        {row.detail === null ? null : (
          <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">{row.detail}</span>
        )}
      </span>
      <ListValue value={row.value} />
      {replies && choice.sent ? (
        <>
          <span className="sr-only">Sent</span>
          <CheckMark className="size-4 shrink-0 text-success" />
        </>
      ) : pressed ? (
        <>
          <span className="sr-only">In your message</span>
          <CheckMark className="size-4 shrink-0 text-[var(--color-timeline-accent,var(--primary))]" />
        </>
      ) : interactive ? (
        <HostIcon
          // What a tap does: send, open or copy; a row that only changes this UI keeps the chevron.
          name={glyph ?? "ChevronRight"}
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/row:text-foreground"
        />
      ) : null}
    </>
  );

  return (
    <li ref={rise} className="min-w-0 border-b border-border/60 last:border-b-0">
      {interactive ? (
        <ActionHint hint={hint} align="end">
          <button
            type="button"
            disabled={running}
            aria-busy={running || undefined}
            aria-pressed={replies ? pressed : undefined}
            onClick={async () => {
              setRunning(true);
              try {
                // A reply row stages its answer; what else it does (a link, a Set) runs when it is picked.
                if (!pressed && others.length > 0) await run(others);
                if (replies) choice.pick(sends.join("\n"));
              } finally {
                setRunning(false);
              }
            }}
            className={cn(
              // The hover wash bleeds past the text column with shadows, which take no layout space.
              "group/row flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-md py-2.5 text-left transition-[background-color,box-shadow] duration-150 hover:bg-state-hover hover:shadow-[-0.5rem_0_0_var(--state-hover),0.5rem_0_0_var(--state-hover)] disabled:cursor-default disabled:opacity-60",
              pressed && "bg-state-hover shadow-[-0.5rem_0_0_var(--state-hover),0.5rem_0_0_var(--state-hover)]",
              FOCUS_RING,
            )}
          >
            {content}
          </button>
        </ActionHint>
      ) : (
        <div className="flex min-w-0 items-center gap-3 py-2.5">{content}</div>
      )}
    </li>
  );
}

/** Rows; the rows that reply (a Send) are one question, a single-select whose pick goes into the user's message. */
export function List({ props }: { props: Props }) {
  const { superseded } = useUiRuntime();
  const { staged, sent, stage } = useAnswers();
  const question = useContext(NodeKeyContext);
  const rows = parseListRows(props.items);
  if (rows.length === 0) {
    return list(props.items).length === 0 ? null : <ErrorLine message="List items need a title" />;
  }
  // One leading column for every row, so titles align.
  const leading: Leading = rows.some((row) => rowIcon(row) !== null)
    ? "icon"
    : rows.some((row) => row.tone !== null)
      ? "dot"
      : null;
  const replying = rows.some((row) => sentTexts(row.actions).length > 0);
  const closed = questionClosed(sent, question, superseded);
  const answered = sentFor(sent, question, (text) => rows.some((row) => sentTexts(row.actions).includes(text)));
  const picked = staged.get(question)?.selection ?? null;
  return (
    <div data-genui-question={replying ? question : undefined} className="flex min-w-0 flex-col gap-2">
      <ul className="m-0 flex min-w-0 list-none flex-col p-0">
        {rows.map((row, index) => (
          // Rows are positional, like Table rows.
          <ListItem
            key={index}
            row={row}
            leading={leading}
            choice={{
              pressed: picked === index,
              sent: answered !== null && sentTexts(row.actions).includes(answered.text),
              closed,
              pick: (text) => void stage(question, picked === index ? null : { text, selection: index }),
            }}
          />
        ))}
      </ul>
      {picked !== null && !closed ? <InMessageLine /> : null}
    </div>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────

/** A fixed Sunday (2026-01-04) to name weekdays by. */
const SUNDAY_UTC = Date.UTC(2026, 0, 4);

function utc({ year, month, day }: Day): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Formatters in the user's locale; every date is built and read in UTC, so the day never shifts. */
function useCalendarFormat() {
  return useMemo(() => {
    const locale = navigator.language || "en-US";
    const make = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    return {
      firstDay: firstWeekday(locale),
      month: make({ month: "long", year: "numeric" }),
      weekdayShort: make({ weekday: "short" }),
      weekdayNarrow: make({ weekday: "narrow" }),
      weekdayLong: make({ weekday: "long" }),
      long: make({ weekday: "long", month: "long", day: "numeric", year: "numeric" }),
      dayNumber: new Intl.NumberFormat(locale),
    };
  }, []);
}

const CHIPS_PER_DAY = 2;
const DOTS_PER_DAY = 3;

function DayCell({
  date,
  events,
  today,
  selected,
  focusable,
  label,
  number,
  onSelect,
  onKeyDown,
  cellRef,
}: {
  date: Day;
  events: readonly CalendarEvent[];
  today: boolean;
  selected: boolean;
  focusable: boolean;
  label: string;
  number: string;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  cellRef: (element: HTMLDivElement | null) => void;
}) {
  const more = events.length - CHIPS_PER_DAY;
  return (
    <div
      ref={cellRef}
      role="gridcell"
      tabIndex={focusable ? 0 : -1}
      aria-selected={selected}
      aria-current={today ? "date" : undefined}
      aria-label={label}
      data-day={dayKey(date)}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "group/day flex h-12 min-w-0 cursor-pointer select-none flex-col items-center gap-1 rounded-md pt-1 transition-colors duration-150 @lg:h-auto @lg:min-h-[4.75rem] @lg:items-stretch @lg:px-1 @lg:pb-1",
        "hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "@lg:bg-state-hover",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors duration-150 @lg:size-6 @lg:text-xs",
          selected
            ? "bg-foreground font-semibold text-background"
            : today
              ? "font-semibold"
              : events.length > 0
                ? "font-medium text-foreground"
                : "text-muted-foreground",
        )}
        style={
          today && !selected
            ? { color: ACCENT, background: `color-mix(in oklch, ${ACCENT} 14%, transparent)` }
            : undefined
        }
      >
        {number}
      </span>
      {/* Narrow: dots. */}
      {events.length === 0 ? null : (
        <span aria-hidden className="flex gap-0.5 @lg:hidden">
          {events.slice(0, DOTS_PER_DAY).map((event, index) => (
            <span key={index} className={cn("size-1 rounded-full", TONE_DOT[event.tone])} />
          ))}
        </span>
      )}
      {/* Wide: short chips. */}
      {events.length === 0 ? null : (
        <span aria-hidden className="hidden min-w-0 flex-col gap-0.5 @lg:flex">
          {events.slice(0, events.length > CHIPS_PER_DAY + 1 ? CHIPS_PER_DAY : CHIPS_PER_DAY + 1).map((event, index) => (
            <span key={index} className={cn("truncate rounded px-1 text-[11px] leading-4", TONE_PILL[event.tone])}>
              {event.title || "Event"}
            </span>
          ))}
          {events.length > CHIPS_PER_DAY + 1 ? (
            <span className="truncate px-1 text-[11px] leading-4 text-muted-foreground">+{more} more</span>
          ) : null}
        </span>
      )}
    </div>
  );
}

function DayEvents({ date, events, heading }: { date: Day; events: readonly CalendarEvent[]; heading: string }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  return (
    <div ref={fade} className="flex min-w-0 flex-col gap-1.5 border-t border-border/60 pt-3">
      <h4 className="m-0 text-xs font-medium leading-5 text-muted-foreground">{heading}</h4>
      {events.length === 0 ? (
        <p className="m-0 text-sm leading-5 text-muted-foreground">Nothing on this day</p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0" aria-label={`Events on ${heading}`}>
          {events.map((event, index) => (
            <li key={`${dayKey(date)}:${index}`} className="flex min-w-0 items-start gap-2.5 text-sm leading-5 text-foreground">
              <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[event.tone])} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{event.title || "Untitled event"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const NAV_BUTTON = cn(
  "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent",
  FOCUS_RING,
);

export function Calendar({ props }: { props: Props }) {
  const format = useCalendarFormat();
  // Today on the user's wall clock, read once: a calendar left open past midnight keeps its mark.
  const [today] = useState(() => localToday(new Date()));
  const [shown, setShown] = useState<Month | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLDivElement>());
  const moved = useRef(false);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();

  const { events, skipped } = parseEvents(props.events);
  const requested = parseMonth(props.month);
  const range = monthRange(events, requested, today);
  const wanted = shown ?? initialMonth(events, requested, today);
  // Events may stream in or change: the shown month stays within their span.
  const month =
    monthIndex(wanted) < monthIndex(range.first)
      ? range.first
      : monthIndex(wanted) > monthIndex(range.last)
        ? range.last
        : { year: wanted.year, month: wanted.month };
  const atFirst = monthIndex(month) === monthIndex(range.first);
  const atLast = monthIndex(month) === monthIndex(range.last);

  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) byDay.set(event.key, [...(byDay.get(event.key) ?? []), event]);

  const weeks = monthWeeks(month, format.firstDay);
  const inMonth = (key: string | null) => key !== null && key.startsWith(`${monthKey(month)}-`);
  const todayKey = dayKey(today);
  const firstEvent = events.find((event) => inMonth(event.key))?.key ?? null;
  // One tab stop in the grid: the cursor, else the selected day, today or the first event of the month.
  const tabStop =
    [cursor, selected, todayKey, firstEvent].find((key): key is string => inMonth(key)) ?? dayKey({ ...month, day: 1 });

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    cells.current.get(tabStop)?.focus();
  }, [tabStop]);

  if (events.length === 0 && list(props.events).length > 0) {
    return <ErrorLine message="Calendar events need a date written yyyy-mm-dd" />;
  }

  const showMonth = (next: Month) => {
    setShown(next);
    setCursor(null);
  };

  const moveTo = (date: Day) => {
    if (monthIndex(date) < monthIndex(range.first) || monthIndex(date) > monthIndex(range.last)) return;
    moved.current = true;
    setShown({ year: date.year, month: date.month });
    setCursor(dayKey(date));
  };

  const onKeyDown = (event: KeyboardEvent, date: Day) => {
    const shift = (days: number) => {
      const next = utc(date);
      next.setUTCDate(next.getUTCDate() + days);
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    };
    const column = (weekday(date) - format.firstDay + 7) % 7;
    switch (event.key) {
      case "ArrowLeft":
        moveTo(shift(-1));
        break;
      case "ArrowRight":
        moveTo(shift(1));
        break;
      case "ArrowUp":
        moveTo(shift(-7));
        break;
      case "ArrowDown":
        moveTo(shift(7));
        break;
      case "Home":
        moveTo(shift(-column));
        break;
      case "End":
        moveTo(shift(6 - column));
        break;
      case "PageUp":
      case "PageDown": {
        const target = addMonths(date, event.key === "PageUp" ? -1 : 1);
        moveTo({ ...target, day: Math.min(date.day, daysInMonth(target)) });
        break;
      }
      case "Enter":
      case " ":
        setSelected((current) => (current === dayKey(date) ? null : dayKey(date)));
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const title = format.month.format(utc({ ...month, day: 1 }));
  const columns = Array.from({ length: 7 }, (_, index) => new Date(SUNDAY_UTC + ((format.firstDay + index) % 7) * 86_400_000));
  const selectedDay = parseDay(selected);
  const selectedHere = selectedDay !== null && inMonth(selected) ? selectedDay : null;

  return (
    <div className="@container flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 aria-live="polite" className="m-0 truncate text-sm font-medium leading-5 text-foreground">
          {title}
        </h4>
        {atFirst && atLast ? null : (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label="Previous month"
              disabled={atFirst}
              onClick={() => showMonth(addMonths(month, -1))}
              className={NAV_BUTTON}
            >
              <HostIcon name="ChevronLeft" aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next month"
              disabled={atLast}
              onClick={() => showMonth(addMonths(month, 1))}
              className={NAV_BUTTON}
            >
              <HostIcon name="ChevronRight" aria-hidden className="size-4" />
            </button>
          </div>
        )}
      </div>
      <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
        <div ref={inner} className="flex min-w-0 flex-col gap-3">
          <div role="grid" aria-label={title} className="flex min-w-0 flex-col">
            <div role="row" className="grid grid-cols-7 pb-1">
              {columns.map((date) => (
                <span
                  key={date.getTime()}
                  role="columnheader"
                  aria-label={format.weekdayLong.format(date)}
                  className="truncate text-center text-[11px] font-medium leading-5 text-muted-foreground @lg:pl-2 @lg:text-left"
                >
                  <span aria-hidden className="@lg:hidden">
                    {format.weekdayNarrow.format(date)}
                  </span>
                  <span aria-hidden className="hidden @lg:inline">
                    {format.weekdayShort.format(date)}
                  </span>
                </span>
              ))}
            </div>
            {weeks.map((week, row) => (
              <div key={`${monthKey(month)}:${row}`} role="row" className="grid grid-cols-7 gap-0.5 border-t border-border/60 py-0.5">
                {week.map((day, column) => {
                  if (day === null) return <span key={column} role="gridcell" aria-hidden />;
                  const date = { ...month, day };
                  const key = dayKey(date);
                  const dayEvents = byDay.get(key) ?? [];
                  const long = format.long.format(utc(date));
                  const count = dayEvents.length;
                  return (
                    <DayCell
                      key={key}
                      date={date}
                      events={dayEvents}
                      today={key === todayKey}
                      selected={key === selected}
                      focusable={key === tabStop}
                      number={format.dayNumber.format(day)}
                      label={`${long}${key === todayKey ? ", today" : ""}${count === 0 ? "" : `, ${count} ${count === 1 ? "event" : "events"}`}`}
                      onSelect={() => {
                        setCursor(key);
                        setSelected((current) => (current === key ? null : key));
                      }}
                      onKeyDown={(event) => onKeyDown(event, date)}
                      cellRef={(element) => {
                        if (element === null) cells.current.delete(key);
                        else cells.current.set(key, element);
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {selectedHere === null ? null : (
            <DayEvents
              key={selected}
              date={selectedHere}
              events={byDay.get(selected!) ?? []}
              heading={format.long.format(utc(selectedHere))}
            />
          )}
        </div>
      </div>
      <SkippedNote skipped={skipped} noun="event" />
    </div>
  );
}
