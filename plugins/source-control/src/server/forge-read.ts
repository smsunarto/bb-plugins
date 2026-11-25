/**
 * The forge facet: the pull request of a Change, read once for every
 * checkout of its branch, and how often to read it again while someone
 * watches. Knows GitHub's side only through the forge sites.
 */
import { Effect } from "effect";
import {
  changeKeyForBranch,
  findBranch,
  remoteBranchName,
  succeeded,
  type Facet,
  type ForgeAction,
  type ForgeResult,
  type ForgeRead,
  type Problem,
  type ForgeValue,
  type Placement,
} from "../core/change.ts";
import { changeTag, checksTag, reviewTag, type ChangeKey } from "../core/ids.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

/** While checks run, the pull request is read this often. */
export const FORGE_ACTIVE_MS = 20_000;
/** Once it has settled. */
export const FORGE_SETTLED_MS = 60_000;
/** After GitHub refused or nobody can read it: a retry asks sooner. */
export const FORGE_BACKOFF_MS = 5 * 60_000;

/** `open` for a pull request query while the last read found the pull request open; else nothing, as RPC carries no undefined. */
export function knownOpen(facet: Facet<ForgeValue>): { open?: number } {
  const pr = facet.read?.value;
  return pr?.state === "open" ? { open: pr.number } : {};
}

/** How long after a read attempt the pull request is due again. */
export function forgeInterval(facet: Facet<ForgeValue>): number {
  const kind = facet.problem?.kind;
  if (kind === "rate-limited" || kind === "auth" || kind === "no-site") return FORGE_BACKOFF_MS;
  const pr = facet.read?.value;
  if (pr && pr.state === "open" && pr.checks.pending > 0) return FORGE_ACTIVE_MS;
  return FORGE_SETTLED_MS;
}

export const forgeScope = (key: ChangeKey, hostId?: string) =>
  JSON.stringify([key, hostId ?? null]);

/** Successful reads order the shared data. Failures order only their own scope. */
export function createForgePublisher(deps: {
  store: Store;
  invalidate: (tags: readonly string[]) => void;
  forgeChanged: (key: ChangeKey, threadId?: string) => void;
  hostProblemChanged: (key: ChangeKey, hostId: string, threadId?: string) => void;
  forgeRead: (key: ChangeKey) => void;
  now: () => number;
}) {
  const { store } = deps;
  let sequence = 0;
  const published = new Map<ChangeKey, number>();
  const scoped = new Map<string, number>();
  return (key: ChangeKey, reader?: { hostId?: string; threadId?: string }) => {
    const generation = ++sequence;
    const { hostId, threadId } = reader ?? {};
    const scope = forgeScope(key, hostId);
    return (result: { value: ForgeRead } | { problem: Problem }) => {
      if (reader && (scoped.get(scope) ?? 0) < generation) {
        scoped.set(scope, generation);
        const problem = "problem" in result ? result.problem : null;
        if (store.setForgeProblem(key, hostId, problem)) {
          if (hostId) deps.hostProblemChanged(key, hostId, threadId);
          else deps.invalidate([changeTag(key), checksTag(key), reviewTag(key)]);
        }
      }

      if (!("value" in result) || (published.get(key) ?? 0) >= generation) return;
      const at = deps.now();
      const changed = store.setForgeFacets(key, {
        forge: succeeded(result.value.pullRequest, at),
        checks: succeeded(result.value.checks, at),
        threads: succeeded(result.value.threads ?? [], at),
      });
      published.set(key, generation);
      if (changed.forge) {
        deps.invalidate([changeTag(key)]);
        deps.forgeChanged(key, threadId);
      }
      if (changed.checks) deps.invalidate([checksTag(key)]);
      if (changed.threads) deps.invalidate([reviewTag(key)]);
      deps.forgeRead(key);
    };
  };
}

export type BeginForgeRead = ReturnType<typeof createForgePublisher>;

export function createForgeReads(deps: {
  store: Store;
  sites: ForgeSites;
  share: Share;
  beginForgeRead: BeginForgeRead;
  now: () => number;
}) {
  const { store } = deps;
  const attempted = new Map<string, number>();

  /** The Change the store places the thread on, with what GitHub needs to find its pull request. */
  function target(threadId: string, placement: Placement) {
    const workspace = store.local(placement.hostId, placement.path).read?.value;
    const branch = workspace ? findBranch(workspace, store.branch(threadId)) : null;
    if (!workspace || !branch || !workspace.github) return null;
    const key = changeKeyForBranch(placement.hostId, workspace, branch);
    return {
      key,
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
      const { hostId } = placement;
      const scope = forgeScope(key, hostId);
      // Kept after the checkout goes; a read on no branch leaves the last one, as a detached handoff does.
      store.rememberChange(threadId, key, placement);
      return deps
        .share(
          `checkout-forge:${scope}`,
          Effect.gen(function* () {
            attempted.set(scope, deps.now());
            const publish = deps.beginForgeRead(key, { hostId, threadId });
            const answer = yield* deps.sites
              .pullRequestVia({ ...query, ...knownOpen(store.forge(key)) }, [placement], "only")
              .pipe(Effect.result);
            publish(
              answer._tag === "Success"
                ? { value: answer.success }
                : { problem: answer.failure.problem },
            );
          }),
        )
        .pipe(Effect.as(key));
    });

  /** One write on the thread's pull request, at the head the reader saw; then read it again. */
  const act = Effect.fnUntraced(function* (
    threadId: string,
    placement: Placement,
    action: ForgeAction,
    expected: { number: number; head: string },
  ) {
    const found = target(threadId, placement);
    if (!found)
      return {
        status: "failed",
        problem: { kind: "moved", detail: "This thread's branch has no pull request here." },
      } satisfies ForgeResult;
    const write = {
      ...found.query,
      ...knownOpen(store.forge(found.key)),
      number: expected.number,
      expectedHead: expected.head,
    };
    const result =
      action.kind === "setDraft"
        ? yield* deps.sites.setDraft({ ...write, draft: action.draft }, placement)
        : action.kind === "close"
          ? yield* deps.sites.close(write, placement)
          : yield* deps.sites.merge(
              {
                repo: write.repo,
                number: write.number,
                method: action.method,
                expectedHead: write.expectedHead,
                expectedBase: action.base,
              },
              [placement],
            );
    // Done, already so, moved or unknown: the reader sees GitHub's state either way.
    yield* readForge(threadId, placement);
    return result;
  });

  return {
    readForge,
    act,
    /** Whether the thread's pull request is due a watched read. */
    due(threadId: string, placement: Placement): boolean {
      const found = target(threadId, placement);
      if (!found) return false;
      const last = attempted.get(forgeScope(found.key, placement.hostId));
      return (
        last === undefined ||
        deps.now() - last >= forgeInterval(store.forge(found.key, placement.hostId))
      );
    },
  };
}

export type ForgeReads = ReturnType<typeof createForgeReads>;
