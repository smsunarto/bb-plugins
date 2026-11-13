/**
 * Each thread's Change, assembled from the store: where its checkout is
 * (placement), what the checkout holds (local read), its pull request (forge
 * read), and what runs while it is watched (watch). Reads served to clients
 * come from the store only; a host is called only while a surface watches a
 * thread, when the host signals a change, or when someone asks.
 *
 * A thread's tag is announced only when what a reader would see changed, so
 * an unchanged refresh costs no client a read.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Cause, Effect, Fiber } from "effect";
import {
  changeKeyForBranch,
  EMPTY_FACET,
  findBranch,
  type ForgeAction,
  type ForgeResult,
  type ThreadChange,
} from "../core/change.ts";
import { threadTag, type ChangeKey } from "../core/ids.ts";
import { threadStatus, type ThreadStatus } from "../core/status.ts";
import { createActions } from "./actions.ts";
import { createCheckoutWork } from "./checkout-work.ts";
import { createForgeReads } from "./forge-read.ts";
import type { ForgeSites } from "./forge-sites.ts";
import { HOST_DEADLINE_MS, type HostCalls } from "./host-calls.ts";
import { createLocalReads, type ThreadBranchLookup } from "./local-read.ts";
import { createPlacements } from "./placement.ts";
import { createReview } from "./review.ts";
import { localMatch } from "./review-change.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";
import { createWatch } from "./watch.ts";

/** A row read from another surface is read again once it is this old. */
export const GLANCE_MS = 5 * 60_000;

export type ThreadChangesDeps = {
  bb: BbPluginApi;
  store: Store;
  sites: ForgeSites;
  host: HostCalls;
  branches: ThreadBranchLookup;
  share: Share;
  now: () => number;
  /** True once the plugin instance is going away: nothing is announced after. */
  disposed: () => boolean;
  actionDeadlineMs: number;
  /** How long a host read may take before the host counts as offline. */
  hostDeadlineMs?: number;
  /** Runs work no caller waits for. */
  fork: (work: Effect.Effect<void>) => void;
};

/** Threads on the Change's branch: those read showing it, and those at its checkout on it. */
function threadsOnChange(
  store: Store,
  key: ChangeKey,
  showing: Iterable<string> | undefined,
  keyOf: (threadId: string) => ChangeKey | null,
): string[] {
  const threads = new Set(showing ?? []);
  const match = localMatch(store, key);
  for (const threadId of match ? store.threadsAt(match.placement.hostId, match.placement.path) : [])
    if (keyOf(threadId) === key) threads.add(threadId);
  return [...threads];
}

/** A branch of the thread's own checkout as a Change at its head, or why it is not one. */
function branchChange(
  store: Store,
  threadId: string,
  name: string,
): { key: ChangeKey; head: string | null } | { problem: string } {
  const where = store.placement(threadId);
  if (where?.state !== "checkout") return { problem: "This thread has no checkout." };
  const workspace = store.local(where.placement.hostId, where.placement.path).read?.value;
  const branch = workspace ? findBranch(workspace, name) : null;
  if (!workspace || !branch)
    return { problem: `${name} is not a branch in this thread's checkout.` };
  return { key: changeKeyForBranch(where.placement.hostId, workspace, branch), head: branch.head };
}

export function createThreadChanges(deps: ThreadChangesDeps) {
  const { bb, store, now, share } = deps;
  const hostDeadlineMs = deps.hostDeadlineMs ?? HOST_DEADLINE_MS;
  /** The threads each ChangeKey was last shown for, so a pull request read reaches all of them. */
  const keyThreads = new Map<ChangeKey, Set<string>>();

  function announce(threadIds: Iterable<string>): void {
    if (deps.disposed()) return;
    const tags = [...new Set(threadIds)].map(threadTag);
    if (tags.length > 0) bb.rpc.experimental_invalidate(tags);
  }

  /** The thread's Change from the store alone. */
  function row(threadId: string): ThreadChange {
    const where = store.placement(threadId);
    if (!where) return { state: "pending" };
    if (where.state === "none") return where;
    const { placement } = where;
    const local = store.local(placement.hostId, placement.path);
    const branchName = store.branch(threadId);
    const workspace = local.read?.value ?? null;
    const branch = workspace ? findBranch(workspace, branchName) : null;
    const key =
      workspace && branch ? changeKeyForBranch(placement.hostId, workspace, branch) : null;
    if (key) {
      const threads = keyThreads.get(key) ?? new Set<string>();
      threads.add(threadId);
      keyThreads.set(key, threads);
    }
    return {
      state: "checkout",
      placement,
      readAsGit: store.readAs(placement.hostId, placement.path) === "git",
      branch: branch ? branchName : null,
      key,
      local,
      forge: key ? store.forge(key) : EMPTY_FACET,
    };
  }

  const keyOf = (threadId: string): ChangeKey | null => {
    const current = row(threadId);
    return current.state === "checkout" ? current.key : null;
  };

  const invalidate = (tags: readonly string[]) => {
    if (!deps.disposed()) bb.rpc.experimental_invalidate(tags);
  };
  const owners = (key: ChangeKey): string[] =>
    threadsOnChange(store, key, keyThreads.get(key), keyOf);
  const placements = createPlacements({ bb, store, now });
  // Bound once the review page's reads exist; a checkout read reaches its lists through it.
  let checkoutRead: (hostId: string, path: string) => void = () => {};
  const local = createLocalReads({
    store,
    host: deps.host,
    placements,
    branches: deps.branches,
    share,
    announce,
    checkoutRead: (hostId, path) => {
      if (!deps.disposed()) checkoutRead(hostId, path);
    },
    now,
    deadlineMs: hostDeadlineMs,
  });
  const forge = createForgeReads({
    store,
    sites: deps.sites,
    share,
    threadsOf: (key) => keyThreads.get(key) ?? [],
    announce,
    invalidate,
    forgeRead: (key) => review.items.settleIfBehind(key),
    now,
  });

  /** Local and forge together; the forge again if the local read moved the Change. */
  const refreshNow = Effect.fn("refreshThread")(function* (threadId: string) {
    const { where, changed } = yield* placements.settle(threadId);
    if (changed) announce([threadId]);
    if (where.state === "none") return;
    const { placement } = where;
    // GitHub's answer does not wait for a slow or sleeping host.
    const forgeFirst = yield* Effect.forkChild(forge.readForge(threadId, placement));
    yield* local.readCheckout(placement);
    yield* local.settleBranch(threadId, placement);
    const keyBefore = yield* Fiber.join(forgeFirst);
    const key = keyOf(threadId);
    if (key && key !== keyBefore) yield* forge.readForge(threadId, placement);
  });

  /** Read the thread now; concurrent requests for one thread share one read. */
  const refresh = (threadId: string) =>
    share(
      `thread:${threadId}`,
      refreshNow(threadId).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? // Interrupted only: nothing failed, so nothing is caught.
              Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning(`Could not read the Change of ${threadId}`, Cause.pretty(cause)),
        ),
      ),
    );

  const review = createReview({
    bb,
    store,
    sites: deps.sites,
    local,
    host: deps.host,
    share,
    invalidate,
    forgeChanged: (key) => announce(keyThreads.get(key) ?? []),
    fork: deps.fork,
    now,
    deadlineMs: hostDeadlineMs,
    threadsOnChange: owners,
  });
  checkoutRead = review.checkoutRead;

  const watch = createWatch({
    store,
    host: deps.host,
    placements,
    local,
    forge,
    refresh,
    keyOf,
    now,
    deadlineMs: hostDeadlineMs,
  });

  const actions = createActions({
    store,
    host: deps.host,
    placements,
    startRefresh: (threadId) => Effect.asVoid(Effect.forkDetach(refresh(threadId))),
    refresh,
    renamed: deps.branches.renamed.bind(deps.branches),
    announce,
    actionDeadlineMs: deps.actionDeadlineMs,
    hostDeadlineMs,
  });

  const checkoutWork = createCheckoutWork({
    store,
    placements,
    local,
    readForge: review.refresh,
    invalidate,
  });

  return {
    /** Threads on the Change's branch, from the store and recent reads. */
    owners,
    /** Work a card names by path or branch, on the thread's own host. */
    checkoutWork,
    /** Stored rows only: serving a read never calls a host. */
    read(keys: readonly string[]): Record<string, ThreadChange> {
      return Object.fromEntries(keys.map((threadId) => [threadId, row(threadId)]));
    },
    /** Each thread's compact status, from the store only. */
    status(keys: readonly string[]): Record<string, ThreadStatus> {
      return Object.fromEntries(keys.map((threadId) => [threadId, threadStatus(row(threadId))]));
    },
    /**
     * A list row came into view: read the thread once if it has never been
     * read or its last read is older than GLANCE_MS. No watch follows; the
     * thread's own tab keeps it live.
     */
    glance: (threadId: string) =>
      Effect.suspend(() => {
        if (watch.watched(threadId)) return Effect.void;
        const where = store.placement(threadId);
        if (where?.state === "none") return Effect.void;
        const readAt =
          where?.state === "checkout"
            ? store.local(where.placement.hostId, where.placement.path).read?.at
            : undefined;
        return readAt !== undefined && now() - readAt < GLANCE_MS ? Effect.void : refresh(threadId);
      }),
    /** Stored checks only, by ChangeKey. */
    checks(keys: readonly ChangeKey[]) {
      return Object.fromEntries(keys.map((key) => [key, store.checks(key)]));
    },
    /** One write on the thread's pull request, at the head the reader saw. */
    forgeAction: Effect.fn("forgeAction")(function* (
      threadId: string,
      action: ForgeAction,
      expected: { number: number; head: string },
    ) {
      const where = store.placement(threadId);
      if (where?.state !== "checkout")
        return {
          status: "failed",
          problem: { kind: "moved", detail: "This thread has no checkout." },
        } satisfies ForgeResult;
      return yield* forge.act(threadId, where.placement, action, expected);
    }),
    refresh,
    /** The thread's Change from stored rows, if its checkout and branch are known. */
    keyOf,
    branchChange: branchChange.bind(null, store),
    review,
    /** Probe forge sites again before the next read. */
    reprobe: deps.sites.reprobe,
    /** Explicit retry: probe forge sites again, then read. */
    retry: (threadId: string) =>
      Effect.sync(() => deps.sites.reprobe()).pipe(Effect.andThen(refresh(threadId))),
    ...watch,
    ...actions,
  };
}
