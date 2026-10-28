// Tracking data for Board, Roadmap and Status: reads what models write and
// what `bb tasks list --json`, `gh issue list --json` and `gh pr list --json`
// print into one card/item shape, and the calendar maths they share. Dates are
// whole days (days since 1970-01-01, UTC), so no timezone ever moves a due
// date; "today" is always passed in, never read from the clock here.
import { isPlainObject } from "./evaluate";
import type { Value } from "./types";

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const DAY_MS = 86_400_000;

/** A field of a loaded or written object: absent fields are undefined. */
type Field = Value | undefined;

/** A plain object's fields by key, or null for anything else (nodes, actions, lists, scalars). */
function record(value: Field): { readonly [key: string]: Value } | null {
  // Narrowing keeps structurally compatible Action shapes; widen to read by key.
  return value !== undefined && isPlainObject(value) ? value : null;
}

/** A trimmed string from a string or number; null for anything else or blank. */
function str(value: Field): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Days

/** `yyyy-mm-dd` (or an ISO date-time, read by its date part) as a day number; null for anything else or an impossible date. */
export function parseDay(value: Field): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY_MS;
}

/** The user's calendar day at `now` (their wall clock), as a day number. */
export function localDay(now: Date): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;
}

function utc(day: number): Date {
  return new Date(day * DAY_MS);
}

/** `2026-10-10`. */
export function isoDay(day: number): string {
  return utc(day).toISOString().slice(0, 10);
}

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Oct 10", with the year when it isn't `today`'s year. */
export function formatDay(day: number, today: number): string {
  return (utc(day).getUTCFullYear() === utc(today).getUTCFullYear() ? SHORT : LONG).format(utc(day));
}

/** "Sat, Oct 10, 2026": the exact date, for titles. */
export function fullDay(day: number): string {
  return WEEKDAY.format(utc(day));
}

/** "Oct 1 – Oct 20" (or one date when both are the same day). */
export function formatRange(start: number, end: number, today: number): string {
  return start === end ? formatDay(start, today) : `${formatDay(start, today)} – ${formatDay(end, today)}`;
}

/** Days in a duration as people say it: "1 day", "12 days", "3 weeks" (whole weeks only). */
export function formatDays(days: number): string {
  if (days >= 14 && days % 7 === 0) return plural(days / 7, "week");
  return plural(days, "day");
}

/**
 * A due date relative to `today`: "due today", "due tomorrow", "in 5 days",
 * "in 3 weeks", "in 4 months"; past it "1 day late", "3 days late", "2
 * weeks late". `late` is true for any past date (the caller decides whether
 * a finished item is late).
 */
export function relativeDue(due: number, today: number): { readonly text: string; readonly late: boolean } {
  const delta = due - today;
  if (delta === 0) return { text: "due today", late: false };
  if (delta === 1) return { text: "due tomorrow", late: false };
  const span = Math.abs(delta);
  const amount =
    span < 14 ? plural(span, "day") : span < 60 ? plural(Math.round(span / 7), "week") : plural(Math.round(span / 30.44), "month");
  return delta > 0 ? { text: `in ${amount}`, late: false } : { text: `${amount} late`, late: true };
}

/** Monday on or before `day`. */
function mondayOf(day: number): number {
  // Day 0 (1970-01-01) was a Thursday.
  return day - ((utc(day).getUTCDay() + 6) % 7);
}

function monthStart(day: number, add = 0): number {
  const date = utc(day);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + add, 1) / DAY_MS;
}

// ---------------------------------------------------------------------------
// People

/** A person from a name, a login, or `{name?, login?}` (GitHub's assignees and authors). */
function person(value: Field): string | null {
  const fields = record(value);
  if (fields !== null) return str(fields.name) ?? str(fields.login) ?? str(fields.displayName) ?? str(fields.email);
  return str(value)?.replace(/^@/, "") ?? null;
}

function people(value: Field): string[] {
  const all = Array.isArray(value) ? value.map(person) : [person(value)];
  return [...new Set(all.filter((name): name is string => name !== null))];
}

/** "Ana Lima" → "AL", "lukesandberg" → "L", "ana.lima@x.com" → "AL". */
export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0) return "?";
  const first = [...words[0]!][0]!;
  const last = words.length > 1 ? [...words[words.length - 1]!][0]! : "";
  return (first + last).toUpperCase();
}

// ---------------------------------------------------------------------------
// Board

export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export interface BoardLabel {
  readonly name: string;
  /** `#rrggbb` when the source gives a colour (GitHub does). */
  readonly color: string | null;
}

export interface BoardCard {
  /** Unique within the board, for React keys. */
  readonly id: string;
  /** What the card shows as its handle: `ORB-12`, `#99954`, an `id` given. */
  readonly key: string | null;
  readonly title: string;
  readonly status: string;
  readonly detail: string | null;
  readonly priority: Priority | null;
  readonly labels: readonly BoardLabel[];
  readonly owners: readonly string[];
  readonly due: number | null;
  readonly url: string | null;
  /** Agents working on a BB task now. */
  readonly agents: number;
  /** The parent task's key, for BB sub-tasks. */
  readonly parent: string | null;
  /** When GitHub last saw a change (ms), for issues and pull requests. */
  readonly updated: number | null;
  /** Finished one way or another (done, merged, closed, canceled): never late. */
  readonly closed: boolean;
}

export interface BoardColumn {
  readonly status: string;
  readonly label: string;
  readonly cards: readonly BoardCard[];
}

export type BoardSource = "list" | "tasks" | "issues" | "pulls";

export interface Board {
  readonly source: BoardSource;
  readonly columns: readonly BoardColumn[];
  /** Cards on the board (in the columns shown). */
  readonly total: number;
  /** Cards whose status is not among the `columns` asked for. */
  readonly hidden: number;
  /** Items left out for having no title. */
  readonly skipped: number;
  /** `bb tasks list` stopped at its limit: there are more tasks than these. */
  readonly truncated: boolean;
}

/** The known workflow, in order, with the label each column shows. */
const WORKFLOW: readonly (readonly [string, string])[] = [
  ["triage", "Triage"],
  ["backlog", "Backlog"],
  ["todo", "Todo"],
  ["draft", "Draft"],
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["in_review", "In review"],
  ["blocked", "Blocked"],
  ["done", "Done"],
  ["merged", "Merged"],
  ["closed", "Closed"],
  ["canceled", "Canceled"],
];
const WORKFLOW_LABEL: Readonly<Record<string, string>> = Object.fromEntries(WORKFLOW);
const WORKFLOW_ORDER: Readonly<Record<string, number>> = Object.fromEntries(WORKFLOW.map(([status], index) => [status, index]));
const NO_STATUS = "no_status";

const STATUS_ALIASES: Readonly<Record<string, string>> = {
  to_do: "todo",
  not_started: "todo",
  doing: "in_progress",
  started: "in_progress",
  active: "in_progress",
  wip: "in_progress",
  progress: "in_progress",
  review: "in_review",
  in_code_review: "in_review",
  code_review: "in_review",
  complete: "done",
  completed: "done",
  finished: "done",
  shipped: "done",
  resolved: "done",
  cancelled: "canceled",
  wontfix: "canceled",
  won_t_fix: "canceled",
  duplicate: "canceled",
};

/** Columns that hold finished work: their cards are never late. */
const CLOSED_STATUSES: Readonly<Record<string, true>> = { done: true, merged: true, closed: true, canceled: true };

/** A status as a column id: `In Progress`, `in-progress` and `doing` are all `in_progress`; unknown ones keep their own slug. */
export function boardStatus(value: Field): string {
  const raw = str(value);
  if (raw === null) return NO_STATUS;
  const slug = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  if (slug === "") return NO_STATUS;
  return STATUS_ALIASES[slug] ?? slug;
}

function statusLabel(status: string, given: ReadonlyMap<string, string>): string {
  if (status === NO_STATUS) return "No status";
  const known = Object.hasOwn(WORKFLOW_LABEL, status) ? WORKFLOW_LABEL[status] : undefined;
  if (known !== undefined) return known;
  const raw = given.get(status) ?? status.replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

const PRIORITY_ALIASES: Readonly<Record<string, Priority>> = {
  urgent: "urgent",
  critical: "urgent",
  p0: "urgent",
  high: "high",
  p1: "high",
  medium: "medium",
  normal: "medium",
  p2: "medium",
  low: "low",
  p3: "low",
  p4: "low",
  none: "none",
  no_priority: "none",
};

/** Linear's numbers too: 1 urgent, 2 high, 3 medium, 4 low, 0 none. */
export function priority(value: Field): Priority | null {
  if (typeof value === "number") return (["none", "urgent", "high", "medium", "low"] as const)[value] ?? null;
  const raw = str(value);
  if (raw === null) return null;
  return PRIORITY_ALIASES[raw.toLowerCase().replace(/[^a-z0-9]+/g, "_")] ?? null;
}

function hexColor(value: Field): string | null {
  const raw = str(value);
  if (raw === null) return null;
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(raw);
  return match === null ? null : `#${match[1]!.toLowerCase()}`;
}

function labels(value: Field): BoardLabel[] {
  const all = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: BoardLabel[] = [];
  for (const item of all) {
    const fields = record(item);
    const name = fields === null ? str(item) : str(fields.name);
    if (name === null || out.some((label) => label.name === name)) continue;
    out.push({ name, color: fields === null ? null : hexColor(fields.color) });
  }
  return out;
}

function webUrl(value: Field): string | null {
  const raw = str(value);
  return raw !== null && /^https?:\/\/\S+$/i.test(raw) ? raw : null;
}

function updatedAt(value: Field): number | null {
  const raw = str(value);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

type RawCard = Omit<BoardCard, "id" | "closed"> & { readonly given: string | null };

function listCard(value: Value): RawCard | null {
  if (typeof value === "string") {
    const title = str(value);
    return title === null ? null : { ...EMPTY_CARD, title };
  }
  const item = record(value);
  if (item === null) return null;
  const title = str(item.title) ?? str(item.name);
  if (title === null) return null;
  return {
    key: str(item.key) ?? str(item.id),
    title,
    status: boardStatus(item.status ?? item.state),
    given: str(item.status ?? item.state),
    detail: str(item.detail) ?? str(item.description) ?? str(item.note),
    priority: priority(item.priority),
    labels: labels(item.labels ?? item.tags),
    owners: people(item.owner ?? item.assignee ?? item.assignees),
    due: parseDay(item.due ?? item.dueDate),
    url: webUrl(item.url),
    agents: typeof item.agentsWorking === "number" && item.agentsWorking > 0 ? item.agentsWorking : 0,
    parent: null,
    updated: null,
  };
}

const EMPTY_CARD: RawCard = {
  key: null,
  title: "",
  status: NO_STATUS,
  given: null,
  detail: null,
  priority: null,
  labels: [],
  owners: [],
  due: null,
  url: null,
  agents: 0,
  parent: null,
  updated: null,
};

function taskCard(value: Value, parents: ReadonlyMap<string, string>): RawCard | null {
  const card = listCard(value);
  const item = record(value);
  if (card === null || item === null) return card;
  const parentId = str(item.parentTaskId);
  return { ...card, key: str(item.key) ?? card.key, parent: parentId === null ? null : (parents.get(parentId) ?? null) };
}

function githubCard(value: Value, pulls: boolean): RawCard | null {
  const item = record(value);
  if (item === null) return null;
  const title = str(item.title);
  if (title === null) return null;
  const state = str(item.state)?.toLowerCase() ?? null;
  const status = pulls && state === "open" && item.isDraft === true ? "draft" : boardStatus(state);
  const assignees = people(item.assignees);
  return {
    ...EMPTY_CARD,
    key: typeof item.number === "number" ? `#${item.number}` : null,
    title,
    status,
    given: state,
    detail: str(item.body),
    labels: labels(item.labels),
    // A pull request without assignees is its author's.
    owners: assignees.length === 0 && pulls ? people(item.author) : assignees,
    url: webUrl(item.url),
    updated: updatedAt(item.updatedAt),
  };
}

function isGithubItem(value: Value): boolean {
  const item = record(value);
  return item !== null && typeof item.number === "number" && typeof item.state === "string" && typeof item.title === "string";
}

function isPull(value: Value): boolean {
  const item = record(value);
  return (
    item !== null &&
    ("isDraft" in item || "mergedAt" in item || "headRefName" in item || item.state === "MERGED" || /\/pull\/\d+/.test(String(item.url ?? "")))
  );
}

/**
 * A board from a list of cards (`{title, status?, key?|id?, …}` or bare
 * titles), `bb tasks list --json` (`{tasks}`), or `gh issue list --json` /
 * `gh pr list --json`. `columns` names the statuses to show, in order (empty
 * ones too); without it the known workflow order applies, unknown statuses
 * follow in first-seen order, and empty columns are left out.
 */
export function readBoard(items: Field, columns?: Field): Read<Board> {
  let source: BoardSource = "list";
  let raw: (RawCard | null)[];
  let truncated = false;
  const report = record(items);
  const tasks = report?.tasks;
  if (report !== null && Array.isArray(tasks)) {
    source = "tasks";
    const parents = new Map<string, string>();
    for (const value of tasks as readonly Value[]) {
      const task = record(value);
      if (task === null) continue;
      const id = str(task.id);
      const key = str(task.key);
      if (id !== null && key !== null) parents.set(id, key);
    }
    raw = (tasks as readonly Value[]).map((task) => taskCard(task, parents));
    truncated = str(report.nextCursor) !== null;
  } else if (Array.isArray(items)) {
    const github = items.length > 0 && items.every(isGithubItem);
    const pulls = github && items.some(isPull);
    if (github) source = pulls ? "pulls" : "issues";
    raw = items.map((item) => (github ? githubCard(item, pulls) : listCard(item)));
  } else if (items === undefined || items === null) {
    return { ok: false, error: "Board needs a list of items, or Load a bb tasks or gh issue/pr list --json file" };
  } else {
    return {
      ok: false,
      error: "Board needs a list of {title, status?} items, bb tasks list --json ({tasks: […]}) or gh issue/pr list --json",
    };
  }

  const given = new Map<string, string>();
  const cards: BoardCard[] = [];
  const seen = new Map<string, number>();
  for (const card of raw) {
    if (card === null) continue;
    if (card.given !== null && !given.has(card.status)) given.set(card.status, card.given);
    const base = card.key ?? card.title;
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    const { given: _given, ...rest } = card;
    cards.push({ ...rest, id: repeat === 0 ? base : `${base}~${repeat}`, closed: Object.hasOwn(CLOSED_STATUSES, card.status) });
  }
  const skipped = raw.length - cards.length;

  const named = Array.isArray(columns) ? [...new Set(columns.map(boardStatus).filter((status) => status !== NO_STATUS))] : [];
  for (const column of Array.isArray(columns) ? columns : []) {
    const status = boardStatus(column);
    const text = str(column);
    if (text !== null && !given.has(status)) given.set(status, text);
  }
  const byStatus = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const bucket = byStatus.get(card.status);
    if (bucket === undefined) byStatus.set(card.status, [card]);
    else bucket.push(card);
  }
  let order: string[];
  if (named.length > 0) {
    order = named;
  } else {
    const firstSeen = [...byStatus.keys()];
    order = firstSeen.sort((a, b) => rank(a, firstSeen) - rank(b, firstSeen));
  }
  const shown = order.map((status) => ({ status, label: statusLabel(status, given), cards: byStatus.get(status) ?? [] }));
  const total = shown.reduce((sum, column) => sum + column.cards.length, 0);
  return { ok: true, value: { source, columns: shown, total, hidden: cards.length - total, skipped, truncated } };
}

/** Workflow statuses in their order, then unknown ones as first seen, then cards without a status. */
function rank(status: string, firstSeen: readonly string[]): number {
  if (status === NO_STATUS) return 10_000;
  return Object.hasOwn(WORKFLOW_ORDER, status) ? WORKFLOW_ORDER[status]! : 100 + firstSeen.indexOf(status);
}

/** A card is late when its due day has passed and it isn't finished. */
export function cardLate(card: BoardCard, today: number): boolean {
  return card.due !== null && !card.closed && card.due < today;
}

/** The column shown first on a narrow screen: where the work is happening, else the first one with cards. */
export function firstColumn(board: Board): number {
  const busy = ["in_progress", "in_review", "open", "todo"]
    .map((status) => board.columns.findIndex((column) => column.status === status && column.cards.length > 0))
    .find((index) => index >= 0);
  if (busy !== undefined) return busy;
  const filled = board.columns.findIndex((column) => column.cards.length > 0);
  return filled < 0 ? 0 : filled;
}

// ---------------------------------------------------------------------------
// Roadmap

export type RoadmapStatus = "done" | "active" | "planned" | "blocked" | "at-risk";

const ROADMAP_STATUS: Readonly<Record<string, RoadmapStatus>> = {
  done: "done",
  complete: "done",
  completed: "done",
  shipped: "done",
  active: "active",
  in_progress: "active",
  doing: "active",
  started: "active",
  on_track: "active",
  planned: "planned",
  todo: "planned",
  not_started: "planned",
  upcoming: "planned",
  blocked: "blocked",
  at_risk: "at-risk",
  risk: "at-risk",
  off_track: "at-risk",
  late: "at-risk",
};

export interface RoadmapItem {
  /** Position in the given list. */
  readonly index: number;
  readonly title: string;
  readonly lane: string;
  /** First day. */
  readonly start: number;
  /** Last day (inclusive); the same as `start` for a milestone. */
  readonly end: number;
  readonly milestone: boolean;
  readonly status: RoadmapStatus;
  readonly owner: string | null;
  /** 0–100; null when not given (and the item isn't done). */
  readonly progress: number | null;
  readonly detail: string | null;
  /** The title named in `after`, as written. */
  readonly after: string | null;
  /** The item `after` names, by `index`; null when it names nothing on the roadmap. */
  readonly afterIndex: number | null;
  /** Starts before the item it comes after has ended. */
  readonly overlap: boolean;
  /** Ended (or its milestone passed) before today without being done. */
  readonly late: boolean;
}

export interface RoadmapLane {
  readonly name: string;
  readonly items: readonly RoadmapItem[];
}

export type RoadmapScale = "days" | "weeks" | "months";

export interface RoadmapTick {
  readonly day: number;
  readonly label: string;
  /** A month or year boundary, drawn stronger. */
  readonly major: boolean;
}

export interface Roadmap {
  readonly lanes: readonly RoadmapLane[];
  readonly items: readonly RoadmapItem[];
  /** The axis: first day shown, and the day after the last. */
  readonly from: number;
  readonly to: number;
  readonly scale: RoadmapScale;
  readonly ticks: readonly RoadmapTick[];
  readonly today: number;
  readonly skipped: readonly { readonly title: string; readonly reason: string }[];
}

function roadmapStatus(value: Field): RoadmapStatus | null {
  const raw = str(value);
  if (raw === null) return null;
  return ROADMAP_STATUS[raw.toLowerCase().replace(/[^a-z0-9]+/g, "_")] ?? null;
}

/** 0–100 from a number or "60%"; fractions below 1 are read as shares (0.6 → 60). */
function percent(value: Field): number | null {
  let number: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) number = value;
  else if (typeof value === "string" && /^\s*\d+(\.\d+)?\s*%?\s*$/.test(value)) number = Number.parseFloat(value);
  if (number === null) return null;
  if (number > 0 && number < 1 && !(typeof value === "string" && value.includes("%"))) number *= 100;
  return Math.min(100, Math.max(0, number));
}

/** A share of the axis, 0–1, for a day (the start of that day). */
export function axisShare(day: number, roadmap: Pick<Roadmap, "from" | "to">): number {
  return (day - roadmap.from) / (roadmap.to - roadmap.from);
}

/** The scale an axis of `span` days reads best in. */
export function roadmapScale(span: number): RoadmapScale {
  return span <= 31 ? "days" : span <= 182 ? "weeks" : "months";
}

function axis(lo: number, hi: number, today: number): Pick<Roadmap, "from" | "to" | "scale" | "ticks"> {
  // Today joins the axis when it is near the plan, so the line has a place.
  const span = Math.max(1, hi - lo);
  if (today >= lo - span * 0.3 && today < lo) lo = today;
  if (today >= hi && today < hi + span * 0.3) hi = today + 1;
  const scale = roadmapScale(hi - lo);
  const ticks: RoadmapTick[] = [];
  let from: number;
  let to: number;
  if (scale === "days") {
    from = lo - 1;
    to = hi + 1;
    for (let day = from; day < to; day += 1) {
      const first = utc(day).getUTCDate() === 1 || day === from;
      ticks.push({ day, label: first ? SHORT.format(utc(day)) : String(utc(day).getUTCDate()), major: utc(day).getUTCDate() === 1 });
    }
  } else if (scale === "weeks") {
    from = mondayOf(lo);
    to = mondayOf(hi - 1) + 7;
    let month = -1;
    for (let day = from; day < to; day += 7) {
      const date = utc(day);
      const newMonth = date.getUTCMonth() !== month;
      month = date.getUTCMonth();
      ticks.push({ day, label: newMonth ? SHORT.format(date) : String(date.getUTCDate()), major: newMonth && day !== from });
    }
  } else {
    from = monthStart(lo);
    to = monthStart(hi - 1, 1);
    for (let day = from; day < to; day = monthStart(day, 1)) {
      const january = utc(day).getUTCMonth() === 0;
      ticks.push({ day, label: (january || day === from ? MONTH_YEAR : MONTH).format(utc(day)), major: january });
    }
  }
  return { from, to, scale, ticks };
}

/**
 * A roadmap from `{title, start, end | days, lane? | group?, status?,
 * owner?, milestone?, after?, progress?}` items (dates `yyyy-mm-dd`). A
 * milestone is `milestone: "yyyy-mm-dd"` (or `milestone: true` with `start`).
 * `days` counts the start day (start + 1 day ends the same day). Without a
 * status an item is done at 100 %, active when today is inside it, else
 * planned. Items with no usable dates are left out and listed in `skipped`.
 */
export function readRoadmap(items: Field, today: number): Read<Roadmap> {
  if (!Array.isArray(items)) return { ok: false, error: "Roadmap needs a list of {title, start, end} items" };
  const skipped: { title: string; reason: string }[] = [];
  type Draft = Omit<RoadmapItem, "afterIndex" | "overlap" | "late">;
  const drafts: Draft[] = [];
  items.forEach((value, index) => {
    const item = record(value);
    if (item === null) {
      skipped.push({ title: str(value) ?? `Item ${index + 1}`, reason: "not an item" });
      return;
    }
    const title = str(item.title) ?? str(item.name);
    if (title === null) {
      skipped.push({ title: `Item ${index + 1}`, reason: "no title" });
      return;
    }
    const milestoneDay = parseDay(item.milestone);
    const milestone = milestoneDay !== null || item.milestone === true;
    let start = milestoneDay ?? parseDay(item.start ?? item.from ?? item.date);
    let end: number | null;
    if (milestone) {
      end = start;
    } else {
      end = parseDay(item.end ?? item.to ?? item.due);
      const days = typeof item.days === "number" && Number.isFinite(item.days) && item.days >= 1 ? Math.round(item.days) : null;
      if (end === null && start !== null && days !== null) end = start + days - 1;
      if (start === null && end !== null && days !== null) start = end - days + 1;
    }
    if (start === null || end === null) {
      skipped.push({ title, reason: start === null ? "no start date (yyyy-mm-dd)" : "no end date or days" });
      return;
    }
    if (end < start) {
      skipped.push({ title, reason: `ends (${isoDay(end)}) before it starts (${isoDay(start)})` });
      return;
    }
    const given = roadmapStatus(item.status);
    const progressGiven = percent(item.progress);
    const status: RoadmapStatus =
      given ?? (progressGiven === 100 ? "done" : today >= start && today <= end && !milestone ? "active" : "planned");
    drafts.push({
      index,
      title,
      lane: str(item.lane) ?? str(item.group) ?? "",
      start,
      end,
      milestone,
      status,
      owner: person(item.owner ?? item.assignee),
      progress: progressGiven ?? (status === "done" && !milestone ? 100 : null),
      detail: str(item.detail) ?? str(item.note) ?? str(item.description),
      after: str(item.after) ?? str(item.dependsOn) ?? str(item.depends),
    });
  });
  if (drafts.length === 0) {
    return items.length === 0
      ? { ok: true, value: { lanes: [], items: [], from: today, to: today + 1, scale: "days", ticks: [], today, skipped } }
      : { ok: false, error: `No roadmap item has usable dates: ${skipped[0]!.title} has ${skipped[0]!.reason}` };
  }

  const byTitle = new Map<string, Draft>();
  for (const draft of drafts) {
    const key = draft.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, draft);
  }
  const resolved: RoadmapItem[] = drafts.map((draft) => {
    const before = draft.after === null ? undefined : byTitle.get(draft.after.toLowerCase());
    const predecessor = before === undefined || before === draft ? null : before;
    return {
      ...draft,
      afterIndex: predecessor?.index ?? null,
      overlap: predecessor !== null && (predecessor.milestone ? draft.start < predecessor.end : draft.start <= predecessor.end),
      late: draft.status !== "done" && draft.end < today,
    };
  });

  const laneOrder: string[] = [];
  const byLane = new Map<string, RoadmapItem[]>();
  for (const item of resolved) {
    const bucket = byLane.get(item.lane);
    if (bucket === undefined) {
      laneOrder.push(item.lane);
      byLane.set(item.lane, [item]);
    } else bucket.push(item);
  }
  const lo = Math.min(...resolved.map((item) => item.start));
  const hi = Math.max(...resolved.map((item) => item.end)) + 1;
  return {
    ok: true,
    value: {
      lanes: laneOrder.map((name) => ({ name, items: byLane.get(name)! })),
      items: resolved,
      ...axis(lo, hi, today),
      today,
      skipped,
    },
  };
}

export const ROADMAP_STATUS_LABEL: Readonly<Record<RoadmapStatus, string>> = {
  done: "Done",
  active: "Active",
  planned: "Planned",
  blocked: "Blocked",
  "at-risk": "At risk",
};

/** Days an item spans, counting both ends. */
export function itemDays(item: Pick<RoadmapItem, "start" | "end">): number {
  return item.end - item.start + 1;
}

// ---------------------------------------------------------------------------
// Status

export type Health = "off-track" | "blocked" | "at-risk" | "on-track" | "not-started" | "done";

const HEALTH_ALIASES: Readonly<Record<string, Health>> = {
  on_track: "on-track",
  ontrack: "on-track",
  green: "on-track",
  good: "on-track",
  healthy: "on-track",
  active: "on-track",
  in_progress: "on-track",
  at_risk: "at-risk",
  atrisk: "at-risk",
  risk: "at-risk",
  yellow: "at-risk",
  amber: "at-risk",
  warn: "at-risk",
  warning: "at-risk",
  off_track: "off-track",
  offtrack: "off-track",
  red: "off-track",
  behind: "off-track",
  late: "off-track",
  bad: "off-track",
  done: "done",
  complete: "done",
  completed: "done",
  shipped: "done",
  blocked: "blocked",
  not_started: "not-started",
  notstarted: "not-started",
  planned: "not-started",
  todo: "not-started",
  upcoming: "not-started",
};

/** Worst first: what needs attention, then what is fine, then what is finished. */
export const HEALTH_ORDER: readonly Health[] = ["off-track", "blocked", "at-risk", "on-track", "not-started", "done"];

export const HEALTH_LABEL: Readonly<Record<Health, string>> = {
  "off-track": "Off track",
  blocked: "Blocked",
  "at-risk": "At risk",
  "on-track": "On track",
  "not-started": "Not started",
  done: "Done",
};

export function health(value: Field): Health | null {
  const raw = str(value);
  if (raw === null) return null;
  return HEALTH_ALIASES[raw.toLowerCase().replace(/[^a-z0-9]+/g, "_")] ?? null;
}

export interface HealthItem {
  readonly index: number;
  readonly name: string;
  /** Null for a status the reader doesn't know; `given` keeps its text. */
  readonly status: Health | null;
  readonly given: string | null;
  readonly progress: number | null;
  readonly owner: string | null;
  readonly due: number | null;
  readonly note: string | null;
  /** Past due and not done. */
  readonly late: boolean;
}

export interface HealthReport {
  /** Worst first (see HEALTH_ORDER); unknown statuses after at-risk; the given order within each status. */
  readonly items: readonly HealthItem[];
  /** Counts per status in the strip's reading order, non-zero only. */
  readonly counts: readonly { readonly status: Health; readonly count: number }[];
  readonly unknown: number;
  readonly skipped: number;
}

/** The summary strip's reading order. */
const STRIP_ORDER: readonly Health[] = ["on-track", "at-risk", "off-track", "blocked", "not-started", "done"];

function healthRank(status: Health | null): number {
  return status === null ? HEALTH_ORDER.indexOf("at-risk") + 0.5 : HEALTH_ORDER.indexOf(status);
}

/** A health report from `{name, status, progress?, owner?, due?, note?}` items, worst first. */
export function readStatus(items: Field, today: number): Read<HealthReport> {
  if (!Array.isArray(items)) return { ok: false, error: "Status needs a list of {name, status} items" };
  const read: HealthItem[] = [];
  items.forEach((value, index) => {
    const item = record(value);
    if (item === null) return;
    const name = str(item.name) ?? str(item.title);
    if (name === null) return;
    const status = health(item.status);
    const due = parseDay(item.due ?? item.dueDate);
    read.push({
      index,
      name,
      status,
      given: str(item.status),
      progress: percent(item.progress),
      owner: person(item.owner ?? item.assignee),
      due,
      note: str(item.note) ?? str(item.detail),
      late: due !== null && due < today && status !== "done",
    });
  });
  const sorted = [...read].sort((a, b) => healthRank(a.status) - healthRank(b.status) || a.index - b.index);
  const counts = STRIP_ORDER.map((status) => ({ status, count: read.filter((item) => item.status === status).length })).filter(
    (entry) => entry.count > 0,
  );
  return {
    ok: true,
    value: { items: sorted, counts, unknown: read.filter((item) => item.status === null).length, skipped: items.length - read.length },
  };
}

/** "4 on track · 1 at risk · 1 off track". */
export function healthSummary(report: HealthReport): string {
  const parts = report.counts.map(({ status, count }) => `${count} ${HEALTH_LABEL[status].toLowerCase()}`);
  if (report.unknown > 0) parts.push(`${report.unknown} other`);
  return parts.join(" · ");
}
