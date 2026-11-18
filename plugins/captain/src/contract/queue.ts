/**
 * The Needs you queue as the app and the server share it: the item shapes and
 * the one order every reader shows them in. Pure, so the app bundle imports it
 * without the server.
 */

export const ASK_KINDS = ["decision", "ship", "access", "improve"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** An open ask, or one answered and still `Sending…` to the Captain. */
export type AskItem = {
  kind: "ask";
  /** `ask:<id>`. */
  key: string;
  id: string;
  askKind: AskKind;
  text: string;
  detail: string;
  /** The first is recommended. */
  options: string[];
  task: string | null;
  since: number;
  /** Set once answered; the item stays, `Sending…`, until the Captain has it. */
  answer: string | null;
  snoozedUntil: number | null;
  skipOrder: number | null;
};

/** A crew thread paused on a bb interaction: a form, an approval or a question. */
export type BlockedItem = {
  kind: "blocked";
  /** `blocked:<interaction id>`. */
  key: string;
  threadId: string;
  title: string;
  /** The interaction payload's kind, such as `approval` or `form`. */
  interactionKind: string;
  task: string | null;
  role: string | null;
  since: number;
  snoozedUntil: number | null;
  skipOrder: number | null;
};

export type HealthAction =
  | { kind: "retry-thread"; threadId: string }
  | { kind: "retry-answer"; askId: string; answer: string }
  | { kind: "open-thread"; threadId: string };

/** Something wrong with the threads that watch everyone else. */
export type HealthItem = {
  kind: "health";
  /** `health:<…>`. */
  key: string;
  title: string;
  detail: string | null;
  task: string | null;
  since: number | null;
  action: HealthAction | null;
  snoozedUntil: number | null;
  skipOrder: number | null;
};

export type QueueItem = AskItem | BlockedItem | HealthItem;

/** Health first, then paused crew, then asks by kind; oldest first within each. */
const RANK: Record<AskKind | "health" | "blocked", number> = {
  health: 0,
  blocked: 1,
  access: 2,
  ship: 3,
  decision: 4,
  improve: 5,
};

export const LATER_MS = 60 * 60_000;

export function isSending(item: QueueItem): boolean {
  return item.kind === "ask" && item.answer !== null;
}

/**
 * The queue as the banner walks it: items under Later hidden, skipped items
 * behind the rest in the order they were skipped, and answers still sending
 * last, so the next item shows while they go.
 */
export function orderQueue(items: readonly QueueItem[], now: number): QueueItem[] {
  const rank = (item: QueueItem) => RANK[item.kind === "ask" ? item.askKind : item.kind];
  return items
    .filter((item) => item.snoozedUntil === null || item.snoozedUntil <= now)
    .toSorted(
      (a, b) =>
        Number(isSending(a)) - Number(isSending(b)) ||
        (a.skipOrder ?? 0) - (b.skipOrder ?? 0) ||
        rank(a) - rank(b) ||
        (a.since ?? 0) - (b.since ?? 0) ||
        a.key.localeCompare(b.key),
    );
}

/** The soonest Later that ends, so the banner can show that item again on time. */
export function nextWake(items: readonly QueueItem[], now: number): number | null {
  const ends = items.flatMap((item) =>
    item.snoozedUntil !== null && item.snoozedUntil > now ? [item.snoozedUntil] : [],
  );
  return ends.length === 0 ? null : Math.min(...ends);
}

/** `2h`, `40m`: an item's age. */
export function age(now: number, since: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
