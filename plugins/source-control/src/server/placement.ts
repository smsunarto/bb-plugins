/**
 * Where each thread's checkout is: resolved from the thread's environment
 * through bb, never by listing hosts, and stored so every read can be served
 * without asking bb again. Knows bb's threads and hosts; nothing about git.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Effect } from "effect";
import type { Placement } from "../core/change.ts";
import { githubRepo, type Repo } from "../core/ids.ts";
import type { ForgeHost } from "./forge-sites.ts";
import { HOST_REMOVED, type Store, type ThreadPlacement } from "./store.ts";

/** What bb keeps of a thread's environment after its worktree goes. */
export type RecordedEnvironment = { branchName: string; hostId: string; projectId: string };

export const checkoutId = (placement: { hostId: string; path: string }) =>
  `${placement.hostId}\0${placement.path}`;

const GONE = Symbol("host gone");

/** The SDK's `BbHttpError` carries the HTTP status: 404 is bb's `host_not_found`. */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export function createPlacements(deps: { bb: BbPluginApi; store: Store; now: () => number }) {
  const { bb, store } = deps;
  const names = new Map<string, string>();

  /** The host's record; `GONE` when bb answers that it has no such machine; null when bb did not answer. */
  const lookup = (hostId: string) =>
    Effect.promise(() =>
      bb.sdk.hosts.get({ hostId }).then(
        (record) => record,
        (error: unknown) => (isNotFound(error) ? GONE : null),
      ),
    );
  const host = (hostId: string) =>
    lookup(hostId).pipe(Effect.map((record) => (record === GONE ? null : record)));

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
    // bb keeps a removed machine's environments pointing at it: the machine is what says it is gone.
    const record = yield* lookup(environment.hostId);
    if (record === GONE) return { state: "none", reason: HOST_REMOVED } as const;
    const hostName = names.get(environment.hostId) ?? record?.name ?? environment.hostId;
    if (record) names.set(environment.hostId, hostName);
    const placement: Placement = {
      hostId: environment.hostId,
      hostName,
      path: environment.path,
      environmentId: environment.id,
    };
    return { state: "checkout", placement } as const;
  });

  const threadEnvironment = (threadId: string) =>
    Effect.tryPromise(() => bb.sdk.threads.get({ threadId, include: "environment" })).pipe(
      Effect.map((thread) => ("environment" in thread ? thread.environment : undefined)),
    );

  /** Where the thread's checkout is now, and what bb recorded of its environment. */
  const resolveThread = Effect.fn("resolvePlacement")(function* (threadId: string) {
    const environment = yield* threadEnvironment(threadId);
    if (!environment)
      return {
        where: { state: "none", reason: "This thread has no project environment." } as const,
        environment: null,
      };
    // bb keeps the branch, host and project after it removes the worktree.
    const recorded: RecordedEnvironment | null = environment.branchName
      ? {
          branchName: environment.branchName,
          hostId: environment.hostId,
          projectId: environment.projectId,
        }
      : null;
    return { where: yield* placementOf(environment), environment: recorded };
  });

  /** Where the thread's checkout is now. */
  const resolve = (threadId: string) =>
    resolveThread(threadId).pipe(Effect.map((resolved) => resolved.where));

  /** Where an environment's checkout is now, by its id. */
  const forEnvironment = Effect.fn("environmentPlacement")(function* (environmentId: string) {
    const environment = yield* Effect.tryPromise(() => bb.sdk.environments.get({ environmentId }));
    return yield* placementOf(environment);
  });

  /** Each project's GitHub repository, from its remote; null for none. Remotes rarely move. */
  const repos = new Map<string, Repo | null>();
  const projectRepo = (projectId: string) =>
    Effect.suspend(() => {
      if (repos.has(projectId)) return Effect.succeed(repos.get(projectId) ?? null);
      return Effect.tryPromise(() => bb.sdk.projects.get({ projectId })).pipe(
        Effect.map((project) => githubRepo(project.gitRemoteUrl ?? null)),
        Effect.tap((repo) => Effect.sync(() => repos.set(projectId, repo))),
        // A failed lookup has not established that the project lacks a GitHub remote.
        Effect.orElseSucceed(() => undefined),
      );
    });

  return {
    connected,
    resolve,
    projectRepo,
    /** A host as a forge read names it: bb's name for it, else its id. */
    forgeHost: (hostId: string) =>
      host(hostId).pipe(
        Effect.map((record): ForgeHost => ({
          hostId,
          hostName: names.get(hostId) ?? record?.name ?? hostId,
        })),
      ),
    /** A PR lookup needs the selected machine, even before its checkout is ready. */
    threadForgeHost: Effect.fnUntraced(
      function* (threadId: string) {
        const environment = yield* threadEnvironment(threadId);
        if (!environment) return null;
        const { hostId } = environment;
        const record = yield* lookup(hostId);
        if (record === GONE) return null;
        return {
          hostId,
          hostName: names.get(hostId) ?? record?.name ?? hostId,
        } satisfies ForgeHost;
      },
      (effect) =>
        effect.pipe(
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => null),
        ),
    ),
    forEnvironment,
    /**
     * Resolve and store the thread's placement; `changed` when the stored one
     * moved. `environment` is what bb recorded of the thread's environment.
     */
    settle: Effect.fnUntraced(function* (threadId: string) {
      const resolved = yield* resolveThread(threadId);
      const where: ThreadPlacement = resolved.where;
      return {
        where,
        environment: resolved.environment,
        changed: store.setPlacement(threadId, where, deps.now()),
      };
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
