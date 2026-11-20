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
 * A taken ask always ends in the Review or, through the caller's fallback,
 * on GitHub.
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
  answerPullRequestReviewAvailability,
  isPlainClick,
  takePullRequestReviews,
  type PullRequestReviewRequest,
} from "@bb-plugins/review-request";
import { useBbContext, type ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect } from "react";
import { parsePrLink, prLookup } from "../core/watch.ts";
import {
  knownPullRequest,
  onKnownPullRequestsChange,
  useOpenPullRequest,
} from "./open-pull-request.tsx";
import type { OpenReviewOptions } from "./open-review.ts";

/** How long an ask waits for its thread to come into view before the caller opens GitHub. */
export const PENDING_MS = 10_000;

type Open = (href: string, options?: OpenReviewOptions) => boolean;
type Opener = { readonly threadId: string; readonly open: Open };

/** The opener of the thread in view, lent by that thread's pane. */
let lent: Opener | null = null;
/** Tells callers whether Review can open beside a thread may have changed; set while the script runs. */
let availabilityChanged: (() => void) | null = null;

function lend(opener: Opener | null): void {
  lent = opener;
  availabilityChanged?.();
}

/**
 * The latest ask taken for a thread not yet in view: the caller is opening
 * the thread. A newer ask replaces it, since the reader asked for something
 * else since. It ends once: its thread's pane opens the Review, or the
 * caller's fallback offers GitHub.
 */
let waiting: {
  readonly threadId: string;
  readonly url: string;
  readonly fallback: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
} | null = null;

/** Ends the waiting ask: opens it with `open`, or else falls back. */
function settle(open: Open | null): void {
  const ask = waiting;
  if (!ask) return;
  waiting = null;
  clearTimeout(ask.timer);
  // Inside a pane, never the review page: the caller's fallback offers GitHub instead.
  if (!open?.(ask.url, { page: false })) ask.fallback();
}

/** Forgets the waiting ask without opening anything: a newer ask replaced it. */
function supersede(): void {
  if (waiting) clearTimeout(waiting.timer);
  waiting = null;
}

/**
 * The Change strip lends this thread's opener while the route shows the
 * thread, and opens the ask waiting for this thread, falling back when the
 * tab is declined. A pane for another thread leaves the waiting ask alone:
 * it may be the route before the caller's navigation lands.
 */
export function usePullRequestLinks({ threadId }: ExperimentalThreadContextSegmentInput): void {
  const open = useOpenPullRequest(threadId);
  const inView = useBbContext().threadId === threadId;
  useLayoutEffect(() => {
    if (!inView) return;
    const mine: Opener = { threadId, open };
    lend(mine);
    if (waiting?.threadId === threadId) settle(open);
    return () => {
      if (lent === mine) lend(null);
    };
  }, [inView, threadId, open]);
}

/**
 * Answers another plugin's ask inside its dispatch: true when the Review
 * opens now, or when the caller is opening the thread and gave a fallback
 * for a Review that cannot open after all. False, so the caller opens
 * GitHub, for anything that is not a link to a pull request itself, one
 * Source Control recently could not show, a declined tab, and an ask for a
 * thread that is not in view and that the caller will not open.
 */
export function takeReviewRequest({
  url,
  threadId,
  navigating,
  fallback,
}: PullRequestReviewRequest): boolean {
  const ref = parsePrLink(url);
  if (!ref) return false;
  // Whatever this ask ends in, the reader asked for something else than the waiting ask since.
  supersede();
  if (lent?.threadId === threadId) return lent.open(url, { page: false });
  if (!navigating || !fallback) return false;
  const known = knownPullRequest(prLookup(ref));
  if (known && "problem" in known) return false;
  const timer = setTimeout(() => settle(null), PENDING_MS);
  waiting = { threadId, url, fallback, timer };
  return true;
}

/**
 * Whether Review opens beside `threadId` now, for `url` when named: the
 * thread is in view, and the link is to a pull request Source Control has
 * not just failed to show.
 */
function reviewAvailable(threadId: string, url: string | null): boolean {
  if (lent?.threadId !== threadId) return false;
  if (url === null) return true;
  const ref = parsePrLink(url);
  if (!ref) return false;
  const known = knownPullRequest(prLookup(ref));
  return !(known && "problem" in known);
}

const OURS = '[data-bb-plugin="source-control"]';
const ASKS_ITSELF = `[${REVIEW_REQUEST_ATTRIBUTE}]`;

/** Takes plain clicks on pull request links and other plugins' asks until `signal` aborts. Returns the disposer. */
export function mountPullRequestLinks(document: Document, signal: AbortSignal): () => void {
  const view = document.defaultView;
  if (!view || signal.aborted) return () => {};
  const stop = new AbortController();
  const stopAll = () => {
    const changed = availabilityChanged;
    availabilityChanged = null;
    stop.abort();
    // Stopped mid-ask: the caller still offers GitHub. And Review is no longer available anywhere.
    settle(null);
    changed?.();
  };
  signal.addEventListener("abort", stopAll, { once: true });
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!lent || !isPlainClick(event) || !(target instanceof view.Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof view.HTMLAnchorElement) || anchor.closest(OURS)) return;
    // A link whose owner asks for its own review, naming its thread.
    if (anchor.closest(ASKS_ITSELF)) return;
    if (!parsePrLink(anchor.href)) return;
    // A newer ask: the waiting one ends unopened, wherever this one goes.
    supersede();
    if (!lent.open(anchor.href)) return;
    // bb's Markdown link opens the URL without checking defaultPrevented: stop it reaching React.
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("click", onClick, { capture: true, signal: stop.signal });
  takePullRequestReviews(takeReviewRequest, stop.signal, view);
  availabilityChanged = answerPullRequestReviewAvailability(reviewAvailable, stop.signal, view);
  onKnownPullRequestsChange(() => availabilityChanged?.(), stop.signal);
  return () => {
    signal.removeEventListener("abort", stopAll);
    stopAll();
  };
}
