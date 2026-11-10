/**
 * Each thread's Change: its checkout read from the checkout's host, its pull
 * request from a forge site, stored, and announced by tag. Reads served to
 * clients come from the store only. Hosts are called only while a surface
 * watches a thread, when the host signals a change, or when someone asks.
 *
 * A checkout is read once for every thread on it; a pull request once for
 * every checkout of its branch. The forge read starts with the local read,
 * keyed by the last known ChangeKey, so a slow or sleeping host never holds
 * GitHub's answer back. A host bb already knows is disconnected is not called.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  branchesOf,
  changeKeyForBranch,
  EMPTY_FACET,
  failed,
  findBranch,
  remoteBranchName,
  succeeded,
  type Facet,
  type Patches,
  type PatchSource,
  type Placement,
  type Problem,
  type Revision,
  type ThreadChange,
  type VcsAction,
  type VcsResult,
  type WorkspaceValue,
} from "../core/change.ts";
import { threadTag, type ChangeKey } from "../core/ids.ts";
import type { HostFailure, HostWorkspace, ReadAs } from "../contract/host.ts";
import { ForgeReadError, type createForgeSites } from "./forge-sites.ts";
import type { Store, ThreadPlacement } from "./store.ts";

export const HOST_DEADLINE_MS = 10_000;
/**
 * While a surface watches: how often the host's watch lease is renewed (no
 * read), and the pull request read again. Local changes arrive by signal.
 */
export const WATCH_TICK_MS = 60_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: HostFailure };
type CallOptions = { signal: AbortSignal; timeoutMs: number };

/** The host calls the server makes, bound to a host by id. */
export type HostCalls = {
  workspace(
    hostId: string,
    input: { path: string; readAs: ReadAs },
    options: CallOptions,
  ): Promise<Outcome<HostWorkspace>>;
  renewWatch(hostId: string, path: string, options: CallOptions): Promise<unknown>;
  vcsAction(
    hostId: string,
    input: { path: string; readAs: ReadAs; action: VcsAction; expected: Revision },
    options: CallOptions,
  ): Promise<VcsResult>;
  patches(
    hostId: string,
    input: { path: string; readAs: ReadAs; source: PatchSource },
    options: CallOptions,
  ): Promise<Outcome<Patches>>;
};

/** Which branch of a shared GitButler checkout a thread works on. */
export type ThreadBranchLookup = {
  branchOf(
    threadId: string,
    place: { environmentId: string; path: string },
  ): Promise<string | null>;
  /** After a turn: reads the thread's new commands; returns every thread whose answer may have moved. */
  turnEnded(threadId: string, place: { environmentId: string; path: string }): Promise<string[]>;
};

export type ThreadChangesDeps = {
  bb: BbPluginApi;
  store: Store;
  sites: ReturnType<typeof createForgeSites>;
  host: HostCalls;
  branches: ThreadBranchLookup;
  now: () => number;
  /** Aborts when the plugin instance goes away. */
  lifecycle: AbortSignal;
  actionDeadlineMs: number;
  /** How long a host read may take before the host counts as offline. */
  hostDeadlineMs?: number;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const checkoutId = (placement: { hostId: string; path: string }) =>
  `${placement.hostId}\0${placement.path}`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The call's answer, or a rejection once `deadline` aborts. A host call does
 * not settle on its signal alone: the SDK resends a retryable read and only
 * fails it after its own longer budget.
 */
function before<T>(deadline: AbortSignal, call: Promise<T>): Promise<T> {
  if (deadline.aborted) return Promise.reject(deadline.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(deadline.reason);
    deadline.addEventListener("abort", stop, { once: true });
    call.then(resolve, reject).finally(() => deadline.removeEventListener("abort", stop));
  });
}

/** One promise per key while it runs: later callers share it. */
function coalescer() {
  const running = new Map<string, Promise<void>>();
  return (key: string, run: () => Promise<void>): Promise<void> => {
    const current = running.get(key);
    if (current) return current;
    const started = run().finally(() => running.delete(key));
    running.set(key, started);
    return started;
  };
}

export function createThreadChanges(deps: ThreadChangesDeps) {
  const { bb, store, sites, now, lifecycle } = deps;
  const hostDeadlineMs = deps.hostDeadlineMs ?? HOST_DEADLINE_MS;
  const checkoutRead = coalescer();
  const forgeRead = coalescer();
  const threadRead = coalescer();
  const hostNames = new Map<string, string>();
  /** Watchers per thread, and the threads each ChangeKey was last shown for. */
  const watchers = new Map<string, number>();
  const keyThreads = new Map<ChangeKey, Set<string>>();

  function announce(threadIds: Iterable<string>): void {
    if (lifecycle.aborted) return;
    const tags = [...new Set(threadIds)].map(threadTag);
    if (tags.length > 0) bb.rpc.experimental_invalidate(tags);
  }

  async function hostName(hostId: string): Promise<string> {
    const known = hostNames.get(hostId);
    if (known) return known;
    const host = await bb.sdk.hosts.get({ hostId }).catch(() => null);
    const name = host?.name ?? hostId;
    hostNames.set(hostId, name);
    return name;
  }

  /** Whether bb has the host connected now. Unknown counts as connected: the call's deadline decides. */
  async function connected(hostId: string): Promise<boolean> {
    const host = await bb.sdk.hosts.get({ hostId }).catch(() => null);
    return host?.status !== "disconnected";
  }

  /** Where the thread's checkout is now, resolved from its environment. */
  async function resolvePlacement(threadId: string): Promise<ThreadPlacement> {
    const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
    const environment = "environment" in thread ? thread.environment : undefined;
    if (!environment) return { state: "none", reason: "This thread has no project environment." };
    if (!environment.path)
      return { state: "none", reason: "This thread's environment has no workspace path yet." };
    if (environment.status !== "ready")
      return { state: "none", reason: `This thread's environment is ${environment.status}.` };
    return {
      state: "checkout",
      placement: {
        hostId: environment.hostId,
        hostName: await hostName(environment.hostId),
        path: environment.path,
        environmentId: environment.id,
      },
    };
  }

  /** Why a host call failed, as a problem naming the host. */
  async function hostProblem(placement: Placement, error: unknown): Promise<Problem> {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || /timed? ?out/i.test(error.message));
    if (timedOut || !(await connected(placement.hostId)))
      return { kind: "host-offline", host: placement.hostName };
    return { kind: "failed", site: placement.hostName, detail: message(error) };
  }

  function failureProblem(placement: Placement, failure: HostFailure): Problem {
    if (failure.code === "git-missing" || failure.code === "but-missing")
      return {
        kind: "tool-missing",
        tool: failure.code === "git-missing" ? "git" : "but",
        host: placement.hostName,
        detail: failure.message,
      };
    return { kind: "failed", site: placement.hostName, detail: failure.message };
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

  /** Read one checkout for every thread on it, unless its host is known to be away. */
  function readCheckout(placement: Placement): Promise<void> {
    return checkoutRead(checkoutId(placement), async () => {
      const { hostId, path } = placement;
      const previous = store.local(hostId, path);
      const threads = store.threadsAt(hostId, path);
      let next: Facet<WorkspaceValue>;
      if (!(await connected(hostId))) {
        next = failed(previous, { kind: "host-offline", host: placement.hostName });
      } else {
        // The SDK resends a retryable read halfway through its timeout, so the
        // deadline is held here too: a hung host is offline at HOST_DEADLINE_MS.
        const deadline = AbortSignal.timeout(hostDeadlineMs);
        try {
          const answer = await before(
            deadline,
            deps.host.workspace(
              hostId,
              { path, readAs: store.readAs(hostId, path) },
              { signal: AbortSignal.any([lifecycle, deadline]), timeoutMs: hostDeadlineMs },
            ),
          );
          if (!answer.ok) next = failed(previous, failureProblem(placement, answer.error));
          else if (answer.value.state === "workspace") next = succeeded(answer.value.value, now());
          else {
            const reason =
              answer.value.state === "not-git"
                ? "This thread's checkout is not a git repository."
                : "This thread's checkout has no branch checked out.";
            for (const threadId of threads)
              store.setPlacement(threadId, { state: "none", reason }, now());
            announce(threads);
            return;
          }
        } catch (error) {
          if (lifecycle.aborted) throw error;
          next = failed(
            previous,
            deadline.aborted
              ? { kind: "host-offline", host: placement.hostName }
              : await hostProblem(placement, error),
          );
        }
      }
      store.setLocal(hostId, path, next);
      announce(threads);
    });
  }

  /** The thread's branch in the checkout as last read: the checked-out one, or the one it named. */
  async function settleBranch(threadId: string, placement: Placement): Promise<void> {
    const workspace = store.local(placement.hostId, placement.path).read?.value;
    if (!workspace) return;
    let branch: string | null = workspace.checkedOut;
    if (workspace.provider === "gitbutler") {
      const named = await deps.branches
        .branchOf(threadId, { environmentId: placement.environmentId, path: placement.path })
        .catch(() => null);
      const all = branchesOf(workspace);
      branch =
        named && findBranch(workspace, named)
          ? named
          : all.length === 1
            ? all[0]!.branch.name
            : null;
    }
    if (store.branch(threadId) !== branch) {
      store.setBranch(threadId, branch);
      announce([threadId]);
    }
  }

  /** Read the pull request of the thread's Change as the store knows it now. */
  function readForge(threadId: string, placement: Placement): Promise<ChangeKey | null> {
    const workspace = store.local(placement.hostId, placement.path).read?.value;
    const branch = workspace ? findBranch(workspace, store.branch(threadId)) : null;
    if (!workspace || !branch || !workspace.github) return Promise.resolve(null);
    const key = changeKeyForBranch(placement.hostId, workspace, branch);
    const { github } = workspace;
    return forgeRead(key, async () => {
      const previous = store.forge(key);
      try {
        const pr = await sites.pullRequest(
          { repo: github.repo, headOwner: github.headOwner, branch: remoteBranchName(branch) },
          placement,
          lifecycle,
        );
        store.setForge(key, succeeded(pr, now()));
      } catch (error) {
        if (error instanceof ForgeReadError) store.setForge(key, failed(previous, error.problem));
        else if (lifecycle.aborted) throw error;
        else
          store.setForge(
            key,
            failed(previous, { kind: "failed", site: "GitHub", detail: message(error) }),
          );
      }
      announce([threadId, ...(keyThreads.get(key) ?? [])]);
    }).then(() => key);
  }

  /** Local and forge together; the forge again if the local read moved the Change. */
  async function refreshNow(threadId: string): Promise<void> {
    const where = await resolvePlacement(threadId);
    store.setPlacement(threadId, where, now());
    if (where.state === "none") return announce([threadId]);
    const { placement } = where;
    const forgeFirst = readForge(threadId, placement);
    await readCheckout(placement);
    await settleBranch(threadId, placement);
    const keyBefore = await forgeFirst;
    const current = row(threadId);
    if (current.state === "checkout" && current.key && current.key !== keyBefore)
      await readForge(threadId, placement);
  }

  /** Read the thread now; concurrent requests for one thread share one read. */
  function refresh(threadId: string): Promise<void> {
    return threadRead(threadId, () =>
      refreshNow(threadId)
        .catch((error: unknown) => {
          if (!lifecycle.aborted)
            bb.log.warn(`Could not read the Change of ${threadId}: ${message(error)}`);
        })
        .finally(() => announce([threadId])),
    );
  }

  /** A watched tick: renew the host's watch (no read), re-read GitHub, and catch up after a reconnect. */
  async function tick(threadId: string): Promise<void> {
    const where = store.placement(threadId);
    if (!where || where.state !== "checkout") return refresh(threadId);
    const { placement } = where;
    const local = store.local(placement.hostId, placement.path);
    if (!(await connected(placement.hostId))) {
      if (local.problem?.kind !== "host-offline") await readCheckout(placement);
      await readForge(threadId, placement);
      return;
    }
    // Back from offline, or never read: the watch lapsed with it, so read once.
    if (!local.read || local.problem) return refresh(threadId);
    const deadline = AbortSignal.timeout(hostDeadlineMs);
    await before(
      deadline,
      deps.host.renewWatch(placement.hostId, placement.path, {
        signal: AbortSignal.any([lifecycle, deadline]),
        timeoutMs: hostDeadlineMs,
      }),
    ).catch(() => undefined);
    await readForge(threadId, placement);
  }

  return {
    /** Stored rows only: serving a read never calls a host. */
    read(keys: readonly string[]): Record<string, ThreadChange> {
      return Object.fromEntries(keys.map((threadId) => [threadId, row(threadId)]));
    },
    refresh,
    /** Explicit retry: probe forge sites again, then read. */
    async retry(threadId: string): Promise<void> {
      sites.reprobe();
      await refresh(threadId);
    },
    /** While a surface watches a thread: read it now, then keep its host watch alive. */
    async watch(threadId: string, signal: AbortSignal): Promise<void> {
      watchers.set(threadId, (watchers.get(threadId) ?? 0) + 1);
      try {
        await refresh(threadId);
        const stop = AbortSignal.any([signal, lifecycle]);
        while (!stop.aborted) {
          await sleep(WATCH_TICK_MS, stop);
          if (stop.aborted) break;
          await tick(threadId).catch(() => undefined);
        }
      } finally {
        const left = (watchers.get(threadId) ?? 1) - 1;
        if (left > 0) watchers.set(threadId, left);
        else watchers.delete(threadId);
      }
    },
    /** The host saw a checkout change: read it again for the threads watching it. */
    async checkoutChanged(hostId: string, path: string): Promise<void> {
      const watching = store.threadsAt(hostId, path).filter((threadId) => watchers.has(threadId));
      if (watching.length === 0) return;
      const where = store.placement(watching[0]!);
      if (where?.state !== "checkout") return;
      await readCheckout(where.placement);
      await Promise.all(
        watching.map(async (threadId) => {
          const before = row(threadId);
          await settleBranch(threadId, where.placement);
          const after = row(threadId);
          const keyOf = (change: ThreadChange) => (change.state === "checkout" ? change.key : null);
          if (keyOf(after) && keyOf(after) !== keyOf(before))
            await readForge(threadId, where.placement);
        }),
      );
    },
    /** A thread's turn ended: in a GitButler checkout, its commands may have named another branch. */
    async turnEnded(threadId: string): Promise<void> {
      const where = store.placement(threadId);
      if (where?.state !== "checkout") return;
      const { placement } = where;
      if (store.local(placement.hostId, placement.path).read?.value.provider !== "gitbutler")
        return;
      const threads = await deps.branches.turnEnded(threadId, {
        environmentId: placement.environmentId,
        path: placement.path,
      });
      await Promise.all(
        threads.filter((id) => watchers.has(id)).map((id) => settleBranch(id, placement)),
      );
    },
    /** A background recheck moved a thread's branch. */
    async branchMayHaveChanged(threadId: string): Promise<void> {
      if (!watchers.has(threadId)) return;
      const where = store.placement(threadId);
      if (where?.state !== "checkout") return;
      await settleBranch(threadId, where.placement);
    },
    /** One write on the thread's checkout, at the revision the reader saw. Never retried. */
    async act(threadId: string, action: VcsAction, expected: Revision): Promise<VcsResult> {
      const stored = store.placement(threadId);
      const current = await resolvePlacement(threadId);
      if (
        current.state !== "checkout" ||
        stored?.state !== "checkout" ||
        checkoutId(stored.placement) !== checkoutId(current.placement)
      )
        return {
          status: "failed",
          problem: {
            kind: "moved",
            detail: "Look at it again before writing to it.",
          },
        };
      const { placement } = current;
      // Read as plain git, a GitButler workspace's branch is GitButler's own: writing to it would push or land that.
      if (store.readAs(placement.hostId, placement.path) === "git")
        return {
          status: "failed",
          problem: {
            kind: "failed",
            site: placement.hostName,
            detail:
              "Writes are off while this checkout is read as plain git. Read it as GitButler again first.",
          },
        };
      if (!(await connected(placement.hostId)))
        return { status: "failed", problem: { kind: "host-offline", host: placement.hostName } };
      let result: VcsResult;
      try {
        result = await deps.host.vcsAction(
          placement.hostId,
          {
            path: placement.path,
            readAs: store.readAs(placement.hostId, placement.path),
            action,
            expected,
          },
          { signal: lifecycle, timeoutMs: deps.actionDeadlineMs },
        );
      } catch (error) {
        result = {
          status: "failed",
          problem: {
            kind: "failed",
            site: placement.hostName,
            detail: `bb lost track of the write, so whether it ran is unknown: ${message(error)}`,
          },
        };
      }
      if (result.status === "failed")
        result = { ...result, problem: named(result.problem, placement) };
      // The checkout moved or was written: read it again either way.
      void refresh(threadId);
      return result;
    },
    async setReadAs(threadId: string, readAs: ReadAs): Promise<void> {
      const where = store.placement(threadId) ?? (await resolvePlacement(threadId));
      if (where.state !== "checkout") return;
      store.setReadAs(where.placement.hostId, where.placement.path, readAs);
      await refresh(threadId);
    },
    async patches(
      threadId: string,
      source: PatchSource,
      signal: AbortSignal,
    ): Promise<{ ok: true; value: Patches } | { ok: false; problem: Problem }> {
      const where = store.placement(threadId);
      if (where?.state !== "checkout")
        return { ok: false, problem: { kind: "moved", detail: "This thread has no checkout." } };
      const { placement } = where;
      if (!(await connected(placement.hostId)))
        return { ok: false, problem: { kind: "host-offline", host: placement.hostName } };
      try {
        const deadline = AbortSignal.timeout(hostDeadlineMs);
        const answer = await before(
          deadline,
          deps.host.patches(
            placement.hostId,
            {
              path: placement.path,
              readAs: store.readAs(placement.hostId, placement.path),
              source,
            },
            { signal: AbortSignal.any([signal, lifecycle, deadline]), timeoutMs: hostDeadlineMs },
          ),
        );
        return answer.ok
          ? { ok: true, value: answer.value }
          : { ok: false, problem: failureProblem(placement, answer.error) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false, problem: await hostProblem(placement, error) };
      }
    },
  };
}

/** A host names itself "host" in problems; the server knows its name. */
function named(problem: Problem, placement: Placement): Problem {
  if (problem.kind === "failed" && problem.site === "host")
    return { ...problem, site: placement.hostName };
  if (problem.kind === "tool-missing" && problem.host === "host")
    return { ...problem, host: placement.hostName };
  return problem;
}
