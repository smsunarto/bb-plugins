/**
 * Ported from `plugins/gitbutler/src/server/lib/thread-branches.ts`.
 *
 * Which GitButler branch each thread works on. Many threads share one
 * GitButler checkout, so the checked-out branch says nothing about a thread;
 * the `but` commands the thread ran there do. A thread that left its Git
 * work to subthreads on the same checkout takes the branch they last named,
 * unless it named one itself.
 *
 * Each thread's own answer is kept in the plugin's key-value storage with the
 * last event it covers, so a later read starts after that event. The first
 * read goes newest-first and stops at the latest branch named.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { applyMentions, branchMentions, type BranchMention } from "./branch-mentions.ts";

type Rename = { from: string; to: string; at: number };

/** What a thread's own commands say, and how far they have been read. */
type OwnBranch = {
  branch: string | null;
  /** When its commands last named or renamed the branch, for ordering subthreads. */
  namedAt: number | null;
  /**
   * Its latest renames, of any branch: a subthread may rename the branch a
   * sibling named, which the parent then shows under its new name.
   */
  renames: Rename[];
  /** The last event read, by sequence number. */
  scannedSeq: number;
};

/** Where a thread works: the checkout its `but` commands must run in to count. */
export type ThreadPlace = { environmentId: string; path: string };

const KEY_PREFIX = "thread-branch-v3:";
/** Renames kept per thread. */
const RENAMES_KEPT = 20;
/** Events one read takes after the last one read; the rest wait for the next read. */
const LATER_READ_EVENTS = 5_000;
/** bb serves at most 100 events a page. */
const PAGE = 100;
/** Events read on first sight, at most; newest first, so the cap drops the oldest. */
const FIRST_READ_EVENTS = 20_000;
/** Reads of thread histories at once: a sidebar can ask about every thread it lists together. */
const READS_AT_ONCE = 3;
/** How long a thread's answer is used before its new events are read again. */
const RECONCILE_MS = 60_000;

type Mention = { at: number; mention: BranchMention };
/** A thread's record after a read, and whether newer events are still unread. */
type Read = { record: OwnBranch; more: boolean };
type EventRow = { seq: number | string; createdAt: number; data: unknown };

const NOTHING_READ: OwnBranch = { branch: null, namedAt: null, renames: [], scannedSeq: 0 };

function commandOf(item: Record<string, unknown>): { command: string; cwd?: string } | null {
  if (item["type"] === "commandExecution") {
    // A command that failed changed no branch.
    if (item["exitCode"] !== 0 || typeof item["command"] !== "string") return null;
    const cwd = typeof item["cwd"] === "string" && item["cwd"] !== "" ? item["cwd"] : undefined;
    return { command: item["command"], ...(cwd ? { cwd } : {}) };
  }
  if (item["type"] === "toolCall" && item["status"] === "completed") {
    const args = item["arguments"];
    const command =
      typeof args === "object" && args !== null
        ? (args as Record<string, unknown>)["command"]
        : null;
    return typeof command === "string" ? { command } : null;
  }
  return null;
}

function mentionsOf(event: EventRow, checkout: string): Mention[] {
  const item = (event.data as { item?: unknown } | null)?.item;
  if (typeof item !== "object" || item === null) return [];
  const found = commandOf(item as Record<string, unknown>);
  if (!found) return [];
  return branchMentions(found.command, checkout, found.cwd).map((mention) => ({
    at: event.createdAt,
    mention,
  }));
}

/** `previous` after `mentions`, oldest first, with `lastSeq` read. */
function advance(previous: OwnBranch, mentions: readonly Mention[], lastSeq: number): OwnBranch {
  let { branch, namedAt } = previous;
  const renames = [...previous.renames];
  for (const { at, mention } of mentions) {
    if (mention.kind === "rename") renames.push({ from: mention.from, to: mention.to, at });
    const next = applyMentions(branch, [mention]);
    if (mention.kind === "branch" || next !== branch) namedAt = at;
    branch = next;
  }
  return { branch, namedAt, renames: renames.slice(-RENAMES_KEPT), scannedSeq: lastSeq };
}

/** The branch a subthread named last, under the name it has after every rename since. */
function latestNamed(mine: OwnBranch, theirs: OwnBranch[]): string | null {
  let latest: { branch: string; namedAt: number } | null = null;
  for (const { branch, namedAt } of theirs)
    if (branch !== null && namedAt !== null && (!latest || namedAt > latest.namedAt))
      latest = { branch, namedAt };
  if (!latest) return null;
  const since = latest.namedAt;
  let branch = latest.branch;
  const renames = [mine, ...theirs]
    .flatMap((record) => record.renames)
    .filter((rename) => rename.at > since)
    .sort((a, b) => a.at - b.at);
  for (const rename of renames) if (rename.from === branch) branch = rename.to;
  return branch;
}

export function createThreadBranches(
  bb: BbPluginApi,
  /** Called with a thread whose branch a background recheck changed. */
  onChange: (threadId: string) => void,
) {
  const own = new Map<string, OwnBranch>();
  /** One read of a thread's events at a time: a read and a finished turn may ask together. */
  const reading = new Map<string, Promise<Read>>();
  /** Each thread's answer, its subthreads' included, and when it was worked out. */
  const answers = new Map<string, { branch: string | null; at: number }>();
  /** Resolves running, with the generation each started in. */
  const resolving = new Map<string, { promise: Promise<string | null>; generation: number }>();

  /** Bumped when a thread's answer is cleared, so a resolve that started before cannot restore it. */
  const generations = new Map<string, number>();

  let readsRunning = 0;
  const queued: (() => void)[] = [];
  async function limited<T>(run: () => Promise<T>): Promise<T> {
    // A finished read hands its slot straight to the next in line.
    if (readsRunning >= READS_AT_ONCE) await new Promise<void>((go) => queued.push(go));
    else readsRunning += 1;
    try {
      return await run();
    } finally {
      const next = queued.shift();
      if (next) next();
      else readsRunning -= 1;
    }
  }

  async function stored(threadId: string): Promise<OwnBranch | null> {
    const cached = own.get(threadId);
    if (cached) return cached;
    const record = await bb.storage.kv.get<OwnBranch>(KEY_PREFIX + threadId);
    if (record) own.set(threadId, record);
    return record ?? null;
  }

  /** Newest first, back to the latest branch named; the renames after it still apply. */
  async function firstRead(threadId: string, checkout: string): Promise<OwnBranch> {
    const later: Mention[] = [];
    let newest = 0;
    let beforeSeq: string | undefined;
    for (let read = 0; read < FIRST_READ_EVENTS;) {
      const events = (await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: String(PAGE),
        types: ["item/completed"],
        ...(beforeSeq ? { beforeSeq } : {}),
      })) as EventRow[];
      for (const event of events) {
        newest = Math.max(newest, Number(event.seq));
        // A command's mentions run in order; read backwards, its last comes first.
        for (const mention of mentionsOf(event, checkout).reverse()) {
          later.push(mention);
          if (mention.mention.kind === "branch")
            return advance(NOTHING_READ, later.reverse(), newest);
        }
      }
      read += events.length;
      if (events.length < PAGE) break;
      beforeSeq = String(events[events.length - 1]!.seq);
    }
    return advance(NOTHING_READ, later.reverse(), newest);
  }

  /** The events after the last one read, oldest first, up to a cap; the next read goes on. */
  async function readSince(previous: OwnBranch, threadId: string, checkout: string): Promise<Read> {
    const mentions: Mention[] = [];
    let lastSeq = previous.scannedSeq;
    let more = true;
    for (let read = 0; more && read < LATER_READ_EVENTS; read += PAGE) {
      const events = (await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(lastSeq),
        order: "asc",
        limit: String(PAGE),
        types: ["item/completed"],
      })) as EventRow[];
      for (const event of events) {
        lastSeq = Math.max(lastSeq, Number(event.seq));
        mentions.push(...mentionsOf(event, checkout));
      }
      more = events.length === PAGE;
    }
    return { record: advance(previous, mentions, lastSeq), more };
  }

  /**
   * The thread's own branch in `place`, after reading whatever it ran since
   * last time. Records are kept per environment: a thread moved to another
   * checkout starts over there.
   */
  function readOwn(threadId: string, place: ThreadPlace): Promise<Read> {
    const key = `${threadId}:${place.environmentId}`;
    const running = reading.get(key);
    if (running) return running;
    const promise = limited(async () => {
      const previous = await stored(key);
      const read = previous
        ? await readSince(previous, threadId, place.path)
        : { record: await firstRead(threadId, place.path), more: false };
      const next = read.record;
      if (!previous || previous.scannedSeq !== next.scannedSeq || previous.branch !== next.branch) {
        own.set(key, next);
        await bb.storage.kv.set(KEY_PREFIX + key, next);
      }
      return read;
    }).finally(() => reading.delete(key));
    reading.set(key, promise);
    return promise;
  }

  /**
   * The thread's branch, or the latest its subthreads on the same checkout
   * named, under any name it was given since, by the thread or any of them.
   * `more` says some history it depends on is still unread.
   */
  async function resolve(
    threadId: string,
    place: ThreadPlace,
  ): Promise<{ branch: string | null; more: boolean }> {
    const { record: mine, more: mineMore } = await readOwn(threadId, place);
    if (mine.branch !== null) return { branch: mine.branch, more: mineMore };
    const [entry] = (await bb.sdk.threads.experimental_listDescendants({ threadIds: [threadId] }))
      .threads;
    const ids = (entry?.descendantIds ?? []).slice(0, 200);
    if (ids.length === 0) return { branch: null, more: mineMore };
    // A subthread in another checkout works on another repository's branch.
    const sameCheckout = (await bb.sdk.threads.list({ threadIds: ids, includeHidden: true }))
      .filter((thread) => thread.environmentId === place.environmentId)
      .map((thread) => thread.id);
    const reads = (
      await Promise.all(sameCheckout.map((id) => readOwn(id, place).catch(() => null)))
    ).filter((read): read is Read => read !== null);
    const more = mineMore || reads.some((read) => read.more);
    const theirs = reads.map((read) => read.record);
    return { branch: latestNamed(mine, theirs), more };
  }

  function work(threadId: string, place: ThreadPlace): Promise<string | null> {
    const key = `${threadId}:${place.environmentId}`;
    const generation = generations.get(threadId) ?? 0;
    // A resolve from before the answer was cleared may return the cleared answer.
    const running = resolving.get(key);
    if (running?.generation === generation) return running.promise;
    const before = answers.get(key);
    const promise: Promise<string | null> = resolve(threadId, place)
      .then(({ branch, more }) => {
        // Cleared while it ran: the history it read may predate the clearing.
        if ((generations.get(threadId) ?? 0) !== generation) return work(threadId, place);
        answers.set(key, { branch, at: Date.now() });
        if (before && before.branch !== branch) onChange(threadId);
        // History left unread for later: read on, and tell watchers if it moves.
        if (more) setTimeout(() => void background(threadId, place), 0);
        return branch;
      })
      .finally(() => {
        if (resolving.get(key)?.promise === promise) resolving.delete(key);
      });
    resolving.set(key, { promise, generation });
    return promise;
  }

  function background(threadId: string, place: ThreadPlace) {
    return work(threadId, place).catch((error: unknown) =>
      bb.log.debug(`Could not recheck the branch of ${threadId}: ${String(error)}`),
    );
  }

  return {
    /**
     * The thread's branch. A known answer comes back at once, and one older
     * than a minute is checked against the thread's newer events behind it;
     * a change reaches `onChange`.
     */
    async branchOf(threadId: string, place: ThreadPlace): Promise<string | null> {
      const known = answers.get(`${threadId}:${place.environmentId}`);
      if (!known) return work(threadId, place);
      if (Date.now() - known.at >= RECONCILE_MS) {
        void background(threadId, place);
      }
      return known.branch;
    },

    /**
     * After a turn: reads the thread's new events now, after any read
     * already running, and makes the threads above it work theirs out again,
     * since their answer may come from it. Returns every thread whose answer
     * may have changed.
     */
    /**
     * A rename made from the tab rather than by the thread's commands, kept as
     * if the thread had run it, so its branch keeps following the new name.
     */
    async renamed(threadId: string, place: ThreadPlace, from: string, to: string): Promise<void> {
      const key = `${threadId}:${place.environmentId}`;
      const { record } = await readOwn(threadId, place);
      const at = Date.now();
      const mine = record.branch === from;
      const next: OwnBranch = {
        ...record,
        branch: mine ? to : record.branch,
        namedAt: mine ? at : record.namedAt,
        renames: [...record.renames, { from, to, at }].slice(-RENAMES_KEPT),
      };
      own.set(key, next);
      await bb.storage.kv.set(KEY_PREFIX + key, next);
      generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
      answers.delete(key);
    },

    async turnEnded(threadId: string, place: ThreadPlace): Promise<string[]> {
      const key = `${threadId}:${place.environmentId}`;
      await resolving.get(key)?.promise.catch(() => null);
      await reading.get(key)?.catch(() => null);
      await work(threadId, place);
      const [entry] = (await bb.sdk.threads.experimental_listAncestors({ threadIds: [threadId] }))
        .threads;
      const ancestors = entry?.ancestorIds ?? [];
      for (const id of ancestors) {
        generations.set(id, (generations.get(id) ?? 0) + 1);
        answers.delete(`${id}:${place.environmentId}`);
      }
      return [threadId, ...ancestors];
    },
  };
}

export type ThreadBranches = ReturnType<typeof createThreadBranches>;
