/**
 * Where each thread's checkout is: resolved from the thread's environment
 * through bb, never by listing hosts, and stored so every read can be served
 * without asking bb again. Knows bb's threads and hosts; nothing about git.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Effect } from "effect";
import type { Placement } from "../core/change.ts";
import type { Store, ThreadPlacement } from "./store.ts";

export const checkoutId = (placement: { hostId: string; path: string }) =>
  `${placement.hostId}\0${placement.path}`;

export function createPlacements(deps: { bb: BbPluginApi; store: Store; now: () => number }) {
  const { bb, store } = deps;
  const names = new Map<string, string>();

  const host = (hostId: string) =>
    Effect.tryPromise(() => bb.sdk.hosts.get({ hostId })).pipe(Effect.orElseSucceed(() => null));

  const hostName = Effect.fnUntraced(function* (hostId: string) {
    const known = names.get(hostId);
    if (known) return known;
    const name = (yield* host(hostId))?.name ?? hostId;
    names.set(hostId, name);
    return name;
  });

  /** Whether bb has the host connected now. Unknown counts as connected: the call's deadline decides. */
  const connected = (hostId: string) =>
    host(hostId).pipe(Effect.map((record) => record?.status !== "disconnected"));

  /** Where an environment's checkout is, or why it has none. */
  const placementOf = Effect.fnUntraced(function* (environment: {
    id: string;
    hostId: string;
    path: string | null;
    status: string;
  }) {
    if (!environment.path)
      return {
        state: "none",
        reason: "This thread's environment has no workspace path yet.",
      } as const;
    if (environment.status !== "ready")
      return {
        state: "none",
        reason: `This thread's environment is ${environment.status}.`,
      } as const;
    const placement: Placement = {
      hostId: environment.hostId,
      hostName: yield* hostName(environment.hostId),
      path: environment.path,
      environmentId: environment.id,
    };
    return { state: "checkout", placement } as const;
  });

  /** Where the thread's checkout is now. */
  const resolve = Effect.fn("resolvePlacement")(function* (threadId: string) {
    const thread = yield* Effect.tryPromise(() =>
      bb.sdk.threads.get({ threadId, include: "environment" }),
    );
    const environment = "environment" in thread ? thread.environment : undefined;
    if (!environment)
      return { state: "none", reason: "This thread has no project environment." } as const;
    return yield* placementOf(environment);
  });

  /** Where an environment's checkout is now, by its id. */
  const forEnvironment = Effect.fn("environmentPlacement")(function* (environmentId: string) {
    const environment = yield* Effect.tryPromise(() => bb.sdk.environments.get({ environmentId }));
    return yield* placementOf(environment);
  });

  return {
    connected,
    resolve,
    forEnvironment,
    /** Resolve and store the thread's placement; `changed` when the stored one moved. */
    settle: Effect.fnUntraced(function* (threadId: string) {
      const where: ThreadPlacement = yield* resolve(threadId);
      return { where, changed: store.setPlacement(threadId, where, deps.now()) };
    }),
    /** Mark every thread on a checkout as having no Change, for `reason`; returns those that moved. */
    clear(threadIds: readonly string[], reason: string): string[] {
      return threadIds.filter((threadId) =>
        store.setPlacement(threadId, { state: "none", reason }, deps.now()),
      );
    },
  };
}

export type Placements = ReturnType<typeof createPlacements>;
