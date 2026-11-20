// Whether a link to a pull request in this block opens in Review: Source
// Control is running, this block's thread is in view, and Source Control has
// not just failed to show that pull request. Hints say Review only then;
// otherwise, as when the thread is archived or Source Control is off, they
// name the link, which is where a press goes. Only a control holding a link
// to a pull request asks or listens.
import {
  isPullRequestReviewAvailable,
  onPullRequestReviewAvailabilityChange,
  pullRequestUrlKey,
} from "@bb-plugins/review-request";
import { useMemo, useSyncExternalStore } from "react";
import type { Action } from "../core/types";
import { openableLink } from "./components/action-logic";
import { useUiRuntime } from "./runtime";

/** Source Control's answer per thread and link, until it reports a change. */
const answers = new Map<string, boolean>();
const listeners = new Set<() => void>();
let listening: AbortController | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listening === null) {
    listening = new AbortController();
    // Answers read before anyone listened may be stale.
    answers.clear();
    onPullRequestReviewAvailabilityChange(() => {
      answers.clear();
      for (const each of listeners) each();
    }, listening.signal);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    listening?.abort();
    listening = null;
  };
}

const noSubscription = () => () => {};
const NONE = (_url: string) => false;

function available(threadId: string, url: string): boolean {
  const slot = `${threadId}\n${url}`;
  let answer = answers.get(slot);
  if (answer === undefined) {
    answer = isPullRequestReviewAvailable(threadId, url);
    answers.set(slot, answer);
  }
  return answer;
}

/** The addresses `actions` open, for `useReviewLinks`. */
export function linkUrls(actions: readonly Action[]): string[] {
  return actions.flatMap((action) => (action.type === "openUrl" ? [action.url] : []));
}

/**
 * Which of `urls`, this control's links, open in Review now: a test by link.
 * A control with no link to a pull request neither asks nor listens.
 */
export function useReviewLinks(
  urls: readonly (string | null | undefined)[],
): (url: string) => boolean {
  const { threadId } = useUiRuntime();
  // Read as actionIntent reads each link: its parsed address.
  const pullRequests =
    threadId === null
      ? []
      : urls.flatMap((url) => {
          const href = typeof url === "string" ? openableLink(url)?.href : undefined;
          return href !== undefined && pullRequestUrlKey(href) !== null ? [href] : [];
        });
  const asks = threadId !== null && pullRequests.length > 0;
  // The pull requests that open in Review, as one string so an unchanged answer keeps its identity.
  const opening = useSyncExternalStore(asks ? subscribe : noSubscription, () =>
    asks
      ? pullRequests
          .filter((url) => available(threadId, url))
          .map(pullRequestUrlKey)
          .join("\n")
      : "",
  );
  return useMemo(() => {
    if (opening === "") return NONE;
    const keys = new Set(opening.split("\n"));
    return (url: string) => {
      const key = pullRequestUrlKey(url);
      return key !== null && keys.has(key);
    };
  }, [opening]);
}
