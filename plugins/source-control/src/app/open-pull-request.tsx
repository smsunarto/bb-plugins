/**
 * Opening a GitHub pull request link as its Change's Review tab.
 *
 * A plain click on a link to a pull request itself opens the Change that
 * pull request's head branch is, beside the thread. Every decision is made
 * inside the click, so no click is lost to a popup blocker:
 *
 * - a pull request this window has opened before opens its Review at once;
 * - one Source Control recently could not show goes to GitHub at once;
 * - any other opens a Review tab for the pull request itself, which shows
 *   that it is looking, then gives way to the Change's own tab, or says why
 *   it cannot and offers GitHub (`PullRequestTab`);
 * - with no side panel to open it in, the link goes to GitHub.
 *
 * A modified or middle click, a deep link (a comment, a file), and an
 * explicit "Open on GitHub" still go to github.com.
 *
 * Lookups are shared: a pull request read once, or being read, is not read
 * again. The server keeps each pull request's Change too (`legacyChange`).
 */
import {
  experimental_useAppPanel as useAppPanel,
  UrlLink,
  type PluginRpcClient,
  type UrlLinkProps,
} from "@get-bb/plugin-sdk/app";
import { isPlainClick } from "@bb-plugins/review-request";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { parsePrLink, parsePrReference, prKey, prLookup, type PrRef } from "../core/watch.ts";
import type { sourceControlContract } from "../contract/rpc.ts";
import { REVIEW_TAB, useOpenReview } from "./open-review.ts";

/** How long a Review tab looks for a pull request's Change before it offers GitHub. */
export const RESOLVE_MS = 8_000;
/** How long a pull request Source Control could not show goes straight to GitHub. */
export const MISS_MS = 60_000;

// ── What this window knows about each pull request ─────────────────────

/** A pull request's Change, or why Source Control cannot show it. */
export type Resolution = { key: ChangeKey } | { problem: string };

type Rpc = PluginRpcClient<typeof sourceControlContract>;

const found = new Map<string, ChangeKey>();
const missed = new Map<string, { problem: string; until: number }>();
const reading = new Map<string, Promise<Resolution>>();

/** What a click can act on now: the Change, a recent miss, or nothing known yet. */
export function knownPullRequest(lookup: string, now = Date.now()): Resolution | null {
  const key = found.get(lookup);
  if (key) return { key };
  const miss = missed.get(lookup);
  if (miss && miss.until > now) return { problem: miss.problem };
  return null;
}

/** The Review tab confirmed the Change shows this pull request: open it directly from now on. */
export function rememberChange(lookup: string, key: ChangeKey): void {
  missed.delete(lookup);
  found.set(lookup, key);
}

/** Source Control cannot show this pull request: send its links to GitHub for a while. */
export function rememberMiss(lookup: string, problem: string, now = Date.now()): void {
  found.delete(lookup);
  missed.set(lookup, { problem, until: now + MISS_MS });
}

/**
 * The pull request's Change as the server reads it, one read per pull
 * request however many tabs or clicks ask. A failed call is a miss.
 */
export function resolvePullRequest(
  rpc: Rpc,
  lookup: string,
  threadId: string,
): Promise<Resolution> {
  const pending = reading.get(lookup);
  if (pending) return pending;
  const read = rpc
    .call("legacyChange", { keys: [lookup], threadId })
    .then((answer): Resolution => {
      const one = answer[lookup];
      return one?.key
        ? { key: one.key }
        : { problem: one?.problem ?? "Source Control cannot find it." };
    })
    .catch((error: unknown): Resolution => ({
      problem: error instanceof Error ? error.message : "Source Control could not ask GitHub.",
    }))
    .finally(() => reading.delete(lookup));
  reading.set(lookup, read);
  return read;
}

/** Tests only: forget what this window has read. */
export function resetKnownPullRequests(): void {
  found.clear();
  missed.clear();
  reading.clear();
}

// ── The Review tab for a pull request not yet resolved ─────────────────

/** The params of a Review tab opened for a pull request: one tab per pull request. */
export function pullRequestTabParams(params: unknown): { ref: PrRef } | null {
  if (typeof params !== "object" || params === null || !("pr" in params)) return null;
  const ref = typeof params.pr === "string" ? parsePrReference(params.pr) : null;
  return ref ? { ref } : null;
}

// ── Opening ────────────────────────────────────────────────────────────

/**
 * Opens `href` as its Change's Review beside `threadId`. Returns whether it
 * took the link: false for anything that is not a link to a pull request
 * itself, for one Source Control recently could not show, and where there
 * is no side panel, so the caller lets the link go to GitHub. Never waits.
 * One stable function.
 */
export function useOpenPullRequest(threadId: string): (href: string) => boolean {
  const openReview = useOpenReview(threadId);
  const panel = useAppPanel();
  const latest = useRef(panel);
  useLayoutEffect(() => {
    latest.current = panel;
  });
  return useMemo(
    () => (href: string) => {
      const ref = parsePrLink(href);
      if (!ref) return false;
      const known = knownPullRequest(prLookup(ref));
      if (known && "problem" in known) return false;
      if (known) {
        openReview({ key: known.key });
        return true;
      }
      return latest.current.openTab({
        tab: REVIEW_TAB,
        params: { pr: prKey(ref).toLowerCase() },
        title: `Review · #${ref.number}`,
      });
    },
    [openReview],
  );
}

/**
 * A link to a pull request that a plain click opens as its review beside
 * `threadId`; any other click, or a pull request Review cannot take, is the
 * link's own. Render it only where there is a pull request.
 */
export function PullRequestLink({
  threadId,
  href,
  onClick,
  ...anchor
}: UrlLinkProps & { threadId: string }) {
  const open = useOpenPullRequest(threadId);
  return (
    <UrlLink
      {...anchor}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (isPlainClick(event) && open(href)) event.preventDefault();
      }}
    />
  );
}
