import { age } from "../contract/queue.ts";
import { ANSWER_MAX_ATTEMPTS } from "./asks.ts";
import type { CrewThread, ListedThread } from "./crew.ts";
import { ROLE_SPECS, SHIP_READY_REVIEWS } from "./roles.ts";
import type { Ask } from "./store.ts";
import type { CrewRow } from "./tasks-client.ts";

/**
 * `bb captain status` derives every row on each read from the Captain's
 * children, their Tasks rows, their pending interactions and the asks. Nothing
 * here is stored, so it cannot drift from what it describes.
 */

export const ROW_STATES = [
  "health",
  "ask",
  "undelivered",
  "blocked",
  "failed",
  "undeliverable",
  "stalled",
  "ready",
  "working",
  "waiting",
  "idle",
  "archived",
] as const;
export type RowState = (typeof ROW_STATES)[number];

/** Rows that need the Captain to act; the default read shows only these. */
const ACTION: ReadonlySet<RowState> = new Set([
  "health",
  "ask",
  "undelivered",
  "blocked",
  "failed",
  "undeliverable",
  "stalled",
  "ready",
]);
/** Rows that time passing or an interaction makes: `--since` always returns them. */
const ALWAYS: ReadonlySet<RowState> = new Set([
  "health",
  "undelivered",
  "blocked",
  "undeliverable",
  "stalled",
]);

export type StatusRow = {
  /** The first token: task key, thread id or ask id. */
  id: string;
  state: RowState;
  thread: string | null;
  role: string | null;
  task: string | null;
  /** Full commit id a ship ask or ready task names; null for other rows. */
  head: string | null;
  note: string;
  /** Epoch ms the row's age counts from. */
  since: number | null;
  /** Epoch ms its sources last changed, for the cursor; null when time alone makes it. */
  changedAt: number | null;
};

export type StatusInput = {
  now: number;
  /** The Captain's own thread, for its health row; null when it was not read. */
  captain: Pick<ListedThread, "id" | "status" | "updatedAt"> | null;
  crew: readonly CrewThread[];
  /** Archived children, read only for `--all`. */
  archived: readonly CrewThread[];
  /** Pending interaction lines per blocked thread, with when each began. */
  interactions: ReadonlyMap<string, { note: string; createdAt: number }[]>;
  asks: readonly Ask[];
  /**
   * Task rows of every thread this Captain ever ran, archived crew included,
   * so a task's ready row outlives the threads that made it ready.
   */
  taskRows: readonly CrewRow[];
  since: number | null;
  all: boolean;
};

/** How long background commands alone keep a thread that owes a report from reading as stalled. */
export const COMMAND_ALLOWANCE_MS = 30 * 60_000;

export type Status = { counts: Record<RowState, number>; rows: StatusRow[]; cursor: string };

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : 0);

/** The newest of a Tasks row's source times. */
function rowChangedAt(row: CrewRow): number {
  return Math.max(
    ms(row.task.updatedAt),
    ms(row.parentTask?.updatedAt),
    ms(row.updatedAt),
    ms(row.lastNotifyingComment?.createdAt),
  );
}

export function deriveStatus(input: StatusInput): Status {
  const rows: StatusRow[] = [];
  if (input.captain?.status === "error") {
    rows.push({
      id: input.captain.id,
      state: "health",
      thread: input.captain.id,
      role: null,
      task: null,
      head: null,
      note: "Captain thread errored",
      since: input.captain.updatedAt,
      changedAt: null,
    });
  }
  for (const ask of input.asks) {
    if (ask.answer !== null && ask.answerDeliveredAt !== null) continue;
    rows.push(askRow(ask));
  }

  // Review running: a working thread with the Review role on the task.
  const reviewing = new Set(
    input.crew
      .filter((member) => member.role === "review" && crewState(member, input.now) === "working")
      .flatMap((member) => member.rows.map((row) => row.task.key)),
  );
  for (const member of input.crew) rows.push(threadRow(member, input, reviewing));
  for (const member of input.archived) {
    rows.push({ ...threadRow(member, input, reviewing), state: "archived" });
  }

  // Ready to ship is a task's state, one row per task whatever its thread count.
  const tasks = new Map<string, CrewRow>();
  for (const row of input.taskRows) {
    const current = tasks.get(row.task.key);
    if (current === undefined || ms(row.task.updatedAt) > ms(current.task.updatedAt)) {
      tasks.set(row.task.key, row);
    }
  }
  for (const row of tasks.values()) {
    const review = row.fields.find((field) => field.key === "review");
    if (review === undefined || !SHIP_READY_REVIEWS.has(review.value)) continue;
    if (row.task.status === "done" || row.task.status === "canceled") continue;
    rows.push({
      id: row.task.key,
      state: "ready",
      thread: null,
      role: null,
      task: row.task.key,
      head: review.head,
      note: `review ${review.value}${review.head === null ? "" : ` @${review.head}`} · ${row.task.status}`,
      since: ms(review.writtenAt),
      changedAt: rowChangedAt(row),
    });
  }

  const counts = Object.fromEntries(ROW_STATES.map((state) => [state, 0])) as Record<
    RowState,
    number
  >;
  for (const row of rows) counts[row.state] += 1;
  const latest = Math.max(0, ...rows.map((row) => row.changedAt ?? 0));
  const shown = rows.filter((row) => {
    if (row.state === "archived" && !input.all) return false;
    if (input.since !== null) {
      return ALWAYS.has(row.state) || (row.changedAt !== null && row.changedAt > input.since);
    }
    return input.all || ACTION.has(row.state);
  });
  const order = (state: RowState) => ROW_STATES.indexOf(state);
  shown.sort((a, b) => order(a.state) - order(b.state) || (a.since ?? 0) - (b.since ?? 0));
  return { counts, rows: shown, cursor: encodeCursor(latest) };
}

function askRow(ask: Ask): StatusRow {
  const base = { id: ask.id, thread: null, role: null, task: ask.taskKey, head: ask.head };
  const changedAt = Math.max(ask.askedAt, ask.answeredAt ?? 0);
  const at = ask.head === null ? "" : ` @${ask.head}`;
  if (ask.answer === null) {
    return { ...base, state: "ask", note: `${ask.text}${at}`, since: ask.askedAt, changedAt };
  }
  const answer = JSON.stringify(ask.answer);
  if (ask.deliveryAttempts >= ANSWER_MAX_ATTEMPTS) {
    return {
      ...base,
      state: "health",
      note: `answer ${answer} not delivered after ${ask.deliveryAttempts} sends${at}; retry: bb captain ask resolve ${ask.id} --answer ${answer}`,
      since: ask.answeredAt,
      changedAt,
    };
  }
  return {
    ...base,
    state: "undelivered",
    note: `answer ${answer} not delivered · ${ask.text}${at}`,
    since: ask.answeredAt,
    changedAt,
  };
}

/**
 * A crew thread's state, by precedence: an interaction pauses it whatever its
 * run state. `status`, `tell --stalled` and the background check all read it
 * here, so they never disagree about which thread is stalled.
 */
export function crewState(member: CrewThread, now: number): RowState {
  const { thread, crewRole } = member;
  if (thread.hasPendingInteraction) return "blocked";
  if (thread.status === "error") return "failed";
  if (member.rows[0]?.lastNotifyingComment?.delivery.state === "undeliverable")
    return "undeliverable";
  if (thread.status !== "idle") return "working";
  const { activeBackgroundAgentCount, activeWorkflowCount, activeBackgroundCommandCount } =
    thread.activity;
  // Background agents and workflows exempt a thread without limit.
  if (activeBackgroundAgentCount + activeWorkflowCount > 0) return "waiting";
  const due = crewRole?.reportDueSince ?? null;
  const owes = due !== null && !reportedSince(member, due);
  // A background command only for a while: a dev server left running would
  // otherwise hide a missing report for good.
  if (activeBackgroundCommandCount > 0 && !(owes && commandAllowanceSpent(member, now))) {
    return "waiting";
  }
  return owes ? "stalled" : "idle";
}

function commandAllowanceSpent(member: CrewThread, now: number): boolean {
  return member.commandSeenAt !== null && now - member.commandSeenAt >= COMMAND_ALLOWANCE_MS;
}

/** Whether the thread posted a notifying comment at or after the report-due mark. */
export function reportedSince(member: CrewThread, due: number): boolean {
  return member.rows.some(
    (row) => row.lastNotifyingComment !== null && ms(row.lastNotifyingComment.createdAt) >= due,
  );
}

function threadRow(
  member: CrewThread,
  input: StatusInput,
  reviewing: ReadonlySet<string>,
): StatusRow {
  const { thread } = member;
  const row = member.rows[0];
  const state = crewState(member, input.now);
  const role = member.role === null ? null : ROLE_SPECS[member.role].label;
  const parts: string[] = [];
  let since: number | null = thread.updatedAt;
  switch (state) {
    case "blocked": {
      const pending = input.interactions.get(thread.id) ?? [];
      parts.push(pending.map((entry) => entry.note).join("; ") || "pending interaction");
      since = pending[0]?.createdAt ?? since;
      break;
    }
    case "failed":
      parts.push("errored");
      break;
    case "undeliverable":
      parts.push(
        `report undeliverable: ${row?.lastNotifyingComment?.delivery.reason ?? "unknown"}`,
      );
      break;
    case "waiting": {
      const {
        activeBackgroundAgentCount: agents,
        activeWorkflowCount: flows,
        activeBackgroundCommandCount: commands,
      } = thread.activity;
      parts.push(
        [
          agents > 0 ? `${agents} background agent${agents === 1 ? "" : "s"}` : null,
          flows > 0 ? `${flows} workflow${flows === 1 ? "" : "s"}` : null,
          commands > 0 ? `${commands} background command${commands === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(", "),
      );
      break;
    }
    case "stalled":
      since = member.crewRole?.reportDueSince ?? since;
      parts.push(
        thread.activity.activeBackgroundCommandCount > 0
          ? "idle with a background command past 30m, no report since it fell due"
          : "idle, no report since it fell due",
      );
      break;
    default:
      if (row?.lastNotifyingComment)
        parts.push(`reported ${age(input.now, ms(row.lastNotifyingComment.createdAt))} ago`);
  }
  if (row !== undefined) {
    parts.push(row.task.status);
    const review = row.fields.find((field) => field.key === "review");
    if (review !== undefined) parts.push(`review ${review.value}`);
    if (member.role !== "review" && reviewing.has(row.task.key)) parts.push("review running");
  } else parts.push("on no task");
  return {
    id: row?.task.key ?? thread.id,
    state,
    thread: thread.id,
    role,
    task: row?.task.key ?? null,
    head: null,
    note: parts.filter((part) => part !== "").join(" · "),
    since,
    changedAt: row === undefined ? thread.createdAt : rowChangedAt(row),
  };
}

export { age };

export function encodeCursor(at: number): string {
  return `c_${Math.max(0, Math.floor(at)).toString(36)}`;
}

export function decodeCursor(cursor: string): number | null {
  const match = /^c_([0-9a-z]+)$/u.exec(cursor.trim());
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 36);
}

/** The counts line: nonzero counts in row order, then the cursor. */
export function countsLine(status: Status): string {
  const parts = ROW_STATES.filter((state) => status.counts[state] > 0).map((state) => {
    const count = status.counts[state];
    return `${count} ${state === "ask" && count !== 1 ? "asks" : state}`;
  });
  return [...(parts.length === 0 ? ["no crew or asks"] : parts), `cursor ${status.cursor}`].join(
    " · ",
  );
}

/** One line per row, ids first: `PLUG-19  blocked  thr_ghi  Implement  <note>  40m`. */
export function rowLine(row: StatusRow, now: number): string {
  const middle =
    row.state === "ask" || row.state === "undelivered" || row.state === "ready"
      ? [row.task ?? "-"]
      : [row.thread ?? "-", row.role ?? "-"];
  const cells =
    row.state === "ready" || row.state === "health"
      ? [row.id, row.state, row.note]
      : [row.id, row.state, ...middle, row.note];
  if (row.since !== null) cells.push(age(now, row.since));
  return cells.join("  ");
}
