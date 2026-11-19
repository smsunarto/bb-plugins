/**
 * Pull request links Source Control does not draw: an agent's Markdown, a
 * GenUI block, another plugin's pill. bb has no SDK hook for a link click
 * there, so a content script takes the click instead (a DOM hack, see
 * AGENTS.md): one capture listener on the document, which on a plain click
 * of a link to a pull request itself stops bb's own handler and opens the
 * pull request's review beside the thread in view.
 *
 * A content script has no side panel, so each thread lends it one:
 * `usePullRequestLinks`, the `useVisible` of a context segment that never
 * shows, runs once per thread pane in bb's context row (with or without a
 * composer plugin) and registers the opener of the thread the route shows.
 * With no thread in view (a plugin page, the New thread screen) no opener is
 * lent and the link goes to GitHub as before. Source Control's own roots are
 * left alone: their links route themselves, and their explicit "Open on
 * GitHub" actions must reach GitHub.
 */
import { useBbContext, type ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect } from "react";
import { parsePrLink } from "../core/watch.ts";
import { isPlainClick, useOpenPullRequest } from "./open-pull-request.tsx";

/** The opener of the thread in view, lent by that thread's pane. */
let lent: ((href: string) => boolean) | null = null;

/**
 * A context segment's `useVisible`: lends this thread's opener while the
 * route shows the thread, and never shows the segment.
 */
export function usePullRequestLinks({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const open = useOpenPullRequest(threadId);
  const inView = useBbContext().threadId === threadId;
  useLayoutEffect(() => {
    if (!inView) return;
    lent = open;
    return () => {
      if (lent === open) lent = null;
    };
  }, [inView, open]);
  return false;
}

const OURS = '[data-bb-plugin="source-control"]';

/** Takes plain clicks on pull request links until `signal` aborts. Returns the disposer. */
export function mountPullRequestLinks(document: Document, signal: AbortSignal): () => void {
  const view = document.defaultView;
  if (!view || signal.aborted) return () => {};
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!lent || !isPlainClick(event) || !(target instanceof view.Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof view.HTMLAnchorElement) || anchor.closest(OURS)) return;
    if (!parsePrLink(anchor.href) || !lent(anchor.href)) return;
    // bb's Markdown link opens the URL without checking defaultPrevented: stop it reaching React.
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("click", onClick, { capture: true, signal });
  return () => document.removeEventListener("click", onClick, { capture: true });
}
