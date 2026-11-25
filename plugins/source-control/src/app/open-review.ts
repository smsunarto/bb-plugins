/**
 * Opening a Change's review in the thread's side panel.
 *
 * The Review tab is an action tab whose `params` name only the Change, so
 * bb keeps one tab per Change and focuses it when it is already open. The
 * SDK cannot change an open tab's params, so where inside the review the tab
 * shows (tab, commit, file, line) is kept here, per thread and Change, and in
 * sessionStorage so a reload comes back to it. A surface with no thread side
 * panel, such as the review page itself, declines `openTab`; the review page
 * opens instead, so no click is dead. (On a phone bb opens the tab in its
 * full-screen panel.)
 */
import { experimental_useAppPanel as useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { changeKeySchema, type ChangeKey } from "../core/ids.ts";
import {
  parseChangeKey,
  REVIEW_TABS,
  reviewPath,
  type ReviewLocation,
  type ReviewTab,
} from "../core/review.ts";
import { prKey, type PrRef } from "../core/watch.ts";
import { retirePendingReview } from "./pending-review-request.ts";
import { PANEL_PATH } from "./page/hooks.ts";

export type ReviewTarget = Partial<ReviewLocation> & { key: ChangeKey };
type ReviewOpenTarget = ReviewTarget | { pr: PrRef };
type Here = ReviewLocation & { key: ChangeKey };

export const REVIEW_TAB = {
  id: "review",
  context: { kind: "thread" },
  availability: "action",
} as const;

/** The tab's params: the Change it shows, and nothing else, so bb keeps one tab per Change. */
export function reviewTabParams(params: unknown): { key: ChangeKey } | null {
  if (typeof params !== "object" || params === null || !("key" in params)) return null;
  const key = changeKeySchema.safeParse(params.key);
  return key.success ? { key: key.data } : null;
}

/** The unresolved tab is identified by the pull request, regardless of URL casing. */
export function prTabParams(ref: PrRef): { pr: string } {
  return { pr: prKey(ref).toLowerCase() };
}

/** The tab strip's label: the branch, the one name every key carries. */
function reviewTabTitle(key: ChangeKey): string {
  const parsed = parseChangeKey(key);
  return parsed ? `Review · ${parsed.branch}` : "Review";
}

function here(target: ReviewTarget): Here {
  return {
    key: target.key,
    tab: target.tab ?? "overview",
    commit: target.commit ?? null,
    path: target.path ?? null,
    line: target.line ?? null,
  };
}

const same = (a: Here, b: Here) =>
  a.key === b.key &&
  a.tab === b.tab &&
  a.commit === b.commit &&
  a.path === b.path &&
  a.line === b.line;

// ── Where each thread's tab for a Change is ────────────────────────────

const STORAGE_PREFIX = "source-control:review-place:";

/**
 * Where a tab shows, and `request`, which every entry point's ask bumps,
 * even for the place already shown, so the views reveal it again. Moving
 * inside the tab leaves it alone.
 */
export type TabPlace = { location: Here; request: number };

const places = new Map<string, TabPlace>();
const listeners = new Set<() => void>();

const slot = (threadId: string, key: ChangeKey) => `${threadId}\n${key}`;

const nullable = (value: unknown) => (typeof value === "string" ? value : null);

/** The place this session last kept for the slot, if it still reads as one. */
function stored(id: string, key: ChangeKey): Here | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + id) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const value = raw as Record<string, unknown>;
    const tab = (REVIEW_TABS as readonly unknown[]).includes(value.tab)
      ? (value.tab as ReviewTab)
      : "overview";
    const line = typeof value.line === "number" && value.line > 0 ? value.line : null;
    return { key, tab, commit: nullable(value.commit), path: nullable(value.path), line };
  } catch {
    return null;
  }
}

function placeOf(id: string, key: ChangeKey): TabPlace {
  let place = places.get(id);
  if (!place) {
    place = { location: stored(id, key) ?? here({ key }), request: 0 };
    places.set(id, place);
  }
  return place;
}

function put(id: string, place: TabPlace, moved: boolean) {
  places.set(id, place);
  if (moved)
    try {
      const { tab, commit, path, line } = place.location;
      sessionStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ tab, commit, path, line }));
    } catch {
      // Storage full or blocked: the place still holds until the next reload.
    }
  for (const listener of listeners) listener();
}

/**
 * The reader moved inside the thread's Review tab for `target.key`. Moving to
 * the place it already shows changes nothing.
 */
export function setPlace(threadId: string, target: ReviewTarget): void {
  const id = slot(threadId, target.key);
  const current = placeOf(id, target.key);
  const next = here(target);
  if (same(current.location, next)) return;
  put(id, { location: next, request: current.request }, true);
}

/**
 * An entry point asks the thread's Review tab for `target`: it moves there,
 * and reveals it again when it is already there. The location keeps its
 * identity when unchanged, so only the reveal runs, nothing is rebuilt.
 * Returns the undo, for an ask whose tab did not open: the tab keeps the
 * place the reader last left it at.
 */
export function requestPlace(threadId: string, target: ReviewTarget): () => void {
  const id = slot(threadId, target.key);
  const current = placeOf(id, target.key);
  const next = here(target);
  const moved = !same(current.location, next);
  put(id, { location: moved ? next : current.location, request: current.request + 1 }, moved);
  return () => put(id, current, moved);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTabPlace(threadId: string, key: ChangeKey): TabPlace {
  const id = slot(threadId, key);
  return useSyncExternalStore(subscribe, () => placeOf(id, key));
}

/** Tests only: forget every place, or with `reload`, only what a reload forgets. */
export function resetPlaces({ reload = false } = {}): void {
  places.clear();
  if (!reload) sessionStorage.clear();
}

// ── Opening ────────────────────────────────────────────────────────────

/** How the Review tab opens for this intent. */
export type OpenReviewOptions = {
  /** Open the review page instead (the default). False: open nothing and return false. */
  readonly page?: boolean;
  /** Promoting a PR tab continues an earlier click, leaving any newer requests pending. */
  readonly continuation?: boolean;
};

/**
 * Opens a Change's review beside `threadId`, at the place named. Falls back
 * to the review page where the surface has no side panel, unless `page` is
 * false. Returns whether it opened anything. One stable function.
 */
export function useOpenReview(
  threadId: string,
): (target: ReviewOpenTarget, options?: OpenReviewOptions) => boolean {
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const latest = useRef({ panel, navigate, threadId });
  useLayoutEffect(() => {
    latest.current = { panel, navigate, threadId };
  });
  return useMemo(
    () =>
      (target: ReviewOpenTarget, { page = true, continuation = false }: OpenReviewOptions = {}) => {
        const { panel, navigate, threadId } = latest.current;
        if ("pr" in target) {
          const opened = panel.openTab({
            tab: REVIEW_TAB,
            params: prTabParams(target.pr),
            title: `#${target.pr.number} · Review`,
          });
          if (opened) retirePendingReview();
          return opened;
        }
        const undo = requestPlace(threadId, target);
        const opened = panel.openTab({
          tab: REVIEW_TAB,
          params: { key: target.key },
          title: reviewTabTitle(target.key),
        });
        if (opened) {
          if (!continuation) retirePendingReview();
          return true;
        }
        if (!page) {
          undo();
          return false;
        }
        navigate.toPluginPanel(PANEL_PATH, { subPath: reviewPath(target) });
        if (!continuation) retirePendingReview();
        return true;
      },
    [],
  );
}
