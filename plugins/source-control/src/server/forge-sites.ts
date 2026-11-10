/**
 * Where GitHub is read from. A forge site is the bb server, or a checkout's
 * host that has a signed-in `gh`. The server goes first when it has an
 * account; otherwise the change's own host does. Sites are probed once and
 * remembered; an explicit retry probes again, so a user's read never has to
 * fail first to discover a site.
 */
import { Effect, Schema } from "effect";
import { problemSchema, type ForgeValue, type Problem } from "../core/change.ts";
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

type Outcome<T> = { ok: true; value: T } | { ok: false; error: HostFailure };

export type HostForge = {
  accounts(hostId: string, signal: AbortSignal): Promise<Outcome<{ accounts: string[] }>>;
  pullRequest(
    hostId: string,
    query: PullRequestQuery,
    signal: AbortSignal,
  ): Promise<Outcome<ForgeValue>>;
};

const problemValue = Schema.declare(
  (input: unknown): input is Problem => problemSchema.safeParse(input).success,
);

/** No site could answer; `problem` is what the forge facet shows. */
export class ForgeUnavailable extends Schema.TaggedError<ForgeUnavailable>()("ForgeUnavailable", {
  problem: problemValue,
}) {}

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

const unavailable = (problem: Problem) => new ForgeUnavailable({ problem });

type Probe = { usable: boolean; at: number };

export function createForgeSites(deps: { serverExec: Exec; host: HostForge; now: () => number }) {
  let server: Probe | null = null;
  const hosts = new Map<string, Probe>();
  const fresh = (probe: Probe | null | undefined): probe is Probe =>
    !!probe && deps.now() - probe.at < PROBE_TTL_MS;

  const serverUsable = Effect.suspend(() => {
    if (fresh(server)) return Effect.succeed(server.usable);
    return Effect.tryPromise((signal) => readAccounts(deps.serverExec, signal)).pipe(
      Effect.map((accounts) => accounts.length > 0),
      Effect.orElseSucceed(() => false),
      Effect.tap((usable) =>
        Effect.sync(() => {
          server = { usable, at: deps.now() };
        }),
      ),
    );
  });

  const hostUsable = (hostId: string) =>
    Effect.suspend(() => {
      const known = hosts.get(hostId);
      if (fresh(known)) return Effect.succeed(known.usable);
      return Effect.tryPromise((signal) => deps.host.accounts(hostId, signal)).pipe(
        Effect.map((answer) => answer.ok && answer.value.accounts.length > 0),
        Effect.tap((usable) => Effect.sync(() => hosts.set(hostId, { usable, at: deps.now() }))),
        // An unreachable host is not a site now; ask again on the next read.
        Effect.orElseSucceed(() => false),
      );
    });

  const onServer = (query: PullRequestQuery) =>
    Effect.tryPromise({
      try: (signal) => readPullRequest(deps.serverExec, query, signal),
      catch: (error) =>
        unavailable(
          error instanceof GhError
            ? forgeProblem(SERVER_SITE_NAME, error.code, error.message)
            : forgeProblem(SERVER_SITE_NAME, "failed", String(error)),
        ),
    });

  const onHost = (query: PullRequestQuery, placement: { hostId: string; hostName: string }) =>
    Effect.tryPromise({
      try: (signal) => deps.host.pullRequest(placement.hostId, query, signal),
      catch: (error) =>
        unavailable({ kind: "failed", site: placement.hostName, detail: String(error) }),
    }).pipe(
      Effect.flatMap((answer) =>
        answer.ok
          ? Effect.succeed(answer.value)
          : Effect.fail(
              unavailable(
                forgeProblem(placement.hostName, answer.error.code, answer.error.message),
              ),
            ),
      ),
    );

  return {
    /** Forget every probe, as an explicit retry does. */
    reprobe() {
      server = null;
      hosts.clear();
    },
    /** The branch's pull request, read at the first usable site within the forge deadline. */
    pullRequest: (query: PullRequestQuery, placement: { hostId: string; hostName: string }) =>
      Effect.gen(function* () {
        if (yield* serverUsable) return yield* onServer(query);
        if (yield* hostUsable(placement.hostId)) return yield* onHost(query, placement);
        return yield* unavailable({ kind: "no-site", host: placement.hostName });
      }).pipe(
        Effect.timeoutOrElse({
          duration: FORGE_DEADLINE_MS,
          orElse: () =>
            Effect.fail(
              unavailable({
                kind: "failed",
                site: "GitHub",
                detail: `GitHub did not answer within ${FORGE_DEADLINE_MS / 1000} s.`,
              }),
            ),
        }),
      ),
  };
}

export type ForgeSites = ReturnType<typeof createForgeSites>;
