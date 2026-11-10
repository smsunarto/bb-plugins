/**
 * Where GitHub is read from. A forge site is the bb server, or a checkout's
 * host that has a signed-in `gh`. The server goes first when it has an
 * account; otherwise the change's own host does. Sites are probed once and
 * remembered; an explicit retry probes again, so a user's read never has to
 * fail first to discover a site.
 */
import type { Problem, ForgeValue } from "../core/change.ts";
import type { HostFailure } from "../contract/host.ts";
import {
  GhError,
  readAccounts,
  readPullRequest,
  type Exec,
  type PullRequestQuery,
} from "../forge/github.ts";

export const SERVER_SITE_NAME = "the bb server";
const PROBE_TTL_MS = 5 * 60_000;
export const FORGE_DEADLINE_MS = 15_000;

export type HostForge = {
  accounts(
    hostId: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: { accounts: string[] } } | { ok: false; error: HostFailure }>;
  pullRequest(
    hostId: string,
    query: PullRequestQuery,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: ForgeValue } | { ok: false; error: HostFailure }>;
};

type Probe = { usable: boolean; at: number };

/** A failure at a site as the problem the forge facet carries. */
export function forgeProblem(site: string, code: HostFailure["code"], message: string): Problem {
  switch (code) {
    case "gh-missing":
      return { kind: "tool-missing", tool: "gh", host: site, detail: message };
    case "unauthenticated":
      return { kind: "auth", site, detail: message };
    case "rate-limited":
      return { kind: "rate-limited", site, detail: message };
    default:
      return { kind: "failed", site, detail: message };
  }
}

export class ForgeReadError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.kind);
    this.problem = problem;
  }
}

export function createForgeSites(deps: { serverExec: Exec; host: HostForge; now: () => number }) {
  let server: Probe | null = null;
  const hosts = new Map<string, Probe>();
  const fresh = (probe: Probe | null | undefined) => probe && deps.now() - probe.at < PROBE_TTL_MS;

  async function serverUsable(signal: AbortSignal): Promise<boolean> {
    if (!fresh(server)) {
      let usable = false;
      try {
        usable = (await readAccounts(deps.serverExec, signal)).length > 0;
      } catch {
        usable = false;
      }
      server = { usable, at: deps.now() };
    }
    return server!.usable;
  }

  async function hostUsable(hostId: string, signal: AbortSignal): Promise<boolean> {
    const known = hosts.get(hostId);
    if (fresh(known)) return known!.usable;
    let usable = false;
    try {
      const answer = await deps.host.accounts(hostId, signal);
      usable = answer.ok && answer.value.accounts.length > 0;
    } catch {
      // An unreachable host is not a site now; ask again on the next probe.
      return false;
    }
    hosts.set(hostId, { usable, at: deps.now() });
    return usable;
  }

  return {
    /** Forget every probe, as an explicit retry does. */
    reprobe() {
      server = null;
      hosts.clear();
    },
    /**
     * The branch's pull request, read at the first usable site. Throws a
     * `ForgeReadError` carrying the problem when no site can answer.
     */
    async pullRequest(
      query: PullRequestQuery,
      placement: { hostId: string; hostName: string },
      signal: AbortSignal,
    ): Promise<ForgeValue> {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(FORGE_DEADLINE_MS)]);
      if (await serverUsable(deadline)) {
        try {
          return await readPullRequest(deps.serverExec, query, deadline);
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof GhError)
            throw new ForgeReadError(
              forgeProblem(
                SERVER_SITE_NAME,
                error.code === "gh-missing" ? "gh-missing" : error.code,
                error.message,
              ),
            );
          throw new ForgeReadError(forgeProblem(SERVER_SITE_NAME, "failed", String(error)));
        }
      }
      if (await hostUsable(placement.hostId, deadline)) {
        const answer = await deps.host
          .pullRequest(placement.hostId, query, deadline)
          .catch((error: unknown) => {
            if (signal.aborted) throw error;
            throw new ForgeReadError({
              kind: "failed",
              site: placement.hostName,
              detail: String(error),
            });
          });
        if (answer.ok) return answer.value;
        throw new ForgeReadError(
          forgeProblem(placement.hostName, answer.error.code, answer.error.message),
        );
      }
      throw new ForgeReadError({ kind: "no-site", host: placement.hostName });
    },
  };
}
