/**
 * Opening a Change's review in the thread's side panel.
 *
 * The Review tab is an action tab whose `params` name only the Change, so
 * bb keeps one tab per Change and focuses it when it is already open. Where
 * inside the review it shows (tab, commit, file, line) lives here instead,
 * per Change: every open request bumps `visit`, so asking again for the same
 * file lands on it again even after the reader has scrolled away. A surface
 * with no side panel, such as a phone or the review page itself, declines
 * `openTab`; the review page opens instead, so no click is dead.
 */
import { experimental_useAppPanel as useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { changeKeySchema, type ChangeKey } from "../core/ids.ts";
import { parseChangeKey, reviewPath, type ReviewLocation } from "../core/review.ts";
import { PANEL_PATH } from "./page/hooks.ts";

export type ReviewTarget = Partial<ReviewLocation> & { key: ChangeKey };
export type Here = ReviewLocation & { key: ChangeKey };
/** Where a Review tab shows, and how many times it was asked to show it. */
export type TabPlace = { location: Here; visit: number };

/** The Review tab, as `openTab` names it. */
export const REVIEW_TAB = {
  id: "review",
  context: { kind: "thread" },
  availability: "action",
} as const;

/** The tab's identity: one tab per Change. */
export type ReviewTabParams = { key: ChangeKey };

export function reviewTabParams(params: unknown): ReviewTabParams | null {
  if (typeof params !== "object" || params === null || !("key" in params)) return null;
  const key = changeKeySchema.safeParse(params.key);
  return key.success ? { key: key.data } : null;
}

/** The tab strip's label: the branch, the one name every key carries. */
export function reviewTabTitle(key: ChangeKey): string {
  const parsed = parseChangeKey(key);
  return parsed ? `Review · ${parsed.branch}` : "Review";
}

export function here(target: ReviewTarget): Here {
  return {
    key: target.key,
    tab: target.tab ?? "overview",
    commit: target.commit ?? null,
    path: target.path ?? null,
    line: target.line ?? null,
  };
}

// ── Where each Change's tab is ─────────────────────────────────────────

const places = new Map<ChangeKey, TabPlace>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An entry point asks for this place: the tab lands on it, again if it is already there. */
export function requestPlace(target: ReviewTarget): void {
  const visit = (places.get(target.key)?.visit ?? 0) + 1;
  places.set(target.key, { location: here(target), visit });
  notify();
}

/** The reader moved inside the tab: keep the place so a remount comes back to it. */
export function movePlace(target: ReviewTarget): void {
  const visit = places.get(target.key)?.visit ?? 0;
  places.set(target.key, { location: here(target), visit });
  notify();
}

export function useTabPlace(key: ChangeKey): TabPlace {
  const fallback = useMemo<TabPlace>(() => ({ location: here({ key }), visit: 0 }), [key]);
  return useSyncExternalStore(
    subscribe,
    () => places.get(key) ?? fallback,
    () => fallback,
  );
}

/** Tests only: forget every tab's place. */
export function resetPlaces(): void {
  places.clear();
  notify();
}

// ── Opening ────────────────────────────────────────────────────────────

/**
 * Opens a Change's review beside the thread, at the place named. Falls back
 * to the review page where this surface has no side panel. One stable function.
 */
export function useOpenReview(): (target: ReviewTarget) => void {
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const latest = useRef({ panel, navigate });
  useLayoutEffect(() => {
    latest.current = { panel, navigate };
  });
  return useMemo(
    () => (target: ReviewTarget) => {
      requestPlace(target);
      const opened = latest.current.panel.openTab({
        tab: REVIEW_TAB,
        params: { key: target.key },
        title: reviewTabTitle(target.key),
      });
      if (!opened)
        latest.current.navigate.toPluginPanel(PANEL_PATH, { subPath: reviewPath(target) });
    },
    [],
  );
}
