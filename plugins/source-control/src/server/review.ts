/**
 * The review page's reads, by what each part knows: the Changes nav's
 * sources (review-sources), the selected Change's header and rail
 * (review-change), and its files, patches and commits at one revision
 * (review-revision). Everything is keyed by ChangeKey, so a pull request
 * with no checkout anywhere opens the same way as one with three; nothing is
 * read once the page is hidden.
 */
import { changeTag, hostTag, type ChangeKey } from "../core/ids.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { HostCalls } from "./host-calls.ts";
import type { LocalReads } from "./local-read.ts";
import { createReviewChange } from "./review-change.ts";
import { createRevisionReads } from "./review-revision.ts";
import { checkoutsOn, createReviewSources, rowsOf } from "./review-sources.ts";
import type { Share } from "./shared.ts";
import type { Store } from "./store.ts";

export function createReview(deps: {
  store: Store;
  sites: ForgeSites;
  local: LocalReads;
  host: HostCalls;
  share: Share;
  invalidate: (tags: readonly string[]) => void;
  /** A Change's pull request was read: the threads showing it read again. */
  forgeChanged: (key: ChangeKey) => void;
  now: () => number;
  deadlineMs: number;
}) {
  const sources = createReviewSources(deps);
  const change = createReviewChange({ ...deps, inboxRow: sources.inboxRow });
  const revision = createRevisionReads(deps);
  return {
    pageSources: sources.pageSources,
    inbox: sources.inbox,
    watchInbox: sources.watchInbox,
    hostChanges: sources.hostChanges,
    watchHost: sources.watchHost,
    detail: change.detail,
    watchChange: change.watchChange,
    setDraft: change.setDraft,
    files: revision.files,
    patches: revision.patches,
    commits: revision.commits,
    /** A checkout was read and changed: its host's list and its Changes' headers read again. */
    checkoutRead(hostId: string, path: string) {
      const placement = checkoutsOn(deps.store, hostId).find((each) => each.path === path);
      const keys = placement ? rowsOf(deps.store, placement).map((row) => changeTag(row.key)) : [];
      deps.invalidate([hostTag(hostId), ...keys]);
    },
  };
}

export type Review = ReturnType<typeof createReview>;
