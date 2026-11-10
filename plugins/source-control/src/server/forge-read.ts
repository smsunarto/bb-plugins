/**
 * The forge facet: the pull request of a Change, read once for every
 * checkout of its branch, and how often to read it again while someone
 * watches. Knows GitHub's side only through the forge sites.
 */
import { Effect } from "effect";
import {
  changeKeyForBranch,
  failed,
  findBranch,
  remoteBranchName,
  succeeded,
  type Facet,
  type ForgeResult,
  type ForgeValue,
  type Placement,
} from "../core/change.ts";
import { checksTag, type ChangeKey } from "../core/ids.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** While checks run, the pull request is read this often. */
export const FORGE_ACTIVE_MS = 20_000;
/** Once it has settled. */
export const FORGE_SETTLED_MS = 60_000;
/** After GitHub refused or nobody can read it: a retry asks sooner. */
export const FORGE_BACKOFF_MS = 5 * 60_000;

/** How long after a read attempt the pull request is due again. */
export function forgeInterval(facet: Facet<ForgeValue>): number {
  const kind = facet.problem?.kind;
  if (kind === "rate-limited" || kind === "auth" || kind === "no-site") return FORGE_BACKOFF_MS;
  const pr = facet.read?.value;
  if (pr && pr.state === "open" && pr.checks.pending > 0) return FORGE_ACTIVE_MS;
  return FORGE_SETTLED_MS;
}

export function createForgeReads(deps: {
  store: Store;
  sites: ForgeSites;
  share: Share;
  /** Every thread currently showing this Change. */
  threadsOf: (key: ChangeKey) => Iterable<string>;
  announce: (threadIds: Iterable<string>) => void;
  /** Tell readers of these tags, which are not thread tags, to read again. */
  invalidate: (tags: readonly string[]) => void;
  now: () => number;
}) {
  const { store } = deps;
  const attempted = new Map<ChangeKey, number>();

  /** The Change the store places the thread on, with what GitHub needs to find its pull request. */
  function target(threadId: string, placement: Placement) {
    const workspace = store.local(placement.hostId, placement.path).read?.value;
    const branch = workspace ? findBranch(workspace, store.branch(threadId)) : null;
    if (!workspace || !branch || !workspace.github) return null;
    return {
      key: changeKeyForBranch(placement.hostId, workspace, branch),
      query: {
        repo: workspace.github.repo,
        headOwner: workspace.github.headOwner,
        branch: remoteBranchName(branch),
      },
    };
  }

  /** Read the thread's pull request now; returns the Change it was read for. */
  const readForge = (threadId: string, placement: Placement) =>
    Effect.suspend(() => {
      const found = target(threadId, placement);
      if (!found) return Effect.succeed(null);
      const { key, query } = found;
      return deps
        .share(
          `forge:${key}`,
          Effect.gen(function* () {
            attempted.set(key, deps.now());
            const answer = yield* deps.sites.pullRequest(query, placement).pipe(Effect.result);
            const at = deps.now();
            const [forge, checks] =
              answer._tag === "Success"
                ? [succeeded(answer.success.pullRequest, at), succeeded(answer.success.checks, at)]
                : [
                    failed(store.forge(key), answer.failure.problem),
                    failed(store.checks(key), answer.failure.problem),
                  ];
            if (store.setForge(key, forge)) deps.announce([threadId, ...deps.threadsOf(key)]);
            if (store.setChecks(key, checks)) deps.invalidate([checksTag(key)]);
          }),
        )
        .pipe(Effect.as(key));
    });

  /** Mark the thread's pull request draft or ready, at the head the reader saw; then read it again. */
  const setDraft = Effect.fnUntraced(function* (
    threadId: string,
    placement: Placement,
    draft: boolean,
    expected: { number: number; head: string },
  ) {
    const found = target(threadId, placement);
    if (!found)
      return {
        status: "failed",
        problem: { kind: "moved", detail: "This thread's branch has no pull request here." },
      } satisfies ForgeResult;
    const result = yield* deps.sites.setDraft(
      { ...found.query, number: expected.number, draft, expectedHead: expected.head },
      placement,
    );
    // Done, already so, or moved: the reader sees GitHub's state either way.
    yield* readForge(threadId, placement);
    return result;
  });

  return {
    readForge,
    setDraft,
    /** Whether the thread's pull request is due a watched read. */
    due(threadId: string, placement: Placement): boolean {
      const found = target(threadId, placement);
      if (!found) return false;
      const last = attempted.get(found.key);
      return last === undefined || deps.now() - last >= forgeInterval(store.forge(found.key));
    },
  };
}

export type ForgeReads = ReturnType<typeof createForgeReads>;
