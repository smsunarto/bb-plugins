/**
 * Where GitHub is read from, and as whom. A forge site is the bb server, or
 * a checkout's host that has a signed-in `gh`; each site may hold several
 * accounts. A repository is read with the first account that can see it:
 * the server's accounts first, then the change's host's. The answer is
 * remembered per repository, so later reads make one call, and a write uses
 * only that remembered account, never another one.
 *
 * Sites are probed once and kept for five minutes; an explicit retry probes
 * again, so a user's read never has to fail first to discover a site.
 */
import { Effect, Schema } from "effect";
import { problemSchema, type ForgeRead, type ForgeResult, type Problem } from "../core/change.ts";
import type { ForgeAccount, HostFailure } from "../contract/host.ts";
import {
  accountExec,
  GhError,
  readAccounts,
  readPullRequest,
  setDraftAt,
  type DraftWrite,
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
    query: PullRequestQuery & { account: ForgeAccount },
    signal: AbortSignal,
  ): Promise<Outcome<ForgeRead>>;
  setDraft(
    hostId: string,
    write: DraftWrite & { account: ForgeAccount },
    signal: AbortSignal,
  ): Promise<Outcome<ForgeResult>>;
};

const problemValue = Schema.declare(
  (input: unknown): input is Problem => problemSchema.safeParse(input).success,
);

/** No site could answer; `problem` is what the forge facet shows. */
export class ForgeUnavailable extends Schema.TaggedError<ForgeUnavailable>()("ForgeUnavailable", {
  problem: problemValue,
}) {}

/** One site's refusal, before it becomes a problem: an account that cannot see the repository tries the next. */
class SiteRefused extends Schema.TaggedError<SiteRefused>()("SiteRefused", {
  code: Schema.String,
  message: Schema.String,
  site: Schema.String,
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
const refusedProblem = (refused: SiteRefused) =>
  forgeProblem(refused.site, refused.code as HostFailure["code"], refused.message);
const invisible = (code: string) => code === "not-found" || code === "forbidden";

/** Where a call runs and as whom. `hostId` null: the bb server. */
type Access = { hostId: string | null; site: string; account: { login: string; active: boolean } };
type Probe = { accounts: string[]; at: number };
type Placement = { hostId: string; hostName: string };

const repoName = (query: { repo: { owner: string; name: string } }) =>
  `${query.repo.owner}/${query.repo.name}`.toLowerCase();
const sameAccess = (a: Access, b: Access) =>
  a.hostId === b.hostId && a.account.login === b.account.login;

export function createForgeSites(deps: { serverExec: Exec; host: HostForge; now: () => number }) {
  let server: Probe | null = null;
  const hosts = new Map<string, Probe>();
  /** The access that last read each repository. */
  const seen = new Map<string, Access>();
  const asAccount = accountExec(deps.serverExec, deps.now);
  const fresh = (probe: Probe | null | undefined): probe is Probe =>
    !!probe && deps.now() - probe.at < PROBE_TTL_MS;

  const serverAccounts = Effect.suspend(() => {
    if (fresh(server)) return Effect.succeed(server.accounts);
    return Effect.tryPromise((signal) => readAccounts(deps.serverExec, signal)).pipe(
      Effect.orElseSucceed((): string[] => []),
      Effect.tap((accounts) =>
        Effect.sync(() => {
          server = { accounts, at: deps.now() };
        }),
      ),
    );
  });

  const hostAccounts = (hostId: string) =>
    Effect.suspend(() => {
      const known = hosts.get(hostId);
      if (fresh(known)) return Effect.succeed(known.accounts);
      return Effect.tryPromise((signal) => deps.host.accounts(hostId, signal)).pipe(
        Effect.map((answer) => (answer.ok ? answer.value.accounts : [])),
        Effect.tap((accounts) =>
          Effect.sync(() => hosts.set(hostId, { accounts, at: deps.now() })),
        ),
        // An unreachable host is not a site now; ask again on the next read.
        Effect.orElseSucceed((): string[] => []),
      );
    });

  const serverAccesses = serverAccounts.pipe(
    Effect.map((logins) =>
      logins.map((login, index): Access => ({
        hostId: null,
        site: SERVER_SITE_NAME,
        account: { login, active: index === 0 },
      })),
    ),
  );
  const hostAccesses = (placement: Placement) =>
    hostAccounts(placement.hostId).pipe(
      Effect.map((logins) =>
        logins.map((login, index): Access => ({
          hostId: placement.hostId,
          site: placement.hostName,
          account: { login, active: index === 0 },
        })),
      ),
    );

  const ghRefused = (site: string, error: unknown) =>
    error instanceof GhError
      ? new SiteRefused({ code: error.code, message: error.message, site })
      : new SiteRefused({ code: "failed", message: String(error), site });

  const hostAnswer = <T>(access: Access, call: (signal: AbortSignal) => Promise<Outcome<T>>) =>
    Effect.tryPromise({
      try: call,
      catch: (error) =>
        new SiteRefused({ code: "failed", message: String(error), site: access.site }),
    }).pipe(
      Effect.flatMap((answer) =>
        answer.ok
          ? Effect.succeed(answer.value)
          : Effect.fail(
              new SiteRefused({
                code: answer.error.code,
                message: answer.error.message,
                site: access.site,
              }),
            ),
      ),
    );

  const readAt = (access: Access, query: PullRequestQuery) =>
    access.hostId === null
      ? Effect.tryPromise({
          try: (signal) =>
            readPullRequest(asAccount(access.account.login, access.account.active), query, signal),
          catch: (error) => ghRefused(access.site, error),
        })
      : hostAnswer(access, (signal) =>
          deps.host.pullRequest(access.hostId!, { ...query, account: access.account }, signal),
        );

  const writeAt = (access: Access, write: DraftWrite) =>
    access.hostId === null
      ? Effect.tryPromise({
          try: (signal) =>
            setDraftAt(asAccount(access.account.login, access.account.active), write, signal),
          catch: (error) => ghRefused(access.site, error),
        })
      : hostAnswer(access, (signal) =>
          deps.host.setDraft(access.hostId!, { ...write, account: access.account }, signal),
        );

  const withinDeadline = <A>(effect: Effect.Effect<A, ForgeUnavailable>) =>
    effect.pipe(
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
    );

  /**
   * The branch's pull request and checks: the account that read the
   * repository last, else each server account, else each of the host's,
   * until one can see it. The host is asked for accounts only then.
   */
  const pullRequest = (query: PullRequestQuery, placement: Placement) =>
    withinDeadline(
      Effect.gen(function* () {
        const repo = repoName(query);
        const tried: Access[] = [];
        const attempt = Effect.fnUntraced(function* (access: Access) {
          if (tried.some((done) => sameAccess(done, access))) return null;
          tried.push(access);
          const answer = yield* readAt(access, query).pipe(Effect.result);
          if (answer._tag === "Success") {
            const before = seen.get(repo);
            if (!before || !sameAccess(before, access))
              yield* Effect.logDebug(
                `Reading ${repo} as ${access.account.login} on ${access.site}` +
                  (tried.length > 1
                    ? `; ${tried.length - 1} other account(s) cannot see it.`
                    : "."),
              );
            seen.set(repo, access);
            return answer.success;
          }
          if (sameAccess(access, seen.get(repo) ?? access)) seen.delete(repo);
          // Only "this account cannot see it" moves on; any other refusal is the answer.
          if (!invisible(answer.failure.code))
            return yield* unavailable(refusedProblem(answer.failure));
          return null;
        });
        const last = seen.get(repo);
        if (last) {
          const read = yield* attempt(last);
          if (read) return read;
        }
        for (const source of [serverAccesses, hostAccesses(placement)])
          for (const access of yield* source) {
            const read = yield* attempt(access);
            if (read) return read;
          }
        if (tried.length === 0)
          return yield* unavailable({ kind: "no-site", host: placement.hostName });
        return yield* unavailable({
          kind: "auth",
          site: tried.at(-1)!.site,
          detail: `No signed-in GitHub account can see ${query.repo.owner}/${query.repo.name}.`,
        });
      }),
    );

  return {
    /** Forget every probe, as an explicit retry does. */
    reprobe() {
      server = null;
      hosts.clear();
    },
    pullRequest,
    /**
     * Marks the pull request draft or ready, as the account that read it:
     * a write never falls back to another account. Reads first when no
     * account has read the repository yet.
     */
    setDraft: (write: DraftWrite, placement: Placement) =>
      withinDeadline(
        Effect.gen(function* () {
          const repo = repoName(write);
          if (!seen.has(repo)) yield* pullRequest(write, placement);
          const access = seen.get(repo);
          if (!access) return yield* unavailable({ kind: "no-site", host: placement.hostName });
          return yield* writeAt(access, write).pipe(
            Effect.mapError((refused) => unavailable(refusedProblem(refused))),
          );
        }),
      ).pipe(
        Effect.catchTag("ForgeUnavailable", (error) =>
          Effect.succeed<ForgeResult>({ status: "failed", problem: error.problem }),
        ),
      ),
  };
}

export type ForgeSites = ReturnType<typeof createForgeSites>;
