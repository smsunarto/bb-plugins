/**
 * The review page's reads, by what each part knows: the Changes nav's
 * sources (review-sources), the selected Change's header and rail
 * (review-change), and its files, patches and commits at one revision
 * (review-revision). Everything is keyed by ChangeKey, so a pull request
 * with no checkout anywhere opens the same way as one with three; nothing is
 * read once the page is hidden.
 */
import { changeTag, hostTag, type ChangeKey } from "../core/ids.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Effect } from "effect";
import { parseChangeKey } from "../core/review.ts";
import { createBatches } from "./batches.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { HostCalls } from "./host-calls.ts";
import type { LocalReads } from "./local-read.ts";
import { createReviewChange, localMatch } from "./review-change.ts";
import { createReviewItems } from "./review-items.ts";
import { createRevisionReads } from "./review-revision.ts";
import { checkoutsOn, createReviewSources, rowsOf } from "./review-sources.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

export function createReview(deps: {
  bb: BbPluginApi;
  store: Store;
  sites: ForgeSites;
  local: LocalReads;
  host: HostCalls;
  share: Share;
  invalidate: (tags: readonly string[]) => void;
  /** A Change's pull request was read: the threads showing it read again. */
  forgeChanged: (key: ChangeKey) => void;
  /** Runs work no caller waits for. */
  fork: (work: Effect.Effect<void>) => void;
  now: () => number;
  deadlineMs: number;
  /** Threads working on the Change's branch. */
  threadsOnChange: (key: ChangeKey) => string[];
}) {
  const sources = createReviewSources(deps);
  // Bound below: a pull request read may move the Change's head.
  let headMayHaveMoved = (_key: ChangeKey) => {};
  const change = createReviewChange({
    ...deps,
    inboxRow: sources.inboxRow,
    forgeRead: (key) => headMayHaveMoved(key),
  });
  const revision = createRevisionReads(deps);
  const items = createReviewItems({
    store: deps.store,
    sites: deps.sites,
    share: deps.share,
    detail: (key) => change.detail([key])[key]!,
    patches: revision.patches,
    placementsFor: revision.placementsFor,
    invalidate: deps.invalidate,
    fork: deps.fork,
    now: deps.now,
    batches: (key) => batches.batches(key),
    // Stored with the repository once learned, so "You" survives a restart before GitHub is asked again.
    viewer: (key) => {
      const parsed = parseChangeKey(key);
      if (parsed?.kind !== "gh") return null;
      const repo = `${parsed.repo.owner}/${parsed.repo.name}`;
      const stored = deps.store.viewer(repo);
      const known = deps.sites.viewerOf(parsed.repo);
      if (known && known !== stored) deps.store.setViewer(repo, known);
      const login = known ?? stored;
      return login ? { login, avatarUrl: `https://github.com/${login}.png?size=48` } : null;
    },
  });
  const batches = createBatches({
    bb: deps.bb,
    store: deps.store,
    sites: deps.sites,
    share: deps.share,
    detail: (key) => change.detail([key])[key]!,
    items: items.items,
    placementsFor: revision.placementsFor,
    threadsOnChange: deps.threadsOnChange,
    invalidate: deps.invalidate,
    fork: deps.fork,
    now: deps.now,
  });
  headMayHaveMoved = items.settleIfBehind;
  return {
    items,
    batches,
    pageSources: sources.pageSources,
    inbox: sources.inbox,
    watchInbox: sources.watchInbox,
    hostChanges: sources.hostChanges,
    watchHost: sources.watchHost,
    detail: change.detail,
    /**
     * Read the Change's checkout and pull request now, so a run starts at the
     * head they have rather than the last one stored. Failures keep the stored read.
     */
    refresh: (key: ChangeKey) =>
      Effect.all(
        [
          Effect.suspend(() => {
            const placement = localMatch(deps.store, key)?.placement;
            return placement ? deps.local.readCheckout(placement) : Effect.void;
          }),
          change.readForge(key),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.ignore),
    watchChange: change.watchChange,
    setDraft: change.setDraft,
    files: revision.files,
    patches: revision.patches,
    commits: revision.commits,
    /** A checkout was read and changed: its host's list and its Changes' headers read again. */
    checkoutRead(hostId: string, path: string) {
      const placement = checkoutsOn(deps.store, hostId).find((each) => each.path === path);
      const rows = placement ? rowsOf(deps.store, placement) : [];
      deps.invalidate([hostTag(hostId), ...rows.map((row) => changeTag(row.key))]);
      for (const row of rows) items.settleIfBehind(row.key);
    },
  };
}

export type Review = ReturnType<typeof createReview>;
