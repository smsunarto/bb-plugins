/**
 * Pull request links Source Control does not draw: an agent's Markdown, a
 * GenUI block, another plugin's pill. bb has no SDK hook for a link click
 * there, so a content script takes the click instead (a DOM hack, see
 * AGENTS.md): one capture listener on the document, which on a plain click
 * of a link to a pull request itself stops bb's own handler and opens the
 * pull request's review beside the thread in view.
 *
 * A content script has no side panel, so each thread composer lends it one:
 * `useLendPullRequestLinks` registers the opener of the thread the route
 * shows. With no thread in view (a plugin page, the New thread screen) no
 * opener is lent and the link goes to GitHub as before. Source Control's own
 * roots are left alone: their links route themselves, and their explicit
 * "Open on GitHub" actions must reach GitHub.
 */
import { useBbContext } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect } from "react";
import { parsePrLink } from "../core/watch.ts";
import { isPlainClick, useOpenPullRequest } from "./open-pull-request.ts";

type Opener = (href: string) => boolean;

/** The opener of the thread in view, lent by its composer. */
let lent: { threadId: string; open: Opener } | null = null;

/**
 * Lends this thread's opener while the route shows it. Called from a
 * component mounted once per thread composer.
 */
export function useLendPullRequestLinks(threadId: string): void {
  const open = useOpenPullRequest(threadId);
  const inView = useBbContext().threadId === threadId;
  useLayoutEffect(() => {
    if (!inView) return;
    const loan = { threadId, open };
    lent = loan;
    return () => {
      if (lent === loan) lent = null;
    };
  }, [inView, threadId, open]);
}

const OURS = '[data-bb-plugin="source-control"]';

/** Takes plain clicks on pull request links until `signal` aborts. Returns the disposer. */
export function mountPullRequestLinks(document: Document, signal: AbortSignal): () => void {
  const view = document.defaultView;
  if (!view || signal.aborted) return () => {};
  function onClick(event: MouseEvent): void {
    if (!lent || !isPlainClick(event) || !(event.target instanceof view!.Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof view!.HTMLAnchorElement) || anchor.closest(OURS)) return;
    if (!parsePrLink(anchor.href)) return;
    // bb's Markdown link opens the URL without checking defaultPrevented: stop it reaching React.
    event.preventDefault();
    event.stopPropagation();
    lent.open(anchor.href);
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  document.addEventListener("click", onClick, { capture: true, signal: controller.signal });
  return () => {
    signal.removeEventListener("abort", stop);
    controller.abort();
  };
}

/** Tests only: whether a thread has lent its opener, and which. */
export function lentThread(): string | null {
  return lent?.threadId ?? null;
}
