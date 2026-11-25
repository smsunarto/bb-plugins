/**
 * The selected Change on the review page: its header and rail by ChangeKey,
 * from the checkout that has it when the placement table knows one and from
 * the forge otherwise, its pull request read while it is open, and Mark ready.
 */
import { Effect } from "effect";
import {
  failed,
  findBranch,
  succeeded,
  uncommittedCount,
  type Facet,
  type ForgeAction,
  type ForgeResult,
  type ForgeRead,
  type ForgeValue,
  type Placement,
  type Problem,
  type PullRequest,
  type WorkspaceValue,
} from "../core/change.ts";
import { changeTag, checksTag, reviewTag, type ChangeKey } from "../core/ids.ts";
import type { MergePolicy } from "../core/merge.ts";
import {
  inboxRow,
  parseChangeKey,
  type ChangeDetail,
  type ChangeRow,
  type ParsedKey,
  type ReviewRevision,
} from "../core/review.ts";
import { changeState, publishedSummary, shipPath, type ChangeSummary } from "../core/status.ts";
import { forgeInterval, FORGE_ACTIVE_MS, knownOpen } from "./forge-read.ts";
import type { ForgeHost, ForgeSites } from "./forge-sites.ts";
import { rowsOf } from "./review-sources.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

export const moved = (detail: string): Problem => ({ kind: "moved", detail });

type LocalMatch = {
  placement: Placement;
  workspace: WorkspaceValue;
  row: ChangeRow;
  /** Top of the stack first. */
  stack: ChangeRow[];
  index: number;
  problem: Problem | null;
  at: number;
};

/** The checkout that has the Change, if the placement table knows one. */
export function localMatch(store: Store, key: ChangeKey): LocalMatch | null {
  for (const placement of store.checkouts()) {
    const facet = store.local(placement.hostId, placement.path);
    if (!facet.read) continue;
    const rows = rowsOf(store, placement);
    const row = rows.find((each) => each.key === key);
    if (!row) continue;
    const stack = rows.filter((each) => each.stack?.id === row.stack?.id);
    return {
      placement,
      workspace: facet.read.value,
      row,
      stack,
      index: stack.indexOf(row),
      problem: facet.problem,
      at: facet.read.at,
    };
  }
  return null;
}

/** A pull request's base as a branch the host can find on its remote; one it cannot name safely is left to the default. */
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,250}$/;

/**
 * What `head` adds since `base`, on the host that has it; null for a branch
 * with no commits. The base is the branch below in its stack, else the
 * target; a checkout with no target (no `HEAD` for its remote) compares with
 * the pull request's base branch, else the remote's default, which the host resolves.
 */
function hostRevision(match: LocalMatch, pr: PullRequest | null): ReviewRevision | null {
  const stack = match.workspace.stacks.find((each) =>
    each.branches.some((branch) => branch.name === match.row.branch),
  );
  const at = stack?.branches.findIndex((branch) => branch.name === match.row.branch) ?? -1;
  const branch = stack?.branches[at];
  const target = match.workspace.target;
  const named = pr?.baseRef && SAFE_BRANCH.test(pr.baseRef) && !pr.baseRef.includes("..");
  const base =
    stack?.branches[at + 1]?.head ??
    target?.head ??
    target?.base?.id ??
    `branch:${named ? pr!.baseRef : ""}`;
  if (!branch?.head) return null;
  return {
    head: branch.head,
    base,
    source: { kind: "host", hostId: match.placement.hostId, path: match.placement.path },
  };
}

/** The checkout says what is here; the forge, what is published. A reachable checkout wins. */
function revisionOf(match: LocalMatch | null, pr: PullRequest | null): ReviewRevision | null {
  const local = match ? hostRevision(match, pr) : null;
  if (local && !match?.problem) return local;
  if (pr && pr.state !== "closed")
    return { head: pr.headRefOid, base: pr.baseRef, source: { kind: "forge", number: pr.number } };
  // No pull request to read instead: the checkout's last read, whose files the server may still hold.
  return local;
}

/** What the derivations read for the Change: its checkout's branch when one has it. */
function summaryOf(
  key: ChangeKey,
  match: LocalMatch | null,
  pr: PullRequest | null | undefined,
): ChangeSummary {
  if (!match) return publishedSummary(key, pr);
  const branch = findBranch(match.workspace, match.row.branch);
  const checkedOut =
    match.workspace.provider === "git"
      ? match.workspace.checkedOut === match.row.branch
      : match.index === 0;
  return {
    key,
    branch,
    onGitHub: match.workspace.github !== null,
    uncommitted: checkedOut ? uncommittedCount(match.workspace) : 0,
    conflicted: branch?.status === "conflicted",
    pullRequest: pr,
    findings: 0,
  };
}

/** The Change's row: its checkout's, else its pull request's, else an inbox's. */
function rowOf(
  parsed: ParsedKey,
  match: LocalMatch | null,
  pr: PullRequest | null,
  fromInbox: ChangeRow | null,
): ChangeRow | null {
  if (match) return match.row;
  if (!pr || parsed.kind !== "gh") return fromInbox;
  return inboxRow({
    repo: parsed.repo,
    headOwner: parsed.headOwner,
    branch: parsed.branch,
    author: fromInbox?.author ?? null,
    updatedAt: fromInbox?.updatedAt ?? null,
    mine: fromInbox?.mine ?? false,
    asked: fromInbox?.asked ?? false,
    pullRequest: pr,
  });
}

function stackOf(key: ChangeKey, match: LocalMatch | null) {
  if (!match || match.stack.length < 2) return null;
  return match.stack.map((each) => ({
    key: each.key,
    branch: each.branch,
    number: each.number,
    state: each.state,
    commits: 0,
    current: each.key === key,
  }));
}

export function changeDetail(
  key: ChangeKey,
  input: {
    match: LocalMatch | null;
    forge: Facet<ForgeValue>;
    fromInbox: ChangeRow | null;
  },
): ChangeDetail {
  const parsed = parseChangeKey(key);
  if (!parsed) return { state: "missing", problem: moved("This link names no Change.") };
  const { match, forge } = input;
  const pr = forge.read?.value ?? null;
  const row = rowOf(parsed, match, pr, match ? null : input.fromInbox);
  if (!row)
    return forge.read === null && !forge.problem
      ? { state: "pending" }
      : { state: "missing", problem: forge.problem };
  const revision = revisionOf(match, pr);
  const summary = summaryOf(key, match, forge.read ? pr : undefined);
  return {
    state: "change",
    row,
    head: revision?.head ?? pr?.headRefOid ?? null,
    files: pr?.changedFiles ?? null,
    additions: pr?.additions ?? null,
    deletions: pr?.deletions ?? null,
    revision,
    stack: stackOf(key, match),
    canMarkReady: pr?.state === "open" && pr.isDraft,
    ship: shipPath(summary),
    status: changeState(summary),
    problem: match?.problem ?? forge.problem,
    at: Math.max(forge.read?.at ?? 0, match?.at ?? 0),
  };
}

export function createReviewChange(deps: {
  store: Store;
  sites: ForgeSites;
  share: Share;
  threadForgeHost: (threadId: string) => Effect.Effect<ForgeHost | null>;
  inboxRow: (key: ChangeKey) => ChangeRow | null;
  invalidate: (tags: readonly string[]) => void;
  /** A Change's pull request was read: the threads showing it read again. */
  forgeChanged: (key: ChangeKey) => void;
  /** A Change's pull request was read: its review items may need a new head. */
  forgeRead?: (key: ChangeKey) => void;
  now: () => number;
}) {
  const { store } = deps;
  const attempts = new Map<ChangeKey, number>();

  function saveForge(key: ChangeKey, read: { value: ForgeRead } | { problem: Problem }) {
    const at = deps.now();
    const forge =
      "value" in read
        ? succeeded(read.value.pullRequest, at)
        : failed(store.forge(key), read.problem);
    const checks =
      "value" in read ? succeeded(read.value.checks, at) : failed(store.checks(key), read.problem);
    const threads =
      "value" in read
        ? succeeded(read.value.threads ?? [], at)
        : failed(store.threads(key), read.problem);
    if (store.setForge(key, forge)) {
      deps.invalidate([changeTag(key)]);
      deps.forgeChanged(key);
    }
    if (store.setChecks(key, checks)) deps.invalidate([checksTag(key)]);
    if (store.setThreads(key, threads)) deps.invalidate([reviewTag(key)]);
    deps.forgeRead?.(key);
  }

  /**
   * Read the Change's pull request by its key, from wherever an account can
   * see it; with `host`, on the server and that host only.
   */
  const readForge = (key: ChangeKey, host?: ForgeHost) =>
    deps.share(
      host ? `remembered-forge:${JSON.stringify([key, host.hostId])}` : `forge:${key}`,
      Effect.gen(function* () {
        const parsed = parseChangeKey(key);
        if (parsed?.kind !== "gh") return;
        attempts.set(key, deps.now());
        const { repo, headOwner, branch } = parsed;
        // The Change's own checkout first, then any checkout's host, so a server with no gh login still reads it.
        const own = localMatch(store, key)?.placement;
        const placements = host ? [host] : own ? [own, ...store.checkouts()] : store.checkouts();
        const answer = yield* deps.sites
          .pullRequestVia(
            {
              repo,
              headOwner,
              branch,
              ...knownOpen(store.forge(key)),
            },
            placements,
            host ? "only" : "any",
          )
          .pipe(Effect.result);
        saveForge(
          key,
          answer._tag === "Success"
            ? { value: answer.success }
            : { problem: answer.failure.problem },
        );
      }),
    );

  const due = (key: ChangeKey) => {
    const last = attempts.get(key);
    return last === undefined || deps.now() - last >= forgeInterval(store.forge(key));
  };

  function detailOf(key: ChangeKey): ChangeDetail {
    return changeDetail(key, {
      match: localMatch(store, key),
      forge: store.forge(key),
      fromInbox: deps.inboxRow(key),
    });
  }

  return {
    detail(keys: readonly ChangeKey[]): Record<string, ChangeDetail> {
      return Object.fromEntries(keys.map((key) => [key, detailOf(key)]));
    },
    /** Refresh the branch's selected PR. The link number never picks what the branch stores. */
    prLinkDetail: (key: ChangeKey, threadId?: string) =>
      deps.share(
        // A thread id scopes the pending read before its host is needed or known.
        `pr-link-forge:${JSON.stringify([key, threadId ?? null])}`,
        Effect.gen(function* () {
          const parsed = parseChangeKey(key);
          if (parsed?.kind !== "gh")
            return { [key]: { state: "missing", problem: null } satisfies ChangeDetail };
          const { repo, headOwner, branch } = parsed;
          const answer = yield* deps.sites
            .pullRequestVia(
              { repo, headOwner, branch, ...knownOpen(store.forge(key)) },
              [],
              "only",
              threadId ? deps.threadForgeHost(threadId) : undefined,
            )
            .pipe(Effect.result);
          // A thread's connection or permission failure says nothing about the shared branch.
          if (answer._tag === "Failure")
            return {
              [key]: { state: "missing", problem: answer.failure.problem } satisfies ChangeDetail,
            };
          saveForge(key, { value: answer.success });
          return {
            [key]: answer.success.pullRequest
              ? detailOf(key)
              : ({ state: "missing", problem: null } satisfies ChangeDetail),
          };
        }),
      ),
    /** Read the Change's pull request now. */
    readForge,
    /** Whether the Change's pull request is due another read. */
    forgeDue: due,
    /** While the Change is open: its pull request when due, as often as the thread tab reads it. */
    watchChange: (key: ChangeKey) =>
      Effect.gen(function* () {
        while (true) {
          if (due(key)) yield* readForge(key);
          yield* Effect.sleep(FORGE_ACTIVE_MS);
        }
      }),
    /** One write on the Change's pull request, at the head the reader saw; then read it again. */
    forgeAction: (
      key: ChangeKey,
      action: ForgeAction,
      expected: { number: number; head: string },
    ) =>
      Effect.gen(function* () {
        const parsed = parseChangeKey(key);
        if (parsed?.kind !== "gh")
          return {
            status: "failed",
            problem: moved("This Change has no pull request."),
          } satisfies ForgeResult;
        const { repo, headOwner, branch } = parsed;
        const placement = localMatch(store, key)?.placement ?? null;
        const result =
          action.kind === "setDraft"
            ? yield* deps.sites.setDraft(
                {
                  repo,
                  headOwner,
                  branch,
                  number: expected.number,
                  draft: action.draft,
                  expectedHead: expected.head,
                },
                placement,
              )
            : action.kind === "close"
              ? yield* deps.sites.close(
                  {
                    repo,
                    headOwner,
                    branch,
                    number: expected.number,
                    expectedHead: expected.head,
                  },
                  placement,
                )
              : yield* deps.sites.merge(
                  {
                    repo,
                    number: expected.number,
                    method: action.method,
                    expectedHead: expected.head,
                    expectedBase: action.base,
                  },
                  placement ? [placement] : [],
                );
        // Done, already so, moved or unknown: the reader sees GitHub's state either way.
        yield* readForge(key);
        return result;
      }),
    /** What merging the Change's pull request needs, read fresh as the account that would merge it. */
    mergePolicy: (key: ChangeKey, number: number) =>
      Effect.gen(function* () {
        const parsed = parseChangeKey(key);
        if (parsed?.kind !== "gh")
          return { ok: false as const, problem: moved("This Change has no pull request.") };
        const placement = localMatch(store, key)?.placement;
        const answer = yield* deps.sites
          .mergePolicy({ repo: parsed.repo, number }, placement ? [placement] : [])
          .pipe(Effect.result);
        return answer._tag === "Success"
          ? { ok: true as const, policy: answer.success satisfies MergePolicy }
          : { ok: false as const, problem: answer.failure.problem };
      }),
  };
}
