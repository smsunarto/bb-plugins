import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Cause, Effect, Exit, Result, Schedule } from "effect";
import { z } from "zod";
import {
  type Checks,
  type PrRef,
  type PrWatch,
  PR_WATCH_CHANNEL,
  checksRunning,
  prKey,
  prWatchSchema,
  sameAccount,
} from "../../shared/schema.ts";
import { isNotFound } from "./activity.ts";
import { loadChecks } from "./checks.ts";
import { type Gh, GhError, type GitHub } from "./gh.ts";
import { type GqlActor, prState } from "./github.ts";
import { createLocks } from "./lock.ts";
import { runDetached } from "./run.ts";

/*
 * Pull requests agents watch from their threads. A background service reads
 * each one every half minute while checks run and every minute otherwise,
 * compares the read with what the thread already heard, and wakes the thread
 * with what changed: a failed check, finished checks, a comment or review
 * from someone else, a conflict or a base that moved ahead, a merge or close.
 * News that lands while the thread works waits, and goes out as one message
 * once the thread is idle.
 *
 *   watch:<threadId>:<pr key>   WatchRecord
 *
 * One thread watches a pull request at a time, so its news reaches one agent.
 * GitHub's rate limit pauses a watch until it resets; other failed reads back
 * off and end it after a while.
 */

const TICK_MS = 10_000;
const RUNNING_POLL_MS = 30_000;
const SETTLED_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_FAILED_POLLS = 10;
/** Below this many GraphQL points left, watches wait for the hourly reset. */
const LOW_RATE_LIMIT = 250;
/** Watches read from GitHub at once. Each read is two GraphQL requests. */
const MAX_PARALLEL_POLLS = 4;
const MAX_WATCHES_PER_THREAD = 5;
/** News lines per pull request in one wake message. */
const MAX_LINES = 12;
/** CI and deploy bots report through checks, so their comments are status, not news. */
const STATUS_BOTS = ["github-actions", "vercel", "netlify", "railway", "cloudflare"];
const BUSY = new Set(["pending", "starting", "active", "stopping"]);

const watchRecordSchema = prWatchSchema.extend({
  threadId: z.string(),
  /** Tells this watch from a later one of the same pull request, so a stale read cannot land on it. */
  watchId: z.string(),
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
});
export type WatchRecord = z.infer<typeof watchRecordSchema>;

/** One read of a watched pull request. `activity` holds only what is news to the agent. */
export type PrRead = {
  url: string;
  title: string;
  state: PrWatch["state"];
  baseRefName: string;
  mergeState: string | null;
  checks: Checks;
  activity: { id: string; line: string }[];
  /** When GitHub's rate limit runs low, when it resets. */
  pausedUntil: number | null;
};

export const WATCH_QUERY = `query PrWatch($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining resetAt }
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url title state baseRefName mergeStateStatus
      comments(last: 100) { nodes { id url author { login } } }
      reviews(last: 100) { nodes { id url state body author { login } } }
      reviewThreads(last: 100) {
        nodes { path line comments(last: 20) { nodes { id url author { login } } } }
      }
    }
  }
}`;

type GqlItem = { id: string; url: string; author: GqlActor };

type GqlWatch = {
  rateLimit: { remaining: number; resetAt: string } | null;
  viewer: { login: string };
  repository: {
    pullRequest: {
      url: string;
      title: string;
      state: string;
      baseRefName: string;
      mergeStateStatus: string | null;
      comments: { nodes: GqlItem[] };
      reviews: { nodes: (GqlItem & { state: string; body: string })[] };
      reviewThreads: {
        nodes: { path: string; line: number | null; comments: { nodes: GqlItem[] } }[];
      };
    };
  };
};

const REVIEW_VERDICTS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
};

/** The pull request's state and the conversation on it, from someone other than the viewer. */
export async function readPr(gh: Gh, ref: PrRef): Promise<PrRead> {
  const [data, checks] = await Promise.all([
    gh.graphql(WATCH_QUERY, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    }) as Promise<GqlWatch>,
    loadChecks(gh, ref),
  ]);
  const pr = data.repository.pullRequest;
  const login = (item: GqlItem) => item.author?.login ?? "ghost";
  const fromOthers = (item: GqlItem) => !sameAccount(login(item), data.viewer.login);
  const statusBot = (item: GqlItem) =>
    STATUS_BOTS.some((bot) => login(item).toLowerCase().includes(bot));
  const activity = [
    ...pr.comments.nodes
      .filter((item) => fromOthers(item) && !statusBot(item))
      .map((item) => ({ id: item.id, line: `Comment from ${login(item)}: ${item.url}` })),
    // A review that only carries inline comments has no body: its comments are the news.
    ...pr.reviews.nodes
      .filter((item) => fromOthers(item) && (REVIEW_VERDICTS[item.state] || item.body.trim()))
      .map((item) => ({
        id: item.id,
        line: `Review from ${login(item)}${REVIEW_VERDICTS[item.state] ? ` (${REVIEW_VERDICTS[item.state]})` : ""}: ${item.url}`,
      })),
    ...pr.reviewThreads.nodes.flatMap((thread) =>
      thread.comments.nodes.filter(fromOthers).map((item) => ({
        id: item.id,
        line: `Review comment from ${login(item)} on ${thread.path}${thread.line ? `:${thread.line}` : ""}: ${item.url}`,
      })),
    ),
  ];
  return {
    url: pr.url,
    title: pr.title,
    state: prState(pr.state),
    baseRefName: pr.baseRefName,
    mergeState: pr.mergeStateStatus,
    checks,
    activity,
    pausedUntil:
      data.rateLimit && data.rateLimit.remaining < LOW_RATE_LIMIT
        ? Date.parse(data.rateLimit.resetAt)
        : null,
  };
}

const failing = (checks: Checks) =>
  checks.checks.filter((check) => check.state === "failure").map((check) => check.id);
const finished = (checks: Checks) => checks.checks.length > 0 && !checksRunning(checks);

/** What the agent already knows when it starts watching: nothing in this read is news. */
export function baseline(
  threadId: string,
  ref: PrRef,
  account: string,
  read: PrRead,
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

const OUTCOMES: [Checks["checks"][number]["state"], string][] = [
  ["success", "passed"],
  ["failure", "failed"],
  ["cancelled", "cancelled"],
  ["skipped", "skipped"],
  ["neutral", "neutral"],
];

function finishedLine(checks: Checks): string {
  const counts = OUTCOMES.flatMap(([state, word]) => {
    const count = checks.checks.filter((check) => check.state === state).length;
    return count ? [`${count} ${word}`] : [];
  });
  return `All checks finished on ${checks.headRefOid.slice(0, 7)}: ${counts.join(", ")}.`;
}

/**
 * Failed and finished checks the thread has not heard of. A check that runs
 * again, after a push or a re-run, can fail again as news, and checks that
 * run again, re-runs or ones that register late, finish again as news.
 */
function checkNews(record: WatchRecord, checks: Checks) {
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

const STATE_NEWS: Record<PrWatch["state"], string | null> = {
  open: null,
  merged: "Merged. The watch ended.",
  closed: "Closed without merging. The watch ended.",
};

/** The next record after a successful read, and the news it holds for the thread. */
export function observe(record: WatchRecord, read: PrRead, now: number): WatchRecord {
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
 * The next record after a failed read. A used-up rate limit is no fault of
 * the pull request: the watch waits for it without counting the failure.
 */
export function failed(record: WatchRecord, error: unknown, now: number): WatchRecord {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof GhError ? error.code : null;
  if (code === "rate-limited") {
    return { ...record, error: message, nextPollAt: now + MAX_BACKOFF_MS };
  }
  const failures = record.failures + 1;
  const gone = code === "not-found";
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

/** Soon while checks run, later once they settle, and after the reset when the rate limit runs low. */
function nextPoll(read: PrRead, now: number): number {
  const interval = checksRunning(read.checks) ? RUNNING_POLL_MS : SETTLED_POLL_MS;
  return Math.max(now + interval, read.pausedUntil ?? 0);
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
    ? "The watch continues. Handle what needs action, then end your turn. Before you hand off, call `code_review_watch_pr` with `stop: true`."
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

export type PrWatcher = ReturnType<typeof createPrWatcher>;

export function createPrWatcher({
  bb,
  github,
  now = Date.now,
}: {
  bb: BbPluginApi;
  github: GitHub;
  now?: () => number;
}) {
  const kv = bb.storage.kv;
  // Every change to one thread's watches waits for the one before it. Starting
  // a watch also holds its pull request (`pr:<key>`), so two threads cannot
  // both claim it; that lock is always taken before a thread's.
  const withLock = createLocks();
  const recordKey = (threadId: string, ref: PrRef) =>
    `watch:${threadId}:${prKey(ref).toLowerCase()}`;

  async function records(prefix = "watch:") {
    const keys = await kv.list(prefix);
    const entries = await Promise.all(
      keys.map(async (key) => {
        const parsed = watchRecordSchema.safeParse(await kv.get(key));
        return parsed.success ? [{ key, record: parsed.data }] : [];
      }),
    );
    return entries.flat();
  }

  const publish = (threadId: string) => bb.realtime.publish(PR_WATCH_CHANNEL, { threadId });

  async function threadState(threadId: string): Promise<"idle" | "busy" | "gone"> {
    const thread = await bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!thread || thread.deletedAt != null || thread.archivedAt != null) return "gone";
    return BUSY.has(thread.status) ? "busy" : "idle";
  }

  /** Drops every watch of a thread. Call with the thread's lock held. */
  async function dropAll(threadId: string): Promise<void> {
    const entries = await records(`watch:${threadId}:`);
    await Promise.all(entries.map(({ key }) => kv.delete(key)));
    if (entries.length > 0) publish(threadId);
  }

  const forget = (threadId: string) => withLock(threadId, () => dropAll(threadId));

  /** Sends the thread its waiting news in one message, once it is idle. */
  async function flush(threadId: string): Promise<void> {
    await withLock(threadId, async () => {
      const waiting = (await records(`watch:${threadId}:`)).filter(
        ({ record }) => record.pending.length > 0,
      );
      if (waiting.length === 0) return;
      const state = await threadState(threadId);
      if (state === "busy") return;
      if (state === "gone") return dropAll(threadId);
      await bb.sdk.threads.send({
        threadId,
        // It can start a turn between the check and the send; then the news waits behind it.
        mode: "queue-if-active",
        input: [
          { type: "text", text: wakeMessage(waiting.map(({ record }) => record)), mentions: [] },
        ],
      });
      await Promise.all(
        waiting.map(({ key, record }) =>
          record.ended ? kv.delete(key) : kv.set(key, { ...record, pending: [] }),
        ),
      );
      publish(threadId);
    });
  }

  const pollOne = Effect.fnUntraced(function* ({
    key,
    record,
  }: {
    key: string;
    record: WatchRecord;
  }) {
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: async (signal) => readPr(github.as(record.account, signal), record.ref),
        catch: (error) => error,
      }),
    );
    yield* Effect.promise(() =>
      withLock(record.threadId, async () => {
        const current = watchRecordSchema.safeParse(await kv.get(key));
        // Stopped, or stopped and started again, while the read was on the wire.
        if (!current.success || current.data.ended || current.data.watchId !== record.watchId) {
          return;
        }
        const next = Result.isSuccess(outcome)
          ? observe(current.data, outcome.success, now())
          : failed(current.data, outcome.failure, now());
        await kv.set(key, next);
        // Every read moves `polledAt`; clients refetch only for a change they would show.
        if (shown(current.data) !== shown(next)) publish(record.threadId);
      }),
    );
  });

  /**
   * Reads every watch that is due, then delivers news to idle threads. A
   * thread archived or deleted while its watch was being set up, or while
   * the plugin was not loaded to hear it, loses its watches here. A poll
   * that is stopped stops between its steps, and its reads stop their `gh`.
   */
  const polling = Effect.gen(function* () {
    const candidates = (yield* Effect.promise(() => records())).filter(
      ({ record }) => !record.ended && record.nextPollAt <= now(),
    );
    const threads = [...new Set(candidates.map(({ record }) => record.threadId))];
    const gone = new Set<string>();
    yield* Effect.forEach(
      threads,
      (threadId) =>
        Effect.gen(function* () {
          // A thread bb cannot answer for right now is not gone.
          const state = yield* Effect.promise(() =>
            threadState(threadId).catch(() => "busy" as const),
          );
          if (state !== "gone") return;
          gone.add(threadId);
          yield* Effect.promise(() => forget(threadId));
        }),
      { concurrency: "unbounded", discard: true },
    );
    const due = candidates.filter(({ record }) => !gone.has(record.threadId));
    // Each read finishes on its own, so a slow pull request holds up only itself.
    const polled = yield* Effect.forEach(due, (entry) => Effect.exit(pollOne(entry)), {
      concurrency: MAX_PARALLEL_POLLS,
    });
    const failure = polled.find(Exit.isFailure);
    if (failure) return yield* failure;
    const waiting = new Set(
      (yield* Effect.promise(() => records()))
        .filter(({ record }) => record.pending.length > 0)
        .map(({ record }) => record.threadId),
    );
    yield* Effect.forEach(waiting, (threadId) => Effect.promise(() => flush(threadId)), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  /** Writes the thread's new watch from `read`. Call with the thread's lock held. */
  async function start(
    threadId: string,
    key: string,
    ref: PrRef,
    login: string,
    read: PrRead,
  ): Promise<string> {
    const existing = watchRecordSchema.safeParse(await kv.get(key));
    if (existing.success && !existing.data.ended) {
      return `Already watching ${prKey(existing.data.ref)} (${describe(existing.data)}). End your turn.`;
    }
    const others = (await records(`watch:${threadId}:`)).filter(
      ({ key: other, record }) => other !== key && !record.ended,
    );
    if (others.length >= MAX_WATCHES_PER_THREAD) {
      throw new Error(
        `This thread already watches ${MAX_WATCHES_PER_THREAD} pull requests. Stop one first.`,
      );
    }
    const record = baseline(threadId, ref, login, read, now());
    await kv.set(key, record);
    publish(threadId);
    return `Watching ${prKey(ref)} (${describe(record)}). End your turn now; this thread gets a message when a check fails, all checks finish, someone else comments or reviews, the branch conflicts or falls behind, or the pull request merges or closes.`;
  }

  return {
    /**
     * Starts watching `ref` for the thread, from what it shows now. Watching
     * it again keeps the watch and what the thread already heard.
     */
    async watch(threadId: string, ref: PrRef, account?: string): Promise<string> {
      const login = account ?? (await github.accounts())[0];
      if (!login)
        throw new GhError("unauthenticated", "GitHub CLI is not signed in. Run `gh auth login`.");
      const key = recordKey(threadId, ref);
      const suffix = `:${prKey(ref).toLowerCase()}`;
      return withLock(`pr${suffix}`, async () => {
        for (const other of await records()) {
          if (!other.key.endsWith(suffix) || other.record.threadId === threadId) continue;
          if ((await threadState(other.record.threadId)) !== "gone") {
            throw new Error(
              `Thread ${other.record.threadId} already watches ${prKey(ref)}. Only the thread that owns a pull request watches it.`,
            );
          }
          await forget(other.record.threadId);
        }
        const read = await readPr(github.as(login), ref);
        if (read.state !== "open") {
          throw new Error(`${prKey(ref)} is ${read.state}, so there is nothing to watch.`);
        }
        return withLock(threadId, () => start(threadId, key, ref, login, read));
      });
    },

    /** Stops the thread's watch of `ref`. False when it had none. */
    async stop(threadId: string, ref: PrRef): Promise<boolean> {
      return withLock(threadId, async () => {
        const key = recordKey(threadId, ref);
        if ((await kv.get(key)) === undefined) return false;
        await kv.delete(key);
        publish(threadId);
        return true;
      });
    },

    async list(threadId: string): Promise<PrWatch[]> {
      const entries = await records(`watch:${threadId}:`);
      return entries
        .map(({ record }) => view(record))
        .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
    },

    /** One poll, for a caller outside the plugin's background service. */
    poll: () => runDetached(polling),
    flush,
    forget,

    /** The body of the plugin's background service: a poll every few seconds, until it stops. */
    watching: polling.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(`Pull request watch poll failed: ${String(Cause.squash(cause))}`),
      ),
      Effect.repeat(Schedule.spaced(TICK_MS)),
    ),
  };
}

function view(record: WatchRecord): PrWatch {
  return prWatchSchema.parse(record);
}

/** What the card shows of a watch, less the read time. */
function shown(record: WatchRecord): string {
  const { polledAt: _, ...rest } = view(record);
  return JSON.stringify(rest);
}
