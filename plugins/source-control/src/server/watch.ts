/**
 * What happens while a surface watches a thread: the host keeps the checkout
 * watched under a lease, its change signals bring a new read, and the pull
 * request is read again on the forge schedule. Nothing is read for a thread
 * nobody watches.
 */
import { Effect, Schedule } from "effect";
import type { Placement } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { hostCall, type HostCalls } from "./host-calls.ts";
import { FORGE_ACTIVE_MS, type ForgeReads } from "./forge-read.ts";
import type { LocalReads } from "./local-read.ts";
import { checkoutId, type Placements } from "./placement.ts";
import type { Store } from "./store.ts";

/** How often a watched thread is looked at; most looks make no call. */
export const WATCH_TICK_MS = FORGE_ACTIVE_MS;
/** How long after a read or renewal the host's watch lease is renewed (it lasts 150 s). */
export const LEASE_RENEW_MS = 60_000;

export function createWatch(deps: {
  store: Store;
  host: HostCalls;
  placements: Placements;
  local: LocalReads;
  forge: ForgeReads;
  refresh: (threadId: string) => Effect.Effect<void>;
  keyOf: (threadId: string) => ChangeKey | null;
  now: () => number;
  deadlineMs: number;
}) {
  const { store, placements, local, forge } = deps;
  const watchers = new Map<string, number>();
  const renewed = new Map<string, number>();
  const watched = (threadId: string) => watchers.has(threadId);

  /** Keep the host's watch on the checkout: a read renews it too. */
  const renewLease = (placement: Placement) =>
    Effect.suspend(() => {
      const id = checkoutId(placement);
      const readAt = store.local(placement.hostId, placement.path).read?.at ?? 0;
      if (deps.now() - Math.max(readAt, renewed.get(id) ?? 0) < LEASE_RENEW_MS) return Effect.void;
      renewed.set(id, deps.now());
      return hostCall(deps.deadlineMs, (options) =>
        deps.host.renewWatch(placement.hostId, placement.path, options),
      ).pipe(Effect.ignore);
    });

  const forgeIfDue = (threadId: string, placement: Placement) =>
    forge.due(threadId, placement) ? forge.readForge(threadId, placement) : Effect.void;

  /** One look at a watched thread: renew the lease, read GitHub when due, catch up after a reconnect. */
  const tick = Effect.fnUntraced(function* (threadId: string) {
    const where = store.placement(threadId);
    if (where?.state !== "checkout") return yield* deps.refresh(threadId);
    const { placement } = where;
    const facet = store.local(placement.hostId, placement.path);
    if (!(yield* placements.connected(placement.hostId))) {
      if (facet.problem?.kind !== "host-offline") yield* local.readCheckout(placement);
      yield* forgeIfDue(threadId, placement);
      return;
    }
    // Back from offline, or never read: the lease lapsed with it, so read once.
    if (!facet.read || facet.problem) return yield* deps.refresh(threadId);
    yield* renewLease(placement);
    yield* forgeIfDue(threadId, placement);
  });

  /** Changes of the checkout's branch: the forge again when a thread's Change moved. */
  const settleWatched = (threadIds: readonly string[], placement: Placement) =>
    Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const before = deps.keyOf(threadId);
          yield* local.settleBranch(threadId, placement);
          const after = deps.keyOf(threadId);
          if (after && after !== before) yield* forge.readForge(threadId, placement);
        }),
      { concurrency: "unbounded", discard: true },
    );

  return {
    watched,
    /** While a surface watches a thread: read it now, then look at it every tick until interrupted. */
    watch: (threadId: string) =>
      Effect.acquireUseRelease(
        Effect.sync(() => watchers.set(threadId, (watchers.get(threadId) ?? 0) + 1)),
        () =>
          deps
            .refresh(threadId)
            .pipe(
              Effect.andThen(
                tick(threadId).pipe(
                  Effect.ignore,
                  Effect.delay(WATCH_TICK_MS),
                  Effect.repeat(Schedule.forever),
                ),
              ),
            ),
        () =>
          Effect.sync(() => {
            const left = (watchers.get(threadId) ?? 1) - 1;
            if (left > 0) watchers.set(threadId, left);
            else watchers.delete(threadId);
          }),
      ),
    /** The host saw a checkout change: read it again for the threads watching it. */
    checkoutChanged: Effect.fnUntraced(function* (hostId: string, path: string) {
      const watching = store.threadsAt(hostId, path).filter(watched);
      const where = watching[0] ? store.placement(watching[0]) : null;
      if (where?.state !== "checkout") return;
      yield* local.readCheckout(where.placement);
      yield* settleWatched(watching, where.placement);
    }),
    /** A thread's turn ended: in a GitButler checkout, its commands may have named another branch. */
    turnEnded: Effect.fnUntraced(function* (threadId: string) {
      const where = store.placement(threadId);
      if (where?.state !== "checkout") return;
      const { placement } = where;
      if (store.local(placement.hostId, placement.path).read?.value.provider !== "gitbutler")
        return;
      const threads = yield* local.turnEnded(threadId, placement);
      yield* settleWatched(threads.filter(watched), placement);
    }),
    /**
     * The thread's Change as of now, for a caller that cannot wait for the
     * turn to end: its checkout is read, then the `but` commands it ran since
     * its branch was last worked out. A branch answer kept from before the
     * thread's latest commit would otherwise name no branch, or an old one.
     */
    settleNow: Effect.fnUntraced(function* (threadId: string) {
      yield* deps.refresh(threadId);
      const where = store.placement(threadId);
      if (where?.state !== "checkout") return;
      const { placement } = where;
      if (store.local(placement.hostId, placement.path).read?.value.provider !== "gitbutler")
        return;
      yield* local.turnEnded(threadId, placement).pipe(Effect.ignore);
      yield* settleWatched([threadId], placement);
    }),
    /** A background recheck moved a thread's branch. */
    branchMayHaveChanged: Effect.fnUntraced(function* (threadId: string) {
      const where = store.placement(threadId);
      if (!watched(threadId) || where?.state !== "checkout") return;
      yield* settleWatched([threadId], where.placement);
    }),
  };
}
