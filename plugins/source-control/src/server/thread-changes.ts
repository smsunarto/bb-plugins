/**
 * Each thread's Change: read from the thread's own checkout host and from a
 * forge site, stored, and announced by tag. Reads served to clients come
 * from the store only; hosts are called only by a refresh, which runs while
 * a surface watches the thread or when someone asks to try again.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  failed,
  succeeded,
  type Facet,
  type LocalValue,
  type Placement,
  type Problem,
  type ThreadChange,
} from "../core/change.ts";
import { threadTag } from "../core/ids.ts";
import type { HostFailure, HostWorkspace } from "../contract/host.ts";
import { ForgeReadError, type createForgeSites } from "./forge-sites.ts";
import { keyOf, type Store, type ThreadPlacement } from "./store.ts";

export const HOST_DEADLINE_MS = 10_000;
/** How often a watched thread is read again until host watch signals arrive (Phase 2). */
export const WATCH_INTERVAL_MS = 30_000;

export type HostWorkspaceCall = (
  hostId: string,
  path: string,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ ok: true; value: HostWorkspace } | { ok: false; error: HostFailure }>;

export type ThreadChangesDeps = {
  bb: BbPluginApi;
  store: Store;
  sites: ReturnType<typeof createForgeSites>;
  workspace: HostWorkspaceCall;
  now: () => number;
  /** Aborts when the plugin instance goes away. */
  lifecycle: AbortSignal;
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

export function createThreadChanges(deps: ThreadChangesDeps) {
  const { bb, store, sites, now } = deps;
  const inFlight = new Map<string, Promise<void>>();
  const hostNames = new Map<string, string>();

  async function hostName(hostId: string): Promise<string> {
    const known = hostNames.get(hostId);
    if (known) return known;
    const host = await bb.sdk.hosts.get({ hostId }).catch(() => null);
    const name = host?.name ?? hostId;
    hostNames.set(hostId, name);
    return name;
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
    const host = await bb.sdk.hosts.get({ hostId: placement.hostId }).catch(() => null);
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || /timed? ?out/i.test(error.message));
    if (host?.status === "disconnected" || timedOut || !host)
      return { kind: "host-offline", host: placement.hostName };
    return {
      kind: "failed",
      site: placement.hostName,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  async function readLocal(
    placement: Placement,
    signal: AbortSignal,
  ): Promise<Facet<LocalValue> | ThreadPlacement> {
    const previous = store.local(placement.hostId, placement.path);
    try {
      const answer = await deps.workspace(placement.hostId, placement.path, {
        signal,
        timeoutMs: HOST_DEADLINE_MS,
      });
      if (!answer.ok) {
        const problem: Problem =
          answer.error.code === "git-missing"
            ? {
                kind: "tool-missing",
                tool: "git",
                host: placement.hostName,
                detail: answer.error.message,
              }
            : { kind: "failed", site: placement.hostName, detail: answer.error.message };
        return failed(previous, problem);
      }
      const workspace = answer.value;
      if (workspace.state === "not-git")
        return { state: "none", reason: "This thread's checkout is not a git repository." };
      if (workspace.state === "detached")
        return { state: "none", reason: "This thread's checkout has no branch checked out." };
      return succeeded(workspace.local, now());
    } catch (error) {
      if (deps.lifecycle.aborted) throw error;
      return failed(previous, await hostProblem(placement, error));
    }
  }

  async function refreshNow(threadId: string): Promise<void> {
    const signal = deps.lifecycle;
    const where = await resolvePlacement(threadId);
    store.setPlacement(threadId, where, now());
    if (where.state === "none") return;
    const { placement } = where;
    const local = await readLocal(placement, signal);
    if ("state" in local) {
      store.setPlacement(threadId, local, now());
      return;
    }
    store.setLocal(placement.hostId, placement.path, local);
    // Announce the checkout before GitHub answers, so a slow forge site does not hold it back.
    bb.rpc.experimental_invalidate([threadTag(threadId)]);
    const key = keyOf(placement, local);
    const value = local.read?.value;
    if (!key || !value?.github) return;
    const previous = store.forge(key);
    try {
      const pr = await sites.pullRequest(
        { repo: value.github.repo, headOwner: value.github.headOwner, branch: value.branch },
        placement,
        signal,
      );
      store.setForge(key, succeeded(pr, now()));
    } catch (error) {
      if (!(error instanceof ForgeReadError)) {
        if (signal.aborted) throw error;
        store.setForge(
          key,
          failed(previous, { kind: "failed", site: "GitHub", detail: String(error) }),
        );
      } else store.setForge(key, failed(previous, error.problem));
    }
  }

  /** Read the thread now; concurrent requests for one thread share one read. */
  function refresh(threadId: string): Promise<void> {
    const running = inFlight.get(threadId);
    if (running) return running;
    const run = refreshNow(threadId)
      .catch((error: unknown) => {
        if (!deps.lifecycle.aborted)
          bb.log.warn(`Could not read the Change of ${threadId}: ${String(error)}`);
      })
      .finally(() => {
        inFlight.delete(threadId);
        if (!deps.lifecycle.aborted) bb.rpc.experimental_invalidate([threadTag(threadId)]);
      });
    inFlight.set(threadId, run);
    return run;
  }

  return {
    /** Stored rows only: serving a read never calls a host. */
    read(keys: readonly string[]): Record<string, ThreadChange> {
      return Object.fromEntries(keys.map((threadId) => [threadId, store.threadChange(threadId)]));
    },
    refresh,
    /** Explicit retry: probe forge sites again, then read. */
    async retry(threadId: string): Promise<void> {
      sites.reprobe();
      await refresh(threadId);
    },
    /** While a surface watches a thread: read it now and again every interval. */
    async watch(threadId: string, signal: AbortSignal): Promise<void> {
      while (!signal.aborted && !deps.lifecycle.aborted) {
        await refresh(threadId);
        await sleep(WATCH_INTERVAL_MS, AbortSignal.any([signal, deps.lifecycle]));
      }
    },
  };
}
