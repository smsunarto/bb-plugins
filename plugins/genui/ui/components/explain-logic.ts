// Pure logic behind the explaining components (Diagram details, Walkthrough,
// List, Calendar): no React, no DOM, so it is unit-testable without the host
// modules.
import type { Action, UiNode, Value } from "../../core/types";
import { isAction, isNode, isObject, isScalar, list, optionalText, text, tone, type Tone } from "../values";

// ── Diagram details ─────────────────────────────────────────────────────

/** What opens under the diagram for one node: markdown and components, in order. */
export type DetailPart = string | UiNode;

export interface DiagramDetail {
  readonly key: string;
  readonly parts: readonly DetailPart[];
}

function detailParts(value: Value): DetailPart[] {
  if (isNode(value)) return [value];
  if (isScalar(value)) {
    const body = text(value).trim();
    return body === "" ? [] : [body];
  }
  if (Array.isArray(value)) return value.flatMap((item: Value) => detailParts(item));
  return [];
}

/** `{nodeId: text or components}` as details in key order; null when `value` is not such an object. */
export function parseDetails(value: Value | undefined): DiagramDetail[] | null {
  if (value === undefined || value === null) return [];
  if (!isObject(value) || "kind" in value) return null;
  return Object.entries(value as Readonly<Record<string, Value>>).flatMap(([key, item]) => {
    const parts = detailParts(item);
    return key.trim() === "" || parts.length === 0 ? [] : [{ key, parts }];
  });
}

/**
 * Mermaid ids its node groups as `<svg id>-<kind>-<node id>-<counter>`
 * (flowchart, state, class and ER nodes) and subgraphs as `<svg id>-<id>`.
 * Returns the node id the diagram's source used, or null.
 */
export function mermaidNodeId(elementId: string, svgId: string, cluster: boolean): string | null {
  const prefix = `${svgId}-`;
  if (svgId === "" || !elementId.startsWith(prefix)) return null;
  const rest = elementId.slice(prefix.length);
  if (rest === "") return null;
  if (cluster) return rest;
  return /^(?:flowchart|state|classId|entity)-(.+)-\d+$/.exec(rest)?.[1] ?? null;
}

/**
 * The detail a drawn node opens: the one keyed by its mermaid id, else (for
 * diagrams without ids, like mindmaps) the one keyed by its visible label.
 */
export function detailFor(details: readonly DiagramDetail[], id: string | null, label: string): DiagramDetail | null {
  if (id !== null) {
    const byId = details.find((detail) => detail.key === id);
    if (byId !== undefined) return byId;
  }
  const normalize = (label: string) => label.replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = normalize(label);
  if (wanted === "") return null;
  return details.find((detail) => normalize(detail.key) === wanted) ?? null;
}

// ── Walkthrough ─────────────────────────────────────────────────────────

export interface WalkthroughStep {
  readonly title: string;
  readonly body: string;
  readonly code: string | null;
  readonly language: string | null;
}

/** Steps with a title, a body or code; a bare string is a step's body. Others are counted as skipped. */
export function parseSteps(value: Value | undefined): { steps: WalkthroughStep[]; skipped: number } {
  const steps: WalkthroughStep[] = [];
  let skipped = 0;
  for (const item of list(value)) {
    if (typeof item === "string" || typeof item === "number") {
      const body = String(item).trim();
      if (body === "") skipped += 1;
      else steps.push({ title: "", body, code: null, language: null });
      continue;
    }
    if (!isObject(item) || "kind" in item) {
      skipped += 1;
      continue;
    }
    const title = text(item.title).trim();
    const body = text(item.body ?? item.text).trim();
    const rawCode = optionalText(item.code);
    const code = rawCode === null || rawCode.trim() === "" ? null : rawCode.replace(/\n+$/, "");
    if (title === "" && body === "" && code === null) {
      skipped += 1;
      continue;
    }
    steps.push({ title, body, code, language: optionalText(item.language)?.trim() || null });
  }
  return { steps, skipped };
}

// ── List ────────────────────────────────────────────────────────────────

export interface ListRow {
  readonly title: string;
  readonly detail: string | null;
  readonly icon: string | null;
  /** A scalar, or a component such as a Badge. */
  readonly value: Value | null;
  readonly tone: Tone | null;
  readonly actions: readonly Action[];
}

/** Rows with a title; a bare scalar is a row's title. Items that are neither are dropped. */
export function parseListRows(value: Value | undefined): ListRow[] {
  return list(value).flatMap((item): ListRow[] => {
    if (typeof item === "string" || typeof item === "number") {
      const title = String(item).trim();
      return title === "" ? [] : [{ title, detail: null, icon: null, value: null, tone: null, actions: [] }];
    }
    if (!isObject(item) || "kind" in item) return [];
    const title = text(item.title ?? item.label).trim();
    if (title === "") return [];
    const rawValue = (item.value ?? null) as Value;
    const shown = rawValue === null || (typeof rawValue === "string" && rawValue.trim() === "") ? null : rawValue;
    return [
      {
        title,
        detail: optionalText(item.detail)?.trim() || null,
        icon: optionalText(item.icon)?.trim() || null,
        value: shown,
        tone: item.tone === undefined || item.tone === null ? null : tone(item.tone as Value),
        actions: Array.isArray(item.action) ? item.action.filter(isAction) : isAction(item.action) ? [item.action] : [],
      },
    ];
  });
}

/** The texts a row's Send actions send. */
export function sentTexts(actions: readonly Action[]): string[] {
  return actions.flatMap((action) => (action.type === "send" ? [action.text] : []));
}

// ── Calendar ────────────────────────────────────────────────────────────
//
// Dates are plain calendar days: {year, month, day} integers, never Date
// objects in local time, so no timezone can move an event to another day.
// Where a Date is needed (weekday, names), it is built and read in UTC.

export interface Day {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  readonly day: number;
}

export interface Month {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
}

export function daysInMonth({ year, month }: Month): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `yyyy-mm-dd` (a trailing time is ignored) as a real calendar day, or null. */
export function parseDay(value: unknown): Day | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth({ year, month })) return null;
  return { year, month, day };
}

/** `yyyy-mm` (or a full date) as a month, or null. */
export function parseMonth(value: unknown): Month | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{4})-(\d{1,2})(?:$|-|\s)/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey({ year, month, day }: Day): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function monthKey({ year, month }: Month): string {
  return `${year}-${pad(month)}`;
}

/** Months since year 0, for ordering and distances. */
export function monthIndex({ year, month }: Month): number {
  return year * 12 + month - 1;
}

export function fromMonthIndex(index: number): Month {
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

export function addMonths(month: Month, delta: number): Month {
  return fromMonthIndex(monthIndex(month) + delta);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday({ year, month, day }: Day): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Today on the user's wall clock. */
export function localToday(now: Date): Day {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * The weeks of a month as rows of seven, `null` outside the month, starting
 * on `firstDay` (0 = Sunday … 6 = Saturday).
 */
export function monthWeeks(month: Month, firstDay: number): (number | null)[][] {
  const lead = (weekday({ ...month, day: 1 }) - firstDay + 7) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth(month) }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** CLDR regions whose week starts on Sunday or Saturday; everywhere else it is Monday. */
const SUNDAY_REGIONS =
  "AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(" ");
const SATURDAY_REGIONS = "AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" ");

/** Week data on Intl.Locale: a method in Chromium and newer WebKit, a getter in older WebKit; ISO days, 7 = Sunday. */
interface WeekInfo {
  getWeekInfo?: () => { firstDay?: number };
  readonly weekInfo?: { firstDay?: number };
}

/** The first day of the week (0 = Sunday … 6 = Saturday) for a BCP 47 locale. */
export function firstWeekday(locale: string): number {
  let info: Intl.Locale;
  try {
    info = new Intl.Locale(locale);
  } catch {
    return 1;
  }
  try {
    const week = info as Intl.Locale & WeekInfo;
    const firstDay = (week.getWeekInfo?.() ?? week.weekInfo)?.firstDay;
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
  } catch {
    // Fall through to the region table.
  }
  // A locale without a region ("en", "ja") takes its likeliest one.
  const region = info.maximize().region ?? "";
  if (SUNDAY_REGIONS.includes(region)) return 0;
  if (SATURDAY_REGIONS.includes(region)) return 6;
  return 1;
}

export interface CalendarEvent {
  readonly day: Day;
  readonly key: string;
  readonly title: string;
  readonly tone: Tone;
}

/** Events with a valid date, in date order (stable within a day); untoned events take the accent. */
export function parseEvents(value: Value | undefined): { events: CalendarEvent[]; skipped: number } {
  const events: CalendarEvent[] = [];
  let skipped = 0;
  for (const item of list(value)) {
    const day = isObject(item) && !("kind" in item) ? parseDay(item.date) : null;
    if (day === null || !isObject(item) || "kind" in item) {
      skipped += 1;
      continue;
    }
    events.push({
      day,
      key: dayKey(day),
      title: text(item.title ?? item.label).trim(),
      tone: item.tone === undefined || item.tone === null ? "info" : tone(item.tone as Value),
    });
  }
  events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { events, skipped };
}

/** The months the calendar can show: from the first to the last event, widened to `month` when given. */
export function monthRange(events: readonly CalendarEvent[], requested: Month | null, today: Day): { first: Month; last: Month } {
  const indexes = events.map((event) => monthIndex(event.day));
  if (requested !== null) indexes.push(monthIndex(requested));
  if (indexes.length === 0) indexes.push(monthIndex(today));
  return { first: fromMonthIndex(Math.min(...indexes)), last: fromMonthIndex(Math.max(...indexes)) };
}

/** The month shown first: the requested one, else today's when events fall in it, else the first upcoming event's, else the last. */
export function initialMonth(events: readonly CalendarEvent[], requested: Month | null, today: Day): Month {
  if (requested !== null) return requested;
  if (events.length === 0) return today;
  const todayKey = dayKey(today);
  const thisMonth = monthKey(today);
  if (events.some((event) => monthKey(event.day) === thisMonth)) return today;
  const upcoming = events.find((event) => event.key >= todayKey) ?? events[events.length - 1]!;
  return upcoming.day;
}
