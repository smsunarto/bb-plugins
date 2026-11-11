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
import { runReviewRead, type ReviewAnswer, type ReviewRead } from "../forge/review.ts";
import type { PrRef } from "../core/watch.ts";
import {
  accountExec,
  GhError,
  readAccounts,
  readPullRequest,
  setDraftAt,
  submitReviewAt,
  type DraftWrite,
  type ReviewSubmitted,
  type ReviewWrite,
  type Exec,
  type PullRequestQuery,
} from "../forge/github.ts";

export const SERVER_SITE_NAME = "the bb server";
const PROBE_TTL_MS = 5 * 60_000;
export const FORGE_DEADLINE_MS = 15_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: HostFailure };

/** A background read's answer and the login it ran as, or why there is none. */
export type SiteOutcome<T> =
  | { ok: true; value: T; login: string }
  | { ok: false; reason: "away" | "gone" | "rate-limited" | "failed"; message: string };

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
  review(
    hostId: string,
    input: { read: ReviewRead; account: ForgeAccount },
    signal: AbortSignal,
  ): Promise<Outcome<ReviewAnswer>>;
  submitReview(
    hostId: string,
    write: ReviewWrite & { account: ForgeAccount },
    signal: AbortSignal,
  ): Promise<Outcome<ReviewSubmitted>>;
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
/** A signed-in account and the site it is signed in on. */
export type SiteAccount = { login: string; active: boolean; hostId: string | null; site: string };

const repoName = (query: { repo: { owner: string; name: string } }) =>
  `${query.repo.owner}/${query.repo.name}`.toLowerCase();
const sameAccess = (a: Access, b: Access) =>
  a.hostId === b.hostId && a.account.login === b.account.login;

const ghRefused = (site: string, error: unknown) =>
  error instanceof GhError
    ? new SiteRefused({ code: error.code, message: error.message, site })
    : new SiteRefused({ code: "failed", message: String(error), site });

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

const uniqueHosts = (placements: readonly Placement[]) => [
  ...new Map(placements.map((each) => [each.hostId, each])).values(),
];

const toSiteAccount = (access: Access): SiteAccount => ({
  ...access.account,
  hostId: access.hostId,
  site: access.site,
});

/** A host's answer as a value, or the site's refusal. */
const hostAnswer = <T>(
  access: Access,
  call: (signal: AbortSignal) => Promise<Outcome<T>>,
  /** What a host that does not answer at all means to the caller. */
  unreachable: "failed" | "away" = "failed",
) =>
  Effect.tryPromise({
    try: call,
    catch: (error) =>
      new SiteRefused({ code: unreachable, message: String(error), site: access.site }),
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

type AsAccount = ReturnType<typeof accountExec>;

/** A review read as the access's account, on the server or through its host. */
const reviewVia = (
  asAccount: AsAccount,
  host: HostForge,
  access: Access,
  read: ReviewRead,
  unreachable: "failed" | "away" = "failed",
) =>
  access.hostId === null
    ? Effect.tryPromise({
        try: (signal) =>
          runReviewRead(asAccount(access.account.login, access.account.active), read, signal),
        catch: (error) => ghRefused(access.site, error),
      })
    : hostAnswer(
        access,
        (signal) => host.review(access.hostId!, { read, account: access.account }, signal),
        unreachable,
      );

/** Why a background read failed, from the code its site refused with. */
function refusedReason(code: string): BackgroundReason {
  if (code === "not-found") return "gone";
  if (code === "rate-limited") return "rate-limited";
  if (code === "failed" || code === "forbidden") return "failed";
  return "away";
}

/** Why a background read with no account named failed, from the first-that-sees problem. */
function problemReason(problem: { kind: string; detail?: string }): BackgroundReason {
  if (problem.kind === "rate-limited") return "rate-limited";
  if (problem.kind === "failed") return "failed";
  if (problem.kind === "auth" && problem.detail?.startsWith("No signed-in GitHub account can see"))
    return "gone";
  return "away";
}

type BackgroundReason = "away" | "gone" | "rate-limited" | "failed";

/** Posts a review as the access's account, on the server or through its host. */
const submitAt = (asAccount: AsAccount, host: HostForge, access: Access, write: ReviewWrite) =>
  access.hostId === null
    ? Effect.tryPromise({
        try: (signal) =>
          submitReviewAt(asAccount(access.account.login, access.account.active), write, signal),
        catch: (error) => ghRefused(access.site, error),
      })
    : hostAnswer(access, (signal) =>
        host.submitReview(access.hostId!, { ...write, account: access.account }, signal),
      );

/** Marks a pull request draft or ready as the access's account, on the server or through its host. */
const writeAt = (asAccount: AsAccount, host: HostForge, access: Access, write: DraftWrite) =>
  access.hostId === null
    ? Effect.tryPromise({
        try: (signal) =>
          setDraftAt(asAccount(access.account.login, access.account.active), write, signal),
        catch: (error) => ghRefused(access.site, error),
      })
    : hostAnswer(access, (signal) =>
        host.setDraft(access.hostId!, { ...write, account: access.account }, signal),
      );

/**
 * The signed-in `gh` accounts on the server and on each host, probed at most
 * once per PROBE_TTL_MS. An unreachable site has no accounts until asked again.
 */
function createAccountProbes(deps: { serverExec: Exec; host: HostForge; now: () => number }) {
  let server: Probe | null = null;
  const hosts = new Map<string, Probe>();
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

  /**
   * Every account the page can read an inbox as: the server's, then those
   * already known on each host in `placements`. Never waits on a host.
   */
  const knownAccounts = (placements: readonly Placement[]) =>
    serverAccesses.pipe(
      Effect.map((server) => {
        const all = [...server];
        for (const placement of uniqueHosts(placements)) {
          const known = hosts.get(placement.hostId);
          if (!fresh(known)) continue;
          known.accounts.forEach((login, index) =>
            all.push({
              hostId: placement.hostId,
              site: placement.hostName,
              account: { login, active: index === 0 },
            }),
          );
        }
        const byLogin = new Map<string, Access>();
        for (const access of all)
          if (!byLogin.has(access.account.login)) byLogin.set(access.account.login, access);
        return [...byLogin.values()];
      }),
    );

  /** Learn the accounts of the hosts not probed lately, three at a time; true when one was new. */
  const probeHosts = (placements: readonly Placement[]) =>
    Effect.gen(function* () {
      const stale = uniqueHosts(placements).filter((each) => !fresh(hosts.get(each.hostId)));
      if (stale.length === 0) return false;
      const found = yield* Effect.forEach(stale, (each) => hostAccounts(each.hostId), {
        concurrency: 3,
      });
      return found.some((logins) => logins.length > 0);
    });

  return {
    serverAccesses,
    hostAccesses,
    knownAccounts,
    probeHosts,
    /** Forget every probe, as an explicit retry does. */
    reset() {
      server = null;
      hosts.clear();
    },
  };
}

export function createForgeSites(deps: { serverExec: Exec; host: HostForge; now: () => number }) {
  /** The access that last read each repository. */
  const seen = new Map<string, Access>();
  const asAccount = accountExec(deps.serverExec, deps.now);
  const probes = createAccountProbes(deps);
  const { serverAccesses, hostAccesses, knownAccounts, probeHosts } = probes;

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

  /** The account that read the repository: every write on it runs as that one, never another. */
  const writerFor = (query: PullRequestQuery, placements: readonly Placement[]) =>
    Effect.gen(function* () {
      const repo = repoName(query);
      if (!seen.has(repo)) yield* pullRequestVia(query, placements);
      const access = seen.get(repo);
      if (!access)
        return yield* unavailable({
          kind: "no-site",
          host: placements[0]?.hostName ?? SERVER_SITE_NAME,
        });
      return access;
    });

  /**
   * The first access that can see the repository: the one that read it last,
   * else each of `sources` in order. Only "this account cannot see it" moves
   * on; any other refusal is the answer.
   */
  const firstThatSees = <T>(
    repo: string,
    sources: readonly Effect.Effect<Access[]>[],
    run: (access: Access) => Effect.Effect<T, SiteRefused>,
    nowhere: Problem,
  ) =>
    Effect.gen(function* () {
      const tried: Access[] = [];
      const attempt = Effect.fnUntraced(function* (access: Access) {
        if (tried.some((done) => sameAccess(done, access))) return null;
        tried.push(access);
        const answer = yield* run(access).pipe(Effect.result);
        if (answer._tag === "Success") {
          const before = seen.get(repo);
          if (!before || !sameAccess(before, access))
            yield* Effect.logDebug(
              `Reading ${repo} as ${access.account.login} on ${access.site}` +
                (tried.length > 1 ? `; ${tried.length - 1} other account(s) cannot see it.` : "."),
            );
          seen.set(repo, access);
          return { value: answer.success };
        }
        if (sameAccess(access, seen.get(repo) ?? access)) seen.delete(repo);
        if (!invisible(answer.failure.code))
          return yield* unavailable(refusedProblem(answer.failure));
        return null;
      });
      const last = seen.get(repo);
      if (last) {
        const read = yield* attempt(last);
        if (read) return read.value;
      }
      for (const source of sources)
        for (const access of yield* source) {
          const read = yield* attempt(access);
          if (read) return read.value;
        }
      if (tried.length === 0) return yield* unavailable(nowhere);
      return yield* unavailable({
        kind: "auth",
        site: tried.at(-1)!.site,
        detail: `No signed-in GitHub account can see ${repo}.`,
      });
    });

  /**
   * The branch's pull request and checks: the account that read the
   * repository last, else each server account, else each of the host's,
   * until one can see it. The host is asked for accounts only then.
   */
  const pullRequest = (query: PullRequestQuery, placement: Placement | null) =>
    pullRequestVia(query, placement ? [placement] : []);

  /** As `pullRequest`, trying each host in `placements` after the server: the review page's reads by ChangeKey. */
  const pullRequestVia = (query: PullRequestQuery, placements: readonly Placement[]) =>
    withinDeadline(
      firstThatSees(
        repoName(query),
        [serverAccesses, ...uniqueHosts(placements).map(hostAccesses)],
        (access) => readAt(access, query),
        { kind: "no-site", host: placements[0]?.hostName ?? SERVER_SITE_NAME },
      ),
    );

  const reviewAt = (access: Access, read: ReviewRead) =>
    reviewVia(asAccount, deps.host, access, read);

  /**
   * A pull request's files or commits: the account that read the repository
   * last, else the server's accounts, else those of each host in
   * `placements`, so a server with no `gh` login reads through a host.
   */
  const repoRead = (
    read: ReviewRead & { repo: { owner: string; name: string } },
    placements: readonly Placement[],
  ) =>
    withinDeadline(
      firstThatSees(
        repoName(read),
        [serverAccesses, ...uniqueHosts(placements).map(hostAccesses)],
        (access) => reviewAt(access, read),
        { kind: "no-site", host: placements[0]?.hostName ?? SERVER_SITE_NAME },
      ),
    );

  /** One account's inbox, on the site it is signed in on. */
  const inbox = (login: string, placements: readonly Placement[], pins: readonly PrRef[] = []) =>
    withinDeadline(
      Effect.gen(function* () {
        const access = (yield* knownAccounts(placements)).find(
          (each) => each.account.login === login,
        );
        if (!access)
          return yield* unavailable({
            kind: "auth",
            site: SERVER_SITE_NAME,
            detail: `${login} is not signed in to gh on the bb server or a checkout's host.`,
          });
        const answer = yield* reviewAt(access, {
          kind: "inbox",
          ...(pins.length ? { pins: [...pins] } : {}),
        }).pipe(Effect.mapError((refused) => unavailable(refusedProblem(refused))));
        return answer.kind === "inbox" ? answer.entries : [];
      }),
    );

  /** Where `login` is signed in: the server first, then each host in `placements`. */
  const accessFor = (login: string, placements: readonly Placement[]) =>
    Effect.gen(function* () {
      const want = login.toLowerCase();
      const match = (accesses: Access[]) =>
        accesses.find((each) => each.account.login.toLowerCase() === want);
      const server = match(yield* serverAccesses);
      if (server) return server;
      for (const placement of uniqueHosts(placements)) {
        const found = match(yield* hostAccesses(placement));
        if (found) return found;
      }
      return null;
    });

  /**
   * A background read (a pull request watch, a landed check) as `login`, or
   * as the first account that sees `repo` when `login` is null. Never fails:
   * a site that is away, or a `gh` that is missing or signed out there, is
   * `away`, which a background job waits out; only GitHub saying the thing
   * is not there is `gone`.
   */
  const backgroundRead = (
    login: string | null,
    repo: { owner: string; name: string },
    read: ReviewRead,
    placements: readonly Placement[],
  ): Effect.Effect<SiteOutcome<ReviewAnswer>> =>
    Effect.gen(function* () {
      if (login === null) {
        const answer = yield* withinDeadline(
          firstThatSees(
            repoName({ repo }),
            [serverAccesses, ...uniqueHosts(placements).map(hostAccesses)],
            (access) => reviewAt(access, read),
            { kind: "no-site", host: placements[0]?.hostName ?? SERVER_SITE_NAME },
          ),
        ).pipe(Effect.result);
        if (answer._tag === "Success") {
          const access = seen.get(repoName({ repo }));
          return access
            ? { ok: true as const, value: answer.success, login: access.account.login }
            : { ok: false as const, reason: "away" as const, message: "No account read it." };
        }
        const { problem } = answer.failure;
        return {
          ok: false as const,
          reason: problemReason(problem),
          message: "detail" in problem ? problem.detail : `${problem.kind}`,
        };
      }
      const access = yield* accessFor(login, placements);
      if (!access)
        return {
          ok: false as const,
          reason: "away" as const,
          message: `${login} is not signed in to gh on the bb server${placements[0] ? ` or ${placements[0].hostName}` : ""} right now.`,
        };
      // A host that does not answer is away: the job waits for it rather than ending.
      const run = reviewVia(asAccount, deps.host, access, read, "away");
      const answer = yield* run.pipe(
        Effect.timeoutOrElse({
          duration: FORGE_DEADLINE_MS,
          orElse: () =>
            Effect.fail(
              new SiteRefused({ code: "away", message: "No answer in time.", site: access.site }),
            ),
        }),
        Effect.result,
      );
      if (answer._tag === "Success")
        return { ok: true as const, value: answer.success, login: access.account.login };
      const { code, message } = answer.failure;
      return { ok: false as const, reason: refusedReason(code), message };
    });

  return {
    /** Accounts the page can read an inbox as, without waiting on a host. */
    knownAccounts: (placements: readonly Placement[]) =>
      knownAccounts(placements).pipe(Effect.map((accesses) => accesses.map(toSiteAccount))),
    probeHosts,
    inbox,
    repoRead,
    backgroundRead,
    /** Forget every probe, as an explicit retry does. */
    reprobe: probes.reset,
    pullRequest,
    pullRequestVia,
    /** The login the repository was last read as, if any: who "You" is on its pull requests. */
    viewerOf: (repo: { owner: string; name: string }): string | null =>
      seen.get(`${repo.owner}/${repo.name}`.toLowerCase())?.account.login ?? null,
    /**
     * Posts one review as the account that read the repository, through the
     * site it is signed in on. A refusal is a ForgeUnavailable with its problem.
     */
    submitReview: (write: ReviewWrite, placements: readonly Placement[]) =>
      withinDeadline(
        Effect.gen(function* () {
          const access = yield* writerFor(write, placements);
          return yield* submitAt(asAccount, deps.host, access, write).pipe(
            Effect.mapError((refused) => unavailable(refusedProblem(refused))),
          );
        }),
      ),
    /**
     * Marks the pull request draft or ready, as the account that read it:
     * a write never falls back to another account. Reads first when no
     * account has read the repository yet.
     */
    setDraft: (write: DraftWrite, placement: Placement | null) =>
      withinDeadline(
        Effect.gen(function* () {
          const repo = repoName(write);
          if (!seen.has(repo)) yield* pullRequest(write, placement);
          const access = seen.get(repo);
          if (!access)
            return yield* unavailable({
              kind: "no-site",
              host: placement?.hostName ?? SERVER_SITE_NAME,
            });
          return yield* writeAt(asAccount, deps.host, access, write).pipe(
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
