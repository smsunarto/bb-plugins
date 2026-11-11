/**
 * Pull requests agents watch from their threads. The `pr-watch` service reads
 * each one every half minute while checks run and every minute otherwise,
 * compares the read with what the thread already heard, and wakes the thread
 * with what changed: a failed check, finished checks, a comment or review
 * from someone else, a conflict or a base that moved ahead, a merge or close.
 * News that lands while the thread works waits, and goes out as one message
 * once the thread is idle.
 *
 * Watches live in the `pr_watch` table, so they survive a restart. A watch
 * whose site is away (its host asleep, `gh` signed out there) waits and is
 * read again later; only GitHub saying the pull request is gone, or ten
 * failed reads GitHub answered, end it. Ported from
 * `plugins/code-review/src/server/lib/pr-watch.ts`.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  checksRunning,
  loginSchema,
  prKey,
  prRefSchema,
  prStateSchema,
  watchChecksSchema,
  type PrRef,
  type WatchChecks,
  type WatchRead,
} from "../core/watch.ts";
import type { SiteOutcome } from "./forge-sites.ts";
import type { Store } from "./store.ts";

export const WATCH_PR = "source_control_watch_pr";

const TICK_MS = 10_000;
const RUNNING_POLL_MS = 30_000;
const SETTLED_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_FAILED_POLLS = 10;
/** Watches read from GitHub at once. */
const MAX_PARALLEL_POLLS = 4;
const MAX_WATCHES_PER_THREAD = 5;
/** News lines per pull request in one wake message. */
const MAX_LINES = 12;
const BUSY = new Set(["pending", "starting", "active", "stopping"]);

export const watchRecordSchema = z
  .object({
    threadId: z.string(),
    /** Tells this watch from a later one of the same pull request, so a stale read cannot land on it. */
    watchId: z.string(),
    ref: prRefSchema,
    account: loginSchema,
    url: z.string(),
    title: z.string(),
    state: prStateSchema,
    mergeState: z.string().nullable(),
    checks: watchChecksSchema,
    startedAt: z.string(),
    polledAt: z.string(),
    /** Why the latest read failed, or why the watch waits. */
    error: z.string().nullable(),
    ended: z.boolean(),
    /** Comments, reviews, and review comments the thread has heard of. */
    seen: z.array(z.string()),
    /** Checks on `checks.headRefOid` the thread heard failed and that have not run again. */
    failedChecks: z.array(z.string()),
    /** The head whose finished checks the thread heard of; null while checks run. */
    settledHead: z.string().nullable(),
    /** News the thread has not heard yet. */
    pending: z.array(z.string()),
    failures: z.number().int(),
    nextPollAt: z.number(),
  })
  .strict();
export type WatchRecord = z.infer<typeof watchRecordSchema>;

const failing = (checks: WatchChecks) =>
  checks.checks.filter((check) => check.state === "failure").map((check) => check.id);
const finished = (checks: WatchChecks) => checks.checks.length > 0 && !checksRunning(checks);

/** Soon while checks run, later once they settle, and after the reset when the rate limit runs low. */
function nextPoll(read: WatchRead, now: number): number {
  const interval = checksRunning(read.checks) ? RUNNING_POLL_MS : SETTLED_POLL_MS;
  return Math.max(now + interval, read.pausedUntil ?? 0);
}

/** What the agent already knows when it starts watching: nothing in this read is news. */
export function baseline(
  threadId: string,
  ref: PrRef,
  account: string,
  read: WatchRead,
  now: number,
): WatchRecord {
  const at = new Date(now).toISOString();
  return {
    threadId,
    watchId: randomUUID(),
    ref,
    account,
    url: read.url,
    title: read.title,
    state: read.state,
    mergeState: read.mergeState,
    checks: read.checks,
    startedAt: at,
    polledAt: at,
    error: null,
    ended: false,
    seen: read.activity.map((item) => item.id),
    failedChecks: failing(read.checks),
    settledHead: finished(read.checks) ? read.checks.headRefOid : null,
    pending: [],
    failures: 0,
    nextPollAt: nextPoll(read, now),
  };
}

const OUTCOMES: [WatchChecks["checks"][number]["state"], string][] = [
  ["success", "passed"],
  ["failure", "failed"],
  ["cancelled", "cancelled"],
  ["skipped", "skipped"],
  ["neutral", "neutral"],
];

function finishedLine(checks: WatchChecks): string {
  const counts = OUTCOMES.flatMap(([state, word]) => {
    const count = checks.checks.filter((check) => check.state === state).length;
    return count ? [`${count} ${word}`] : [];
  });
  return `All checks finished on ${checks.headRefOid.slice(0, 7)}: ${counts.join(", ")}.`;
}

/**
 * Failed and finished checks the thread has not heard of. A check that runs
 * again can fail again as news, and checks that run again finish again as news.
 */
function checkNews(record: WatchRecord, checks: WatchChecks) {
  const events: string[] = [];
  const heard = new Set(checks.headRefOid === record.checks.headRefOid ? record.failedChecks : []);
  for (const check of checks.checks) {
    if (check.state === "pending") heard.delete(check.id);
    if (check.state !== "failure" || heard.has(check.id)) continue;
    heard.add(check.id);
    events.push(`Check failed: ${check.name}${check.detailsUrl ? ` ${check.detailsUrl}` : ""}`);
  }
  const settled = finished(checks) && record.settledHead !== checks.headRefOid;
  if (settled) events.push(finishedLine(checks));
  const present = new Set(checks.checks.map((check) => check.id));
  return {
    events,
    failedChecks: [...heard].filter((id) => present.has(id)),
    settledHead: checksRunning(checks) ? null : settled ? checks.headRefOid : record.settledHead,
  };
}

const MERGE_NEWS: Record<string, (base: string) => string> = {
  DIRTY: (base) => `The branch conflicts with ${base}.`,
  BEHIND: (base) => `The branch is behind ${base}.`,
};

const STATE_NEWS: Record<WatchRecord["state"], string | null> = {
  open: null,
  merged: "Merged. The watch ended.",
  closed: "Closed without merging. The watch ended.",
};

/** The next record after a successful read, and the news it holds for the thread. */
export function observe(record: WatchRecord, read: WatchRead, now: number): WatchRecord {
  const { checks } = read;
  const checked = checkNews(record, checks);
  const seen = new Set(record.seen);
  // GitHub says UNKNOWN while it works the merge state out, which is no change.
  const mergeState = read.mergeState === "UNKNOWN" ? record.mergeState : read.mergeState;
  const mergeNews = mergeState === record.mergeState ? undefined : MERGE_NEWS[mergeState ?? ""];
  const events = [
    ...checked.events,
    ...read.activity.filter((item) => !seen.has(item.id)).map((item) => item.line),
    ...(mergeNews ? [mergeNews(read.baseRefName)] : []),
    ...(STATE_NEWS[read.state] ? [STATE_NEWS[read.state]!] : []),
  ];
  return {
    ...record,
    url: read.url,
    title: read.title,
    state: read.state,
    mergeState,
    checks,
    polledAt: new Date(now).toISOString(),
    error: null,
    ended: read.state !== "open",
    seen: read.activity.map((item) => item.id),
    failedChecks: checked.failedChecks,
    settledHead: checked.settledHead,
    pending: [...record.pending, ...events],
    failures: 0,
    nextPollAt: nextPoll(read, now),
  };
}

/**
 * The next record after a read that did not answer. A site that is away and
 * a used-up rate limit are no fault of the pull request: the watch waits
 * without counting them. GitHub not finding it ends the watch at once.
 */
export function failed(
  record: WatchRecord,
  outcome: Extract<SiteOutcome<unknown>, { ok: false }>,
  now: number,
): WatchRecord {
  const { reason, message } = outcome;
  if (reason === "away" || reason === "rate-limited")
    return { ...record, error: message, nextPollAt: now + MAX_BACKOFF_MS };
  const failures = record.failures + 1;
  const gone = reason === "gone";
  const ended = gone || failures >= MAX_FAILED_POLLS;
  const news = gone
    ? `Stopped watching: GitHub cannot find the pull request (${message}).`
    : `Stopped watching after ${failures} failed reads: ${message}.`;
  return {
    ...record,
    error: message,
    failures,
    ended,
    pending: ended ? [...record.pending, news] : record.pending,
    nextPollAt: now + Math.min(RUNNING_POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
  };
}

/** What the thread reads when it wakes: each pull request's news, then what to do next. */
export function wakeMessage(records: readonly WatchRecord[]): string {
  const sections = records.map((record) => {
    const lines = record.pending.slice(0, MAX_LINES).map((line) => `- ${line}`);
    const more = record.pending.length - MAX_LINES;
    if (more > 0) lines.push(`- …and ${more} more. Read the pull request for the rest.`);
    return [`${prKey(record.ref)} ${record.url}`, ...lines].join("\n");
  });
  const footer = records.some((record) => !record.ended)
    ? `The watch continues. Handle what needs action, then end your turn. Before you hand off, call \`${WATCH_PR}\` with \`stop: true\`.`
    : "Nothing is watched now.";
  return ["Pull request watch:", ...sections, footer].join("\n\n");
}

/** How a watch reads as a fact for the agent: the head, its checks, and the merge state. */
function describe(record: WatchRecord): string {
  const { checks } = record;
  const failingNames = checks.checks.filter((c) => c.state === "failure").map((c) => c.name);
  const running = checks.checks.filter((c) => c.state === "pending").length;
  const parts = [
    checks.checks.length === 0
      ? "no checks yet"
      : [
          failingNames.length ? `${failingNames.length} failing (${failingNames.join(", ")})` : "",
          running ? `${running} running` : "",
          !failingNames.length && !running ? "all checks finished" : "",
        ]
          .filter(Boolean)
          .join(", "),
  ];
  if (record.mergeState && record.mergeState !== "UNKNOWN")
    parts.push(`merge state ${record.mergeState}`);
  return `head ${checks.headRefOid.slice(0, 7)}: ${parts.join("; ")}`;
}

/** Work for one key runs after the work before it, so two writers never interleave. */
export function createLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = tails.get(key) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  };
}

type Read = (login: string | null, ref: PrRef, threadId: string) => Promise<SiteOutcome<WatchRead>>;

export function createPrWatcher(deps: {
  bb: BbPluginApi;
  store: Store;
  /** One watch read, on the site the account is signed in on. */
  read: Read;
  now: () => number;
  /** Whether the old code-review plugin still runs: its watches are the live ones until the cutover. */
  standingDown: () => boolean;
}) {
  const { bb, store, now } = deps;
  const withLock = createLocks();

  const parse = (json: string | null): WatchRecord | null => {
    if (json === null) return null;
    try {
      const parsed = watchRecordSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const recordsOf = (threadId: string) =>
    store.watchRowsOf(threadId).flatMap(({ pr_key, json }) => {
      const record = parse(json);
      return record ? [{ key: pr_key, record }] : [];
    });
  const put = (record: WatchRecord) =>
    store.putWatch(record.threadId, prKey(record.ref), JSON.stringify(record));

  async function threadState(threadId: string): Promise<"idle" | "busy" | "gone"> {
    const thread = await bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
      if (/not found/i.test(String(error))) return null;
      throw error;
    });
    if (!thread || thread.deletedAt != null || thread.archivedAt != null) return "gone";
    return BUSY.has(thread.status) ? "busy" : "idle";
  }

  const forget = (threadId: string) =>
    withLock(threadId, async () => {
      store.dropWatches(threadId);
    });

  /** Sends the thread its waiting news in one message, once it is idle. */
  async function flush(threadId: string): Promise<void> {
    await withLock(threadId, async () => {
      const waiting = recordsOf(threadId).filter(({ record }) => record.pending.length > 0);
      if (waiting.length === 0) return;
      const state = await threadState(threadId);
      if (state === "busy") return;
      if (state === "gone") {
        store.dropWatches(threadId);
        return;
      }
      await bb.sdk.threads.send({
        threadId,
        // It can start a turn between the check and the send; then the news waits behind it.
        mode: "queue-if-active",
        input: [
          { type: "text", text: wakeMessage(waiting.map(({ record }) => record)), mentions: [] },
        ],
      });
      for (const { record } of waiting) {
        if (record.ended) store.dropWatch(threadId, prKey(record.ref));
        else put({ ...record, pending: [] });
      }
    });
  }

  async function pollOne(record: WatchRecord): Promise<void> {
    const outcome = await deps.read(record.account, record.ref, record.threadId);
    await withLock(record.threadId, async () => {
      const current = parse(store.watchRow(record.threadId, prKey(record.ref)));
      // Stopped, or stopped and started again, while the read was on the wire.
      if (!current || current.ended || current.watchId !== record.watchId) return;
      put(outcome.ok ? observe(current, outcome.value, now()) : failed(current, outcome, now()));
    });
  }

  /** Reads every watch that is due, four at a time, then delivers news to idle threads. */
  async function poll(): Promise<void> {
    if (deps.standingDown()) return;
    const due = store.watchRows().flatMap(({ json }) => {
      const record = parse(json);
      return record && !record.ended && record.nextPollAt <= now() ? [record] : [];
    });
    const threads = [...new Set(due.map((record) => record.threadId))];
    const gone = new Set<string>();
    await Promise.all(
      threads.map(async (threadId) => {
        // A thread bb cannot answer for right now is not gone.
        const state = await threadState(threadId).catch(() => "busy" as const);
        if (state !== "gone") return;
        gone.add(threadId);
        await forget(threadId);
      }),
    );
    const queue = due.filter((record) => !gone.has(record.threadId));
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_POLLS, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift())
        await pollOne(next).catch((error: unknown) =>
          bb.log.warn(`Pull request watch read failed: ${String(error)}`),
        );
    });
    await Promise.all(workers);
    const waiting = new Set(
      store
        .watchRows()
        .flatMap(({ thread_id, json }) =>
          (parse(json)?.pending.length ?? 0) > 0 ? [thread_id] : [],
        ),
    );
    await Promise.all([...waiting].map((threadId) => flush(threadId)));
  }

  return {
    /**
     * Starts watching `ref` for the thread, from what it shows now. Watching
     * it again keeps the watch and what the thread already heard.
     */
    async watch(threadId: string, ref: PrRef, account?: string): Promise<string> {
      return withLock(`pr:${prKey(ref).toLowerCase()}`, async () => {
        for (const other of store.watchersOf(prKey(ref))) {
          if (other === threadId) continue;
          if ((await threadState(other)) !== "gone")
            throw new Error(
              `Thread ${other} already watches ${prKey(ref)}. Only the thread that owns a pull request watches it.`,
            );
          await forget(other);
        }
        const outcome = await deps.read(account ?? null, ref, threadId);
        if (!outcome.ok) throw new Error(`Could not read ${prKey(ref)}: ${outcome.message}`);
        const read = outcome.value;
        if (read.state !== "open")
          throw new Error(`${prKey(ref)} is ${read.state}, so there is nothing to watch.`);
        return withLock(threadId, async () => {
          const existing = parse(store.watchRow(threadId, prKey(ref)));
          if (existing && !existing.ended)
            return `Already watching ${prKey(existing.ref)} (${describe(existing)}). End your turn.`;
          const others = recordsOf(threadId).filter(
            ({ record }) =>
              !record.ended && prKey(record.ref).toLowerCase() !== prKey(ref).toLowerCase(),
          );
          if (others.length >= MAX_WATCHES_PER_THREAD)
            throw new Error(
              `This thread already watches ${MAX_WATCHES_PER_THREAD} pull requests. Stop one first.`,
            );
          const record = baseline(threadId, ref, outcome.login, read, now());
          put(record);
          return `Watching ${prKey(ref)} (${describe(record)}). End your turn now; this thread gets a message when a check fails, all checks finish, someone else comments or reviews, the branch conflicts or falls behind, or the pull request merges or closes.`;
        });
      });
    },

    /** Stops the thread's watch of `ref`. False when it had none. */
    stop: (threadId: string, ref: PrRef): Promise<boolean> =>
      withLock(threadId, async () => store.dropWatch(threadId, prKey(ref))),

    list: (threadId: string): WatchRecord[] =>
      recordsOf(threadId)
        .map(({ record }) => record)
        .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)),

    /** Takes a watch the cutover read from code-review; false when the thread already has one. */
    adopt(record: WatchRecord): boolean {
      if (parse(store.watchRow(record.threadId, prKey(record.ref)))) return false;
      put(record);
      return true;
    },

    poll,
    flush,
    forget,

    /** The `pr-watch` service: a poll every ten seconds until it stops. */
    service: {
      start(signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = () => {
            if (signal.aborted) return;
            poll()
              .catch((error: unknown) =>
                bb.log.warn(`Pull request watch poll failed: ${String(error)}`),
              )
              .finally(() => {
                if (!signal.aborted) timer = setTimeout(tick, TICK_MS);
              });
          };
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
          tick();
        });
      },
    },
  };
}

export type PrWatcher = ReturnType<typeof createPrWatcher>;
