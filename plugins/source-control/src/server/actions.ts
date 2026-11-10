/**
 * Writes to a thread's checkout and the reads a write leans on: each write
 * goes to the checkout the reader saw, at the revision the reader saw, and is
 * never retried. Knows which placement a write may use; the host decides
 * whether the revision still holds.
 */
import { Effect } from "effect";
import type {
  Patches,
  PatchSource,
  Problem,
  Revision,
  VcsAction,
  VcsResult,
} from "../core/change.ts";
import type { ReadAs } from "../contract/host.ts";
import {
  callProblem,
  failureProblem,
  hostCall,
  message,
  named,
  offline,
  type HostCalls,
} from "./host-calls.ts";
import { checkoutId, type Placements } from "./placement.ts";
import type { Store } from "./store.ts";

export function createActions(deps: {
  store: Store;
  host: HostCalls;
  placements: Placements;
  /** Read the thread again without waiting for it. */
  startRefresh: (threadId: string) => Effect.Effect<void>;
  refresh: (threadId: string) => Effect.Effect<void>;
  announce: (threadIds: Iterable<string>) => void;
  actionDeadlineMs: number;
  hostDeadlineMs: number;
}) {
  const { store, placements } = deps;

  const act = Effect.fn("vcsAction")(function* (
    threadId: string,
    action: VcsAction,
    expected: Revision,
  ) {
    const stored = store.placement(threadId);
    const current = yield* placements.resolve(threadId);
    if (
      current.state !== "checkout" ||
      stored?.state !== "checkout" ||
      checkoutId(stored.placement) !== checkoutId(current.placement)
    )
      return {
        status: "failed",
        problem: { kind: "moved", detail: "Look at it again before writing to it." },
      } satisfies VcsResult;
    const { placement } = current;
    const readAs = store.readAs(placement.hostId, placement.path);
    // Read as plain git, a GitButler workspace's branch is GitButler's own: writing to it would push or land that.
    if (readAs === "git")
      return {
        status: "failed",
        problem: {
          kind: "failed",
          site: placement.hostName,
          detail:
            "Writes are off while this checkout is read as plain git. Read it as GitButler again first.",
        },
      } satisfies VcsResult;
    if (!(yield* placements.connected(placement.hostId)))
      return { status: "failed", problem: offline(placement) } satisfies VcsResult;
    const result: VcsResult = yield* Effect.tryPromise({
      try: (signal) =>
        deps.host.vcsAction(
          placement.hostId,
          { path: placement.path, readAs, action, expected },
          { signal, timeoutMs: deps.actionDeadlineMs },
        ),
      catch: (error) => error,
    }).pipe(
      Effect.map((answer) =>
        answer.status === "failed"
          ? { ...answer, problem: named(answer.problem, placement) }
          : answer,
      ),
      Effect.catch((error) =>
        Effect.succeed<VcsResult>({
          status: "failed",
          problem: {
            kind: "failed",
            site: placement.hostName,
            detail: `bb lost track of the write, so whether it ran is unknown: ${message(error)}`,
          },
        }),
      ),
    );
    // The checkout moved or was written: read it again either way.
    yield* deps.startRefresh(threadId);
    return result;
  });

  const setReadAs = Effect.fn("setReadAs")(function* (threadId: string, readAs: ReadAs) {
    const where = store.placement(threadId) ?? (yield* placements.resolve(threadId));
    if (where.state !== "checkout") return;
    const { hostId, path } = where.placement;
    if (store.setReadAs(hostId, path, readAs)) deps.announce(store.threadsAt(hostId, path));
    yield* deps.refresh(threadId);
  });

  const patches = Effect.fn("patches")(function* (threadId: string, source: PatchSource) {
    const where = store.placement(threadId);
    if (where?.state !== "checkout")
      return {
        ok: false,
        problem: { kind: "moved", detail: "This thread has no checkout." },
      } as const;
    const { placement } = where;
    if (!(yield* placements.connected(placement.hostId)))
      return { ok: false, problem: offline(placement) } as const;
    const answer = yield* hostCall(deps.hostDeadlineMs, (options) =>
      deps.host.patches(
        placement.hostId,
        {
          path: placement.path,
          readAs: store.readAs(placement.hostId, placement.path),
          source,
        },
        options,
      ),
    ).pipe(Effect.result);
    if (answer._tag === "Failure") {
      const stillConnected = yield* placements.connected(placement.hostId);
      return {
        ok: false,
        problem: callProblem(placement, answer.failure, stillConnected),
      } as const;
    }
    return answer.success.ok
      ? ({ ok: true, value: answer.success.value } as { ok: true; value: Patches })
      : ({ ok: false, problem: failureProblem(placement, answer.success.error) } as {
          ok: false;
          problem: Problem;
        });
  });

  return { act, setReadAs, patches };
}
