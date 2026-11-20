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
  isPlainClick,
  takePullRequestReviews,
  type PullRequestReviewRequest,
} from "@bb-plugins/review-request";
import { useBbContext, type ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect } from "react";
import { parsePrLink, prLookup } from "../core/watch.ts";
import { knownPullRequest, useOpenPullRequest } from "./open-pull-request.tsx";

/** How long an ask waits for its thread to come into view before the caller opens GitHub. */
export const PENDING_MS = 10_000;

type Opener = { readonly threadId: string; readonly open: (href: string) => boolean };

/** The opener of the thread in view, lent by that thread's pane. */
let lent: Opener | null = null;

/**
 * Asks taken for threads not yet in view, by thread: the caller is opening
 * the thread. Each ends once: its thread's pane opens the Review, or the
 * caller's fallback opens GitHub.
 */
type Waiting = {
  readonly url: string;
  readonly fallback: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
};
const waiting = new Map<string, Waiting>();

/** Ends `threadId`'s waiting ask: opens it with `open`, or else falls back to GitHub. */
function settle(threadId: string, open: ((href: string) => boolean) | null): void {
  const ask = waiting.get(threadId);
  if (!ask) return;
  waiting.delete(threadId);
  clearTimeout(ask.timer);
  if (!open?.(ask.url)) ask.fallback();
}

/** Drops `threadId`'s waiting ask without opening anything: the reader went elsewhere. */
function abandon(threadId: string): void {
  const ask = waiting.get(threadId);
  if (!ask) return;
  waiting.delete(threadId);
  clearTimeout(ask.timer);
}

/**
 * The Change strip lends this thread's opener while the route shows the
 * thread. It opens the ask waiting for this thread, falling back to GitHub
 * when the tab is declined, and drops asks for other threads: the reader
 * went somewhere else.
 */
export function usePullRequestLinks({ threadId }: ExperimentalThreadContextSegmentInput): void {
  const open = useOpenPullRequest(threadId);
  const inView = useBbContext().threadId === threadId;
  useLayoutEffect(() => {
    if (!inView) return;
    const mine: Opener = { threadId, open };
    lent = mine;
    settle(threadId, open);
    for (const other of waiting.keys()) if (other !== threadId) abandon(other);
    return () => {
      if (lent === mine) lent = null;
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
  if (lent?.threadId === threadId) return lent.open(url);
  if (!navigating || !fallback) return false;
  const known = knownPullRequest(prLookup(ref));
  if (known && "problem" in known) return false;
  abandon(threadId);
  const timer = setTimeout(() => settle(threadId, null), PENDING_MS);
  waiting.set(threadId, { url, fallback, timer });
  return true;
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
    // Stopped mid-ask: each caller still opens GitHub.
    for (const threadId of waiting.keys()) settle(threadId, null);
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
  takePullRequestReviews(takeReviewRequest, stop.signal, view);
  return () => {
    signal.removeEventListener("abort", stopAll);
    stopAll();
  };
}
