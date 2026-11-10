/**
 * The local facet: each checkout read from its own host, once for every
 * thread on it, and which of the checkout's branches is each thread's. Knows
 * the host's workspace read and GitButler's branch naming; nothing about
 * GitHub.
 */
import { Effect } from "effect";
import {
  branchesOf,
  failed,
  findBranch,
  succeeded,
  type Facet,
  type Placement,
  type WorkspaceValue,
} from "../core/change.ts";
import { callProblem, failureProblem, hostCall, offline, type HostCalls } from "./host-calls.ts";
import { checkoutId, type Placements } from "./placement.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** Which branch of a shared GitButler checkout a thread works on. */
export type ThreadBranchLookup = {
  branchOf(
    threadId: string,
    place: { environmentId: string; path: string },
  ): Promise<string | null>;
  /** After a turn: reads the thread's new commands; returns every thread whose answer may have moved. */
  turnEnded(threadId: string, place: { environmentId: string; path: string }): Promise<string[]>;
};

export function createLocalReads(deps: {
  store: Store;
  host: HostCalls;
  placements: Placements;
  branches: ThreadBranchLookup;
  share: Share;
  announce: (threadIds: Iterable<string>) => void;
  now: () => number;
  deadlineMs: number;
}) {
  const { store, placements, announce } = deps;

  /** Read one checkout for every thread on it, unless its host is known to be away. */
  const readCheckout = (placement: Placement) =>
    deps.share(
      `checkout:${checkoutId(placement)}`,
      Effect.gen(function* () {
        const { hostId, path } = placement;
        const previous = store.local(hostId, path);
        const threads = store.threadsAt(hostId, path);
        let next: Facet<WorkspaceValue>;
        if (!(yield* placements.connected(hostId))) {
          next = failed(previous, offline(placement));
        } else {
          const answer = yield* hostCall(deps.deadlineMs, (options) =>
            deps.host.workspace(hostId, { path, readAs: store.readAs(hostId, path) }, options),
          ).pipe(Effect.result);
          if (answer._tag === "Failure") {
            const stillConnected = yield* placements.connected(hostId);
            next = failed(previous, callProblem(placement, answer.failure, stillConnected));
          } else if (!answer.success.ok) {
            next = failed(previous, failureProblem(placement, answer.success.error));
          } else if (answer.success.value.state === "workspace") {
            next = succeeded(answer.success.value.value, deps.now());
          } else {
            const reason =
              answer.success.value.state === "not-git"
                ? "This thread's checkout is not a git repository."
                : "This thread's checkout has no branch checked out.";
            announce(placements.clear(threads, reason));
            return;
          }
        }
        if (store.setLocal(hostId, path, next)) announce(threads);
      }),
    );

  /** The thread's branch as last read: the checked-out one, or the one a GitButler thread named. */
  const settleBranch = Effect.fnUntraced(function* (threadId: string, placement: Placement) {
    const workspace = store.local(placement.hostId, placement.path).read?.value;
    if (!workspace) return;
    let branch: string | null = workspace.checkedOut;
    if (workspace.provider === "gitbutler") {
      const named = yield* Effect.tryPromise(() =>
        deps.branches.branchOf(threadId, {
          environmentId: placement.environmentId,
          path: placement.path,
        }),
      ).pipe(Effect.orElseSucceed(() => null));
      const all = branchesOf(workspace);
      branch =
        named && findBranch(workspace, named)
          ? named
          : all.length === 1
            ? all[0]!.branch.name
            : null;
    }
    if (store.setBranch(threadId, branch)) announce([threadId]);
  });

  /** A turn ended: the threads whose GitButler branch it may have moved. */
  const turnEnded = (threadId: string, placement: Placement) =>
    Effect.tryPromise(() =>
      deps.branches.turnEnded(threadId, {
        environmentId: placement.environmentId,
        path: placement.path,
      }),
    );

  return { readCheckout, settleBranch, turnEnded };
}

export type LocalReads = ReturnType<typeof createLocalReads>;
