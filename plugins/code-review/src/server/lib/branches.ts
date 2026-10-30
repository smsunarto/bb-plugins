import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Cause, Effect } from "effect";
import type { LocalBranch, LocalBranches } from "../../shared/schema.ts";
import { loadLocalBranches, rememberBranch } from "./gitbutler.ts";
import { type Run, runDetached } from "./run.ts";
import type { Store } from "./store.ts";

/*
 * Where an unpublished branch's card reads it. A card refreshes only its
 * checkout. A legacy card, which names no checkout, asks every connected
 * machine at once and takes the first that has the branch, so an unrelated
 * slow machine never holds it hostage, then remembers where it was found.
 */

const MISSING = "This branch is no longer unpublished, or its machine is offline.";

export type BranchFinder = {
  /** The branch `id` names, read where it lives. `threadId` names a checkout to try. */
  find(id: string, threadId?: string): Promise<LocalBranch>;
};

/** Where to look: a machine, or one checkout on it. */
type Where = { hostId: string; path?: string };

export function createBranchFinder({
  bb,
  store,
  run = runDetached,
}: {
  bb: BbPluginApi;
  store: Store;
  run?: Run;
}): BranchFinder {
  // A machine's discovery does not stop for a card that stops waiting, so
  // every legacy card shares it until it settles, even when their ids
  // differ: a slow machine gets one discovery at a time, not one per refresh.
  const discoveries = new Map<string, Promise<LocalBranches>>();
  const discover = (hostId: string) => {
    const running = discoveries.get(hostId);
    if (running) return running;
    const discovery = loadLocalBranches(bb, undefined, { hostId })
      .then(async (result) => {
        if (result.available) {
          await Promise.all(result.branches.map((branch) => rememberBranch(bb, store, branch)));
        }
        return result;
      })
      .finally(() => discoveries.delete(hostId));
    discoveries.set(hostId, discovery);
    return discovery;
  };

  const read = Effect.fnUntraced(function* (id: string, scope: Where) {
    const result = yield* Effect.tryPromise({
      try: async (signal) =>
        scope.path ? loadLocalBranches(bb, signal, scope) : discover(scope.hostId),
      catch: (error) => error,
    });
    if (!result.available) return yield* Effect.fail(new Error(result.reason));
    const branch = result.branches.find((each) => each.id === id);
    if (!branch) return yield* Effect.fail(new Error(MISSING));
    return branch;
  });

  // Old cards usually name this thread's checkout. Read it independently of
  // other repositories on the same machine, which may be slow or unavailable.
  const checkout = Effect.fnUntraced(function* (id: string, threadId: string) {
    const thread = yield* Effect.tryPromise({
      try: async () => bb.sdk.threads.get({ threadId, include: "environment" }),
      catch: (error) => error,
    });
    const environment = "environment" in thread ? thread.environment : null;
    if (!environment?.path || environment.status !== "ready") {
      return yield* Effect.fail(new Error(MISSING));
    }
    return yield* read(id, { hostId: environment.hostId, path: environment.path });
  });

  return {
    find: (id, threadId) =>
      run(
        Effect.gen(function* () {
          const location = yield* Effect.promise(async () => store.branchLocation(id));
          if (location) return yield* read(id, location);
          // An unrelated slow machine must not hold a matching branch's card hostage.
          const hosts = (yield* Effect.promise(async () => bb.sdk.hosts.list())).filter(
            (host) => host.status === "connected",
          );
          const branch = yield* first([
            ...hosts.map((host) => read(id, { hostId: host.id })),
            ...(threadId ? [checkout(id, threadId)] : []),
          ]);
          yield* Effect.promise(async () => rememberBranch(bb, store, branch));
          return branch;
        }),
      ),
  };
}

/**
 * The first read to find the branch; the rest stop. When none does, every
 * distinct reason, in the reads' order.
 */
function first(reads: Effect.Effect<LocalBranch, unknown>[]): Effect.Effect<LocalBranch, unknown> {
  const failed: [number, unknown][] = [];
  const missing = () => {
    const errors = failed.toSorted(([a], [b]) => a - b).map(([, error]) => error);
    const reasons = new Set(
      errors.map((each) => (each instanceof Error ? each.message : String(each))),
    );
    return new Error([...reasons].join("; ") || MISSING, { cause: new AggregateError(errors) });
  };
  if (reads.length === 0) return Effect.fail(missing());
  return Effect.raceAll(
    reads.map((each, index) =>
      Effect.tapError(each, (error) => Effect.sync(() => failed.push([index, error]))),
    ),
  ).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(missing()),
    ),
  );
}
