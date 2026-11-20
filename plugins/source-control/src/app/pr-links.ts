/**
 * Pull request links Source Control does not draw: an agent's Markdown, a
 * GenUI block, another plugin's pill. bb has no SDK hook for a link click
 * there, so a content script takes the click instead (a DOM hack, see
 * AGENTS.md): one capture listener on the document, which on a plain click
 * of a link to a pull request itself stops bb's own handler and opens the
 * pull request's review beside the thread in view.
 *
 * The same content script answers other plugins' asks to open a pull
 * request's review (`@bb-plugins/review-request`): GenUI's link buttons and
 * Tasks' PR pill, which are not plain links or must name their own thread.
 *
 * A content script has no side panel, so each thread lends it one:
 * `usePullRequestLinks`, called by the existing Change strip's `useVisible`,
 * runs once per thread pane in bb's context row (with or without a
 * composer plugin) and registers the opener of the thread the route shows.
 * With no thread in view (a plugin page, the New thread screen) no opener is
 * lent and the link goes to GitHub as before. Source Control's own roots are
 * left alone: their links route themselves, and their explicit "Open on
 * GitHub" actions must reach GitHub.
 */
import {
  REVIEW_REQUEST_ATTRIBUTE,
  takePullRequestReviews,
  type PullRequestReviewRequest,
} from "@bb-plugins/review-request";
import { useBbContext, type ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect } from "react";
import { parsePrLink, prLookup } from "../core/watch.ts";
import { isPlainClick, knownPullRequest, useOpenPullRequest } from "./open-pull-request.tsx";

/** How long an ask waits for its thread to come into view (Tasks opens the thread after asking). */
export const PENDING_MS = 10_000;

type Opener = { readonly threadId: string; readonly open: (href: string) => boolean };

/** The opener of the thread in view, lent by that thread's pane. */
let lent: Opener | null = null;
/** An ask taken for a thread not yet in view: the thread's pane opens it when it lends. */
let pending: { readonly url: string; readonly threadId: string; readonly until: number } | null =
  null;

/**
 * The Change strip lends this thread's opener while the route shows the
 * thread, and opens an ask that was waiting for it.
 */
export function usePullRequestLinks({ threadId }: ExperimentalThreadContextSegmentInput): void {
  const open = useOpenPullRequest(threadId);
  const inView = useBbContext().threadId === threadId;
  useLayoutEffect(() => {
    if (!inView) return;
    const mine: Opener = { threadId, open };
    lent = mine;
    const waiting = pending?.threadId === threadId ? pending : null;
    if (waiting) {
      pending = null;
      if (waiting.until > Date.now()) open(waiting.url);
    }
    return () => {
      if (lent === mine) lent = null;
    };
  }, [inView, threadId, open]);
}

/**
 * Answers another plugin's ask inside its dispatch: true when the review
 * opens, or will once the named thread comes into view. False for anything
 * that is not a link to a pull request itself, one Source Control recently
 * could not show, and an ask for a thread that is not in view and that the
 * caller will not open, so the caller opens GitHub.
 */
export function takeReviewRequest(
  { url, threadId, navigating }: PullRequestReviewRequest,
  now = Date.now(),
): boolean {
  const ref = parsePrLink(url);
  if (!ref) return false;
  if (lent?.threadId === threadId) return lent.open(url);
  if (!navigating) return false;
  const known = knownPullRequest(prLookup(ref), now);
  if (known && "problem" in known) return false;
  pending = { url, threadId, until: now + PENDING_MS };
  return true;
}

/** Tests only: forget the lent opener and any waiting ask. */
export function resetPullRequestLinks(): void {
  lent = null;
  pending = null;
}

const OURS = '[data-bb-plugin="source-control"]';
const ASKS_ITSELF = `[${REVIEW_REQUEST_ATTRIBUTE}]`;

/** Takes plain clicks on pull request links and other plugins' asks until `signal` aborts. Returns the disposer. */
export function mountPullRequestLinks(document: Document, signal: AbortSignal): () => void {
  const view = document.defaultView;
  if (!view || signal.aborted) return () => {};
  const stop = new AbortController();
  const stopAll = () => {
    stop.abort();
    pending = null;
  };
  signal.addEventListener("abort", stopAll, { once: true });
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!lent || !isPlainClick(event) || !(target instanceof view.Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof view.HTMLAnchorElement) || anchor.closest(OURS)) return;
    // A link whose owner asks for its own review, naming its thread.
    if (anchor.closest(ASKS_ITSELF)) return;
    if (!parsePrLink(anchor.href) || !lent.open(anchor.href)) return;
    // bb's Markdown link opens the URL without checking defaultPrevented: stop it reaching React.
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("click", onClick, { capture: true, signal: stop.signal });
  takePullRequestReviews((request) => takeReviewRequest(request), stop.signal, view);
  return () => {
    signal.removeEventListener("abort", stopAll);
    stopAll();
  };
}
