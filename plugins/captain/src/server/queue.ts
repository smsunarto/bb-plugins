import {
  LATER_MS,
  orderQueue,
  type AskItem,
  type BlockedItem,
  type HealthItem,
} from "../contract/queue.ts";
import {
  asksTag,
  crewTag,
  sinceTag,
  TASK_PHASES,
  type BannerTask,
  type ChangeRef,
} from "../contract/rpc.ts";
import { ANSWER_MAX_ATTEMPTS } from "./asks.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { joinCrew, listChildren, readInteractions, type ListedThread } from "./crew.ts";
import { ROLE_SPECS, SHIP_READY_REVIEWS } from "./roles.ts";
import { crewState } from "./status.ts";
import { NOTICE, type Ask } from "./store.ts";
import { TasksError, type CrewRow } from "./tasks-client.ts";

/**
 * The Needs you banner's reads and writes. What counts as needing the user is
 * decided where `status` decides it: `crewState` for crew, the delivery
 * attempts for answers. Order is the app's, in `contract/queue.ts`.
 */

export type QueueDeps = Pick<CommandDeps, "bb" | "store" | "registry" | "tasks" | "now">;

/** bb's own reads for the banner; a hung read must not hold the card. */
export const READ_DEADLINE_MS = 8_000;

/**
 * A Captain's unarchived crew, and their Tasks rows once the crew is listed.
 * Two promises, so a caller that needs only the threads, such as the banner's
 * interaction read, starts as soon as they are listed rather than waiting for
 * Tasks.
 */
export type CrewSnapshot = { threads: Promise<ListedThread[]>; rows: Promise<CrewRow[]> };

/**
 * List the Captain's crew under bb's read deadline, then join their Tasks
 * rows. Tasks only names the rows' tasks, so a Tasks failure keeps every
 * thread with no rows.
 */
export function readCrewSnapshot(
  deps: Pick<QueueDeps, "bb" | "tasks">,
  captainId: string,
): CrewSnapshot {
  const threads = listChildren(deps.bb, captainId, false, AbortSignal.timeout(READ_DEADLINE_MS));
  const rows = threads.then((listed) =>
    listed.length === 0
      ? []
      : deps.tasks.crewSnapshot(listed.map((thread) => thread.id)).catch((error: unknown) => {
          if (!(error instanceof TasksError)) throw error;
          deps.bb.log.warn(`crew read without Tasks: ${error.message}`);
          return [] as CrewRow[];
        }),
  );
  // A caller that stops at a failed listing never awaits the rows; the failure is its.
  rows.catch(() => undefined);
  return { threads, rows };
}

/**
 * One crew read for every RPC that needs it: the banner's `crew` and the
 * Overview's `crewThreads` carry the same tag, so one change refreshes both
 * at once. A read in flight is shared by the calls that arrive while it runs;
 * once both its parts settle, the next call reads afresh. `changed` drops a
 * read in flight, so a call after a change never gets the read from before it.
 */
export function createCrewReads(deps: Pick<QueueDeps, "bb" | "tasks">) {
  const inFlight = new Map<string, CrewSnapshot>();
  return {
    read(captainId: string): CrewSnapshot {
      const running = inFlight.get(captainId);
      if (running !== undefined) return running;
      const read = readCrewSnapshot(deps, captainId);
      inFlight.set(captainId, read);
      const settle = () => {
        if (inFlight.get(captainId) === read) inFlight.delete(captainId);
      };
      // The rows settle after the threads, and fail when the listing does.
      read.rows.then(settle, settle);
      return read;
    },
    changed(captainId: string): void {
      inFlight.delete(captainId);
    },
  };
}

export type CrewReads = ReturnType<typeof createCrewReads>;

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : 0);

/** Tasks own the work status. A crew thread can be idle while its task is still in progress. */
export async function bannerTasks(
  deps: Pick<QueueDeps, "store">,
  crew: CrewSnapshot,
): Promise<BannerTask[]> {
  const [threads, rows] = await Promise.all([crew.threads, crew.rows]);
  const tasks = new Map<string, BannerTask>();
  for (const member of joinCrew(deps, threads, rows)) {
    for (const { task } of member.rows) {
      if (task.status !== "in_progress" && task.status !== "in_review") continue;
      const entry = tasks.get(task.key) ?? {
        key: task.key,
        title: task.title,
        status: task.status,
        roles: [],
        updatedAt: ms(task.updatedAt) || 0,
      };
      for (const phase of TASK_PHASES) {
        if (phase === member.role && !entry.roles.includes(phase)) entry.roles.push(phase);
      }
      tasks.set(task.key, entry);
    }
  }
  return [...tasks.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
  );
}

/** Open asks, and answered ones until the Captain has them: from `data.db` alone. */
export function askItems(
  deps: Pick<QueueDeps, "store">,
  captainId: string,
): (AskItem | HealthItem)[] {
  return deps.store
    .asksOf(captainId)
    .filter((ask) => ask.answer === null || ask.answerDeliveredAt === null)
    .map((ask) =>
      ask.answer !== null && ask.deliveryAttempts >= ANSWER_MAX_ATTEMPTS
        ? answerHealth(deps, ask, ask.answer)
        : askItem(ask),
    );
}

function askItem(ask: Ask): AskItem {
  return {
    kind: "ask",
    key: `ask:${ask.id}`,
    id: ask.id,
    askKind: ask.kind,
    text: ask.text,
    detail: ask.detail,
    options: ask.options,
    task: ask.taskKey,
    since: ask.askedAt,
    answer: ask.answer,
    snoozedUntil: ask.snoozedUntil,
    skipOrder: ask.skipOrder,
  };
}

/** An answer past its send cap: a health row, retried by answering again. */
function answerHealth(deps: Pick<QueueDeps, "store">, ask: Ask, answer: string): HealthItem {
  const key = NOTICE.answerHealth(ask.id);
  return {
    kind: "health",
    key,
    title: "Answer not delivered",
    detail: `${ask.text} · ${answer} · ${ask.deliveryAttempts} sends failed`,
    task: ask.taskKey,
    since: ask.answeredAt,
    action: { kind: "retry-answer", askId: ask.id, answer },
    ...deps.store.noticeDefer(key),
  };
}

/**
 * Crew paused on an interaction, one row per interaction, and the health rows:
 * the Captain thread errored, or a crew report Tasks gave up delivering. Steps
 * 1 to 3 of the status read. Tasks only names the rows' tasks, so a Tasks
 * failure keeps the blocked rows and drops only what Tasks alone knows.
 */
export async function crewItems(
  deps: QueueDeps,
  captainId: string,
  readCrew: (captainId: string) => CrewSnapshot = (id) => readCrewSnapshot(deps, id),
): Promise<(BlockedItem | HealthItem)[]> {
  const signal = AbortSignal.timeout(READ_DEADLINE_MS);
  const crew = readCrew(captainId);
  const [threads, own] = await Promise.all([
    crew.threads,
    deps.bb.sdk.threads.get({ threadId: captainId, signal }).catch(() => null),
  ]);
  // Interactions need only the threads: they are read while Tasks answers.
  const [rows, interactions] = await Promise.all([
    crew.rows,
    readInteractions(
      deps,
      threads.filter((thread) => thread.hasPendingInteraction).map((thread) => thread.id),
    ),
  ]);
  const now = deps.now();
  const items: (BlockedItem | HealthItem)[] = [];
  if (own?.status === "error") {
    const key = NOTICE.captainHealth(captainId, own.updatedAt);
    items.push({
      kind: "health",
      key,
      title: "Captain thread errored",
      detail: null,
      task: null,
      since: own.updatedAt,
      action: { kind: "retry-thread", threadId: captainId },
      ...deps.store.noticeDefer(key),
    });
  }
  for (const member of joinCrew(deps, threads, rows)) {
    const state = crewState(member, now);
    const task = member.rows[0]?.task.key ?? null;
    if (state === "blocked") {
      const role = member.role === null ? null : ROLE_SPECS[member.role].label;
      const pending = interactions.get(member.thread.id) ?? [];
      // The flag can outlive the interaction for a moment; the row needs one.
      for (const entry of pending) {
        const key = NOTICE.blocked(entry.id);
        items.push({
          kind: "blocked",
          key,
          threadId: member.thread.id,
          title: entry.note,
          interactionKind: entry.kind,
          task,
          role,
          since: entry.createdAt,
          ...deps.store.noticeDefer(key),
        });
      }
    }
    const comment = member.rows[0]?.lastNotifyingComment;
    if (state === "undeliverable" && comment) {
      const key = NOTICE.reportHealth(comment.id);
      items.push({
        kind: "health",
        key,
        title: `Report not delivered${task === null ? "" : `: ${task}`}`,
        detail: comment.delivery.reason ?? null,
        task,
        since: ms(comment.createdAt),
        action: { kind: "open-thread", threadId: member.thread.id },
        ...deps.store.noticeDefer(key),
      });
    }
  }
  return items;
}

/**
 * How many items a Captain's banner holds: its `1 of N`, from the same reads
 * and order. 0 for a thread that is not a live Captain. When the crew read
 * fails, the asks alone, as the banner shows them then.
 */
export async function needsYouCount(deps: QueueDeps, captainId: string): Promise<number> {
  if (deps.registry.get(captainId) === null) return 0;
  const asks = askItems(deps, captainId);
  const crew = await crewItems(deps, captainId).catch((error: unknown) => {
    deps.bb.log.warn(`needs-you count for ${captainId} without crew: ${(error as Error).message}`);
    return [];
  });
  return orderQueue([...asks, ...crew], deps.now()).length;
}

export type SinceYouLeft = {
  cutoff: number | null;
  done: ChangeRef[];
  ready: ChangeRef[];
  failed: ChangeRef[];
};

/**
 * Transitions after the stored last-seen time: a task whose status became
 * `done`, a task whose review verdict became passed or skipped, and a crew
 * thread first seen failed. One `crewSnapshot` over every thread this Captain
 * ever ran, so archived crew still count.
 */
export async function sinceYouLeft(deps: QueueDeps, captainId: string): Promise<SinceYouLeft> {
  const cutoff = deps.store.lastSeen(captainId);
  const empty: SinceYouLeft = { cutoff, done: [], ready: [], failed: [] };
  if (cutoff === null) return empty;
  const ids = deps.store.crewRolesOf(captainId).map((crew) => crew.threadId);
  if (ids.length === 0) return empty;
  const rows = await deps.tasks.crewSnapshot(ids, new Date(cutoff).toISOString());
  const done = new Map<string, ChangeRef>();
  const ready = new Map<string, ChangeRef>();
  for (const row of rows) {
    const ref = { task: row.task.key, title: row.task.title, threadId: null };
    if (row.task.status === "done" && ms(row.task.statusChangedAt ?? row.task.updatedAt) > cutoff) {
      done.set(row.task.key, ref);
    }
    const review = row.fields.find((field) => field.key === "review");
    if (review && SHIP_READY_REVIEWS.has(review.value) && ms(review.writtenAt) > cutoff) {
      ready.set(row.task.key, ref);
    }
  }
  const failed = ids.flatMap((threadId): ChangeRef[] => {
    const seen = deps.store.noticeSeenAt(NOTICE.failed(threadId));
    if (seen === null || seen <= cutoff) return [];
    const row = rows.find((entry) => entry.threadId === threadId);
    return [{ task: row?.task.key ?? null, title: row?.task.title ?? null, threadId }];
  });
  return { cutoff, done: [...done.values()], ready: [...ready.values()], failed };
}

/** Later hides a row for an hour; Skip moves it behind every other row. */
export function deferItem(
  deps: Pick<QueueDeps, "bb" | "store" | "now">,
  captainId: string,
  key: string,
  action: "later" | "skip",
): { snoozedUntil: number | null; skipOrder: number | null } {
  const now = deps.now();
  const patch = action === "later" ? { snoozedUntil: now + LATER_MS } : { skipOrder: now };
  if (key.startsWith("ask:")) {
    const ask = deps.store.ask(key.slice("ask:".length));
    if (ask === null || ask.captainId !== captainId)
      throw new Error(`no ask ${key} on ${captainId}`);
    deps.store.deferAsk(ask.id, patch);
    deps.bb.rpc.experimental_invalidate([asksTag(captainId)]);
    const after = deps.store.ask(ask.id);
    return { snoozedUntil: after?.snoozedUntil ?? null, skipOrder: after?.skipOrder ?? null };
  }
  deps.store.deferNotice(key, now, patch);
  // An answer's health row reads from the asks; the rest from the crew read.
  deps.bb.rpc.experimental_invalidate([
    key.startsWith("health:answer:") ? asksTag(captainId) : crewTag(captainId),
  ]);
  return deps.store.noticeDefer(key);
}

/** Move the Since you left cutoff to now. */
export function markSeen(
  deps: Pick<QueueDeps, "bb" | "store" | "now">,
  captainId: string,
  client: string,
): { at: number } {
  const at = deps.now();
  deps.store.setLastSeen(captainId, client, at);
  deps.bb.rpc.experimental_invalidate([sinceTag(captainId)]);
  return { at };
}
