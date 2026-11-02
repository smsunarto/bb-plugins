/**
 * The pull request of each thread's GitButler branch, keyed by thread, for
 * the composer and Info surfaces, the sidebar, and other plugins. Forked from
 * bb's bundled GitHub PR Status (`bb--github-pr-status`), which keys by
 * environment and so finds no pull request in a GitButler checkout.
 *
 * A thread's branch is the one its own `but` commands, or its subthreads',
 * last named. A thread that named none falls back to the checkout's only
 * applied branch with a review, if there is exactly one.
 *
 * A read answers at once from what the server has and refreshes a stale row
 * behind it: an open or draft pull request after 30 seconds while checks run,
 * auto-merge is on or mergeability is unknown, and after 5 minutes otherwise;
 * merged and closed ones after an hour; "no pull request" after 5 minutes.
 * Watched rows are rechecked on that schedule, and a finished turn on the
 * thread rechecks its row at once.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assemblePullRequest } from "../../shared/assemble-pull-request.ts";
import {
  threadPullRequestTag,
  type HostPullRequestLookup,
  type PullRequestAction,
  type ThreadPullRequest,
} from "../../shared/pull-request.ts";
import { hostClient } from "../lib/target.ts";
import { createThreadBranches, type ThreadPlace } from "../lib/thread-branches.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const ENVIRONMENT_MS = 30 * SECOND;
/** How long a checkout's answer about its fallback branch, or about not being GitButler's, holds. */
const CHECKOUT_MS = 5 * MINUTE;
const TICK_MS = 15 * SECOND;
/** How long a read waits for a thread's first history scan or a checkout's first host read. */
const COLD_WAIT_MS = 3 * SECOND;
/** How long a checkout whose host read failed is left alone by polls and reads that need not wait. */
const FAILED_BACKOFF_MS = MINUTE;

const LATE = Symbol("late");

/** `promise`'s answer, or LATE once `ms` pass; the promise keeps running. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

type Place = { hostId: string; path: string };
type Located = { place: Place; environmentId: string };
type Entry = { lookup: HostPullRequestLookup; at: number };
/** What a checkout said about itself: not GitButler's, or its fallback branch. */
type Checkout =
  | { gitbutler: false; at: number }
  | { gitbutler: true; fallback: string | null; at: number };

function ttl(lookup: HostPullRequestLookup): number {
  if (lookup.outcome === "none") return 5 * MINUTE;
  if (lookup.outcome === "unavailable") return 30 * SECOND;
  const { pullRequest } = lookup;
  if (pullRequest.state !== "OPEN") return 60 * MINUTE;
  const busy =
    pullRequest.autoMerge ||
    pullRequest.mergeable === "UNKNOWN" ||
    pullRequest.mergeable === null ||
    pullRequest.checks.some((check) => check.status === "queued" || check.status === "in_progress");
  return busy ? 30 * SECOND : 5 * MINUTE;
}

function rowOf(lookup: HostPullRequestLookup | undefined): ThreadPullRequest {
  if (!lookup || lookup.outcome === "none") return { outcome: "absent" };
  if (lookup.outcome === "unavailable") return { outcome: "unavailable", message: lookup.message };
  return { outcome: "available", pullRequest: assemblePullRequest(lookup.pullRequest) };
}

const placeKey = ({ hostId, path }: Place) => `${hostId}\0${path}`;
const branchKey = (place: Place, branch: string) => `${placeKey(place)}\0${branch}`;

export function createThreadPullRequests(bb: BbPluginApi) {
  const host = hostClient(bb);
  // A branch a background recheck changed reaches the thread's watchers.
  const branches = createThreadBranches(bb, (threadId) =>
    bb.rpc.experimental_invalidate([threadPullRequestTag(threadId)]),
  );
  const entries = new Map<string, Entry>();
  const checkouts = new Map<string, Checkout>();
  const environments = new Map<string, { place: Place | null; at: number }>();
  /** The checkout and branch each thread's last row came from, and whether the thread named it. */
  const shown = new Map<string, { place: Place; branch: string | null; named: boolean }>();
  const watched = new Map<string, number>();
  /** One host read per checkout at a time; a later one waits for it, then reads what it still lacks. */
  const reading = new Map<string, Promise<void>>();
  /** When a checkout's host read last failed. */
  const failedAt = new Map<string, number>();

  async function placeOfEnvironment(environmentId: string): Promise<Place | null> {
    const cached = environments.get(environmentId);
    if (cached && Date.now() - cached.at < ENVIRONMENT_MS) return cached.place;
    const environment = await bb.sdk.environments.get({ environmentId }).catch(() => null);
    const place =
      environment && environment.status === "ready" && environment.path
        ? { hostId: environment.hostId, path: environment.path }
        : null;
    environments.set(environmentId, { place, at: Date.now() });
    return place;
  }

  async function threadPlaces(threadIds: readonly string[]): Promise<Map<string, Located>> {
    const threads = await bb.sdk.threads.list({ threadIds: [...threadIds], includeHidden: true });
    const places = new Map<string, Located>();
    await Promise.all(
      threads.map(async ({ id, environmentId }) => {
        const place = environmentId ? await placeOfEnvironment(environmentId) : null;
        if (place && environmentId) places.set(id, { place, environmentId });
      }),
    );
    return places;
  }

  function backingOff(place: Place): boolean {
    const at = failedAt.get(placeKey(place));
    return at !== undefined && Date.now() - at < FAILED_BACKOFF_MS;
  }

  function checkoutOf(place: Place): Checkout | null {
    const checkout = checkouts.get(placeKey(place));
    return checkout && Date.now() - checkout.at < CHECKOUT_MS ? checkout : null;
  }

  function fresh(place: Place, branch: string): boolean {
    const entry = entries.get(branchKey(place, branch));
    return entry !== undefined && Date.now() - entry.at < ttl(entry.lookup);
  }

  /**
   * Tells watchers of every thread showing one of `keys` that its row
   * changed, and with `fallbackOf`, of every thread in that checkout that
   * named no branch, whose fallback moved.
   */
  function publish(keys: ReadonlySet<string>, fallbackOf: string | null) {
    const threads = [...shown]
      .filter(
        ([, { place, branch, named }]) =>
          (branch !== null && keys.has(branchKey(place, branch))) ||
          (!named && placeKey(place) === fallbackOf),
      )
      .map(([threadId]) => threadPullRequestTag(threadId));
    if (threads.length > 0) bb.rpc.experimental_invalidate(threads);
  }

  /**
   * Reads `wanted` in one checkout on its host, and its fallback branch when
   * asked. Reads of one checkout run one after another, each asking only for
   * what the last left stale. A checkout whose read failed in the last minute
   * is asked again only on `retry`.
   */
  async function load(
    place: Place,
    wanted: readonly string[],
    fallback: boolean,
    retry = false,
  ): Promise<void> {
    const key = placeKey(place);
    while (reading.has(key)) await reading.get(key);
    if (!retry && backingOff(place)) return;
    const branchesLeft = wanted.filter((branch) => !fresh(place, branch));
    const fallbackLeft = fallback && checkoutOf(place) === null;
    if (branchesLeft.length === 0 && !fallbackLeft) return;
    const run = (async () => {
      const answer = await host.call(
        "pullRequests",
        { environmentPath: place.path, branches: branchesLeft, fallback: fallbackLeft },
        { hostId: place.hostId },
      );
      if (!answer.workspace) {
        checkouts.set(key, { gitbutler: false, at: Date.now() });
        return;
      }
      let fallbackMoved = false;
      if (fallbackLeft) {
        const before = checkouts.get(key);
        fallbackMoved = !before?.gitbutler || before.fallback !== answer.fallbackBranch;
        checkouts.set(key, { gitbutler: true, fallback: answer.fallbackBranch, at: Date.now() });
      }
      const changed = new Set<string>();
      for (const [branch, lookup] of Object.entries(answer.lookups)) {
        const entryKey = branchKey(place, branch);
        const before = entries.get(entryKey);
        if (!before || JSON.stringify(before.lookup) !== JSON.stringify(lookup))
          changed.add(entryKey);
        entries.set(entryKey, { lookup, at: Date.now() });
      }
      publish(changed, fallbackMoved ? key : null);
    })();
    const settled = run.then(
      () => void failedAt.delete(key),
      (error: unknown) => {
        failedAt.set(key, Date.now());
        bb.log.debug(`Could not read pull requests in ${place.path}: ${String(error)}`);
      },
    );
    reading.set(key, settled);
    await settled.finally(() => {
      if (reading.get(key) === settled) reading.delete(key);
    });
  }

  /**
   * Rows for threads in one checkout. A first read waits a few seconds for
   * the thread's history and the host, then answers with what it has; the
   * rest arrives as an invalidation, so one slow machine or long history
   * never holds up the sidebar's whole batch. `wait` waits for everything.
   */
  async function readCheckout(
    place: Place,
    environmentId: string,
    threadIds: readonly string[],
    wait: boolean,
  ) {
    const settle = <T>(promise: Promise<T>) => (wait ? promise : within(promise, COLD_WAIT_MS));
    const absent = () =>
      Object.fromEntries(threadIds.map((id) => [id, { outcome: "absent" } as const]));
    // Whether the checkout is GitButler's is settled before any thread's
    // history is read: outside one, there is nothing to read it for.
    if (!checkouts.has(placeKey(place))) {
      const asked = load(place, [], true, wait);
      if ((await settle(asked)) === LATE) {
        void asked.then(() => bb.rpc.experimental_invalidate(threadIds.map(threadPullRequestTag)));
        return absent();
      }
    } else if (checkoutOf(place) === null && !checkouts.get(placeKey(place))!.gitbutler) {
      // A checkout found plain may have become a GitButler workspace since;
      // the old answer serves while it is asked again behind it. A stale
      // fallback is asked again below, only when a thread needs it.
      void load(place, [], true, wait);
    }
    if (checkouts.get(placeKey(place))?.gitbutler !== true) return absent();

    const where: ThreadPlace = { environmentId, path: place.path };
    const named = new Map<string, string | null | typeof LATE>();
    await Promise.all(
      threadIds.map(async (threadId) => {
        const pending = branches.branchOf(threadId, where).catch(() => null);
        const branch = await settle(pending);
        if (branch === LATE)
          void pending.then(() => bb.rpc.experimental_invalidate([threadPullRequestTag(threadId)]));
        named.set(threadId, branch);
      }),
    );
    const values = [...named.values()];
    const wanted = [...new Set(values.filter((branch) => typeof branch === "string"))];
    const fallback = values.includes(null);
    const cold = wanted.some((branch) => !entries.has(branchKey(place, branch)));
    const pending = load(place, wanted, fallback, wait);
    if (wait || cold) await settle(pending);
    const checkout = checkouts.get(placeKey(place));
    const fallbackBranch = checkout?.gitbutler ? checkout.fallback : null;
    // The fallback branch is read like a named one once it is known.
    if (fallback && fallbackBranch !== null && !entries.has(branchKey(place, fallbackBranch)))
      await settle(load(place, [fallbackBranch], false, wait));

    const rows: Record<string, ThreadPullRequest> = {};
    for (const threadId of threadIds) {
      const own = named.get(threadId);
      if (own === LATE || checkout?.gitbutler === false) {
        shown.delete(threadId);
        rows[threadId] = { outcome: "absent" };
        continue;
      }
      const branch = own ?? fallbackBranch;
      shown.set(threadId, { place, branch, named: own !== null && own !== undefined });
      rows[threadId] =
        branch === null
          ? { outcome: "absent" }
          : rowOf(entries.get(branchKey(place, branch))?.lookup);
    }
    return rows;
  }

  async function read(threadIds: readonly string[], wait: boolean) {
    const places = await threadPlaces(threadIds);
    const rows: Record<string, ThreadPullRequest> = {};
    const groups = new Map<string, Located & { threads: string[] }>();
    for (const threadId of threadIds) {
      const located = places.get(threadId);
      if (!located || checkoutOf(located.place)?.gitbutler === false) {
        rows[threadId] = { outcome: "absent" };
        continue;
      }
      // Threads on one environment share its checkout and its answer.
      const key = `${placeKey(located.place)}\0${located.environmentId}`;
      const group = groups.get(key) ?? { ...located, threads: [] };
      group.threads.push(threadId);
      groups.set(key, group);
    }
    const answers = await Promise.all(
      [...groups.values()].map(({ place, environmentId, threads }) =>
        readCheckout(place, environmentId, threads, wait),
      ),
    );
    return Object.assign(rows, ...answers) as Record<string, ThreadPullRequest>;
  }

  /**
   * Watched rows due a recheck, rechecked; their watchers hear of changes.
   * A row that named no branch also has its checkout asked again, on the
   * checkout's schedule, which branch it falls back to.
   */
  function tick() {
    const due = new Map<string, { place: Place; branches: Set<string>; fallback: boolean }>();
    for (const threadId of watched.keys()) {
      const row = shown.get(threadId);
      if (!row || backingOff(row.place)) continue;
      const stale = row.branch !== null && !fresh(row.place, row.branch);
      const fallback = !row.named && checkoutOf(row.place) === null;
      if (!stale && !fallback) continue;
      const key = placeKey(row.place);
      const group = due.get(key) ?? { place: row.place, branches: new Set(), fallback: false };
      if (stale) group.branches.add(row.branch!);
      group.fallback ||= fallback;
      due.set(key, group);
    }
    for (const { place, branches: wanted, fallback } of due.values())
      void load(place, [...wanted], fallback);
  }
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Ages the thread's row out so the next read asks GitHub again. The row
   * stays: other reads keep answering from it while the recheck runs.
   */
  function expire(threadId: string) {
    const row = shown.get(threadId);
    if (!row) return;
    const entryKey = row.branch === null ? null : branchKey(row.place, row.branch);
    const entry = entryKey === null ? undefined : entries.get(entryKey);
    if (entryKey !== null && entry) entries.set(entryKey, { ...entry, at: 0 });
    const checkout = checkouts.get(placeKey(row.place));
    if (checkout?.gitbutler) checkouts.set(placeKey(row.place), { ...checkout, at: 0 });
  }

  return {
    read: (threadIds: readonly string[]) => read(threadIds, false),

    watch(threadId: string, signal: AbortSignal) {
      watched.set(threadId, (watched.get(threadId) ?? 0) + 1);
      timer ??= setInterval(tick, TICK_MS);
      signal.addEventListener(
        "abort",
        () => {
          const count = (watched.get(threadId) ?? 1) - 1;
          if (count > 0) watched.set(threadId, count);
          else watched.delete(threadId);
          if (watched.size === 0 && timer) {
            clearInterval(timer);
            timer = null;
          }
        },
        { once: true },
      );
    },

    /** Re-checks the thread's row on GitHub now, whatever its age, and retries a failed host. */
    async refresh(threadId: string) {
      expire(threadId);
      await read([threadId], true);
      bb.rpc.experimental_invalidate([threadPullRequestTag(threadId)]);
    },

    /**
     * After a turn: the thread may have named a branch, pushed it, or opened
     * its pull request. Threads outside a GitButler checkout are not read.
     */
    async turnEnded(threadId: string, environmentId: string | null) {
      if (!environmentId) return;
      const place = await placeOfEnvironment(environmentId);
      if (!place) return;
      // A checkout never read yet is asked once whether it is GitButler's.
      if (checkoutOf(place) === null) await load(place, [], true, true);
      if (checkoutOf(place)?.gitbutler !== true) return;
      const changed = await branches.turnEnded(threadId, { environmentId, path: place.path });
      for (const id of new Set([threadId, ...changed])) expire(id);
      bb.rpc.experimental_invalidate(
        [...new Set([threadId, ...changed])].map(threadPullRequestTag),
      );
    },

    /**
     * Acts on the pull request the reader saw: `expected` names its URL and
     * head commit, and the host refuses when the thread's branch now has
     * another pull request, in this repository or another, or new commits.
     */
    async act(
      threadId: string,
      action: PullRequestAction,
      expected: { url: string; headRefOid: string | null },
    ): Promise<{ message: string }> {
      const located = (await threadPlaces([threadId])).get(threadId);
      if (!located) throw new Error("This thread has no ready checkout.");
      const { place, environmentId } = located;
      const row = shown.get(threadId);
      const branch =
        row && placeKey(row.place) === placeKey(place)
          ? row.branch
          : await branches.branchOf(threadId, { environmentId, path: place.path });
      if (!branch) throw new Error("This thread has no GitButler branch with a pull request.");
      const result = await host.call(
        "pullRequestAction",
        {
          environmentPath: place.path,
          branch,
          action,
          expectedUrl: expected.url,
          expectedHeadOid: expected.headRefOid,
        },
        { hostId: place.hostId },
      );
      if (!result.ok) throw new Error(result.message);
      await this.refresh(threadId).catch(() => undefined);
      return {
        message:
          action.operation === "ready"
            ? `Marked pull request #${result.number} ready for review`
            : action.operation === "draft"
              ? `Converted pull request #${result.number} to a draft`
              : `Merged pull request #${result.number}`,
      };
    },

    dispose() {
      if (timer) clearInterval(timer);
    },
  };
}
