/**
 * Opening a GitHub pull request link as its Change's Review tab.
 *
 * A plain click on a link to a pull request itself opens the Change that
 * pull request's head branch is, beside the thread. A modified or middle
 * click, a deep link (a comment, a file), and an explicit "Open on GitHub"
 * still go to github.com, and so does a pull request Source Control cannot
 * read (a repository its `gh` has no access to), once the read fails or
 * takes longer than `RESOLVE_MS`.
 *
 * The server keeps each pull request's Change once read (`legacyChange`), and
 * this window keeps the ones it has opened, so a second click opens at once.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { parsePrLink, prLookup } from "../core/watch.ts";
import type { sourceControlContract } from "../contract/rpc.ts";
import { useOpenReview } from "./open-review.ts";

/** How long a first click waits for GitHub before it opens the link there instead. */
export const RESOLVE_MS = 5_000;

type Click = Pick<
  MouseEvent,
  "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented"
>;

/** A primary click with no modifier: the one a link may take over. */
export function isPlainClick(event: Click): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Each pull request's Change, as this window has read it. */
const known = new Map<string, ChangeKey>();

/** Tests only: forget what this window has read. */
export function resetKnownPullRequests(): void {
  known.clear();
}

/**
 * Opens `href` as its Change's Review tab beside `threadId`, or on GitHub when Source Control
 * cannot. False, without doing anything, when `href` is not a link to a pull
 * request itself. One stable function.
 */
export function useOpenPullRequest(threadId: string): (href: string) => boolean {
  const rpc = useRpc<typeof sourceControlContract>();
  const openReview = useOpenReview(threadId);
  const navigate = useBbNavigate();
  const latest = useRef({ rpc, navigate });
  useLayoutEffect(() => {
    latest.current = { rpc, navigate };
  });
  return useMemo(() => {
    async function changeOf(lookup: string): Promise<ChangeKey | null> {
      const cached = known.get(lookup);
      if (cached) return cached;
      const timeout = new Promise<null>((resolve) => setTimeout(resolve, RESOLVE_MS, null));
      const read = latest.current.rpc
        .call("legacyChange", { keys: [lookup] })
        .then((found) => found[lookup]?.key ?? null);
      const key = await Promise.race([read, timeout]).catch(() => null);
      if (key) known.set(lookup, key);
      return key;
    }
    async function open(href: string, lookup: string): Promise<void> {
      const key = await changeOf(lookup);
      if (key) openReview({ key });
      else latest.current.navigate.openUrl(href);
    }
    return (href: string) => {
      const ref = parsePrLink(href);
      if (!ref) return false;
      void open(href, prLookup(ref));
      return true;
    };
  }, [openReview]);
}

/** An anchor's `onClick` that opens a pull request link's review on a plain click. */
export function usePullRequestClick(
  threadId: string,
  href: string,
): (event: MouseEvent<HTMLAnchorElement>) => void {
  const open = useOpenPullRequest(threadId);
  return useMemo(
    () => (event: MouseEvent<HTMLAnchorElement>) => {
      if (isPlainClick(event) && open(href)) event.preventDefault();
    },
    [href, open],
  );
}
